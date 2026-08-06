import cron from 'node-cron';
import axios from 'axios';
import pool from '../config/database';
import { regionKeyForCoordinates, regionKeyForRegionName } from '../utils/regions';
import fireClusterJob from './fireClusterJob';

/**
 * Persists raw FIRMS thermal detections into fire_detections.
 *
 * This runs ALONGSIDE /api/thermal, not instead of it. That route stays a
 * pure pass-through proxy for the shipped app; this job exists so that
 * duration, spread and "is it still burning" can be computed later from an
 * actual history instead of a five-minute Redis cache.
 */

// Same box the thermal proxy asks FIRMS for: west,south,east,north.
const FIRMS_AREA = '25,35,45,43';
// Overridable so the ingest path can be exercised against a local fixture
// server without a NASA key. Production leaves it unset and hits FIRMS.
const FIRMS_BASE =
  process.env.FIRMS_BASE_URL ?? 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';

/**
 * Every NRT product is fetched on every run and the results are UNIONED.
 *
 * This used to be a fallback ladder shared with routes/thermal.ts: try SNPP,
 * and only if it returned nothing try MODIS. Since SNPP almost always returns
 * something over Turkey, MODIS was effectively never fetched and the whole
 * system ran on one satellite — roughly two looks a day. That made
 * "not detected for 6 hours" mostly mean "nobody looked for 6 hours", which
 * is the weak link under every satellite_state claim.
 *
 * Fetching all four turns each additional platform into extra observation
 * opportunities. The natural key is (product, acquired_at, latitude,
 * longitude), so the same fire seen by two satellites is stored as two
 * independent observations rather than deduplicated away — which is the point.
 *
 * LANDSAT_NRT is deliberately absent: FIRMS documents it as US/Canada only.
 *
 * Rate limit: FIRMS allows 5,000 transactions per 10 minutes per MAP_KEY.
 * Four products every 30 minutes is ~1.3 requests per 10 minutes, about 0.03%
 * of the allowance, so no backoff or interval change is needed.
 *
 * routes/thermal.ts keeps its own ladder untouched — the shipped app depends
 * on that endpoint's current behaviour.
 */
/**
 * Two days, not one, and the extra day is about not losing rows permanently.
 *
 * FIRMS windows by ACQUISITION date while publishing in near real time, three
 * to six hours behind the overpass. A pixel acquired at 21:00 UTC is therefore
 * published after the following midnight, by which point a one-day window
 * covers only the new day — and that row carries yesterday's acq_date, so it
 * falls outside the window and is never seen again. Measured at 08:30 UTC, the
 * two-day window held 618 rows dated yesterday against 3 dated today.
 *
 * The second failure mode is gaps. This runs on an instance that sleeps when
 * idle, and any gap spanning UTC midnight loses everything recorded before it.
 * A two-day window makes a missed run recoverable instead of fatal.
 *
 * Re-fetching costs nothing in the database: the natural key on
 * (product, acquired_at, latitude, longitude) turns every row already held
 * into an ON CONFLICT DO NOTHING, so the second day is read and discarded
 * rather than duplicated.
 */
const INGEST_DAYS = 2;

const INGEST_PRODUCTS: ReadonlyArray<{ product: string; days: number }> = [
  { product: 'VIIRS_SNPP_NRT', days: INGEST_DAYS },
  { product: 'VIIRS_NOAA20_NRT', days: INGEST_DAYS },
  { product: 'VIIRS_NOAA21_NRT', days: INGEST_DAYS },
  { product: 'MODIS_NRT', days: INGEST_DAYS },
];

/**
 * Turkey's bounding box — identical values to routes/fires.ts, deliberately,
 * so "inside Turkey" means one thing across the codebase.
 */
const TURKEY_BBOX = { minLat: 35.8, maxLat: 42.2, minLng: 25.6, maxLng: 44.8 };

/**
 * Secondary guard on top of the bounding box.
 *
 * turkey_cities holds ONE POINT per province (its centre), not a border
 * polygon, so no distance threshold can trace the actual frontier. Turkey's
 * 81 provinces average ~9,700 km²; even the large eastern ones put an
 * interior point within roughly 150 km of its provincial centre. 250 km is
 * therefore comfortably above anything legitimately Turkish while still
 * discarding far-flung points that slipped through the box.
 *
 * The bias is intentional: keeping a Syrian detection is a cosmetic problem,
 * dropping a real Turkish one is a safety problem. Points in Greek Thrace,
 * Bulgaria, the Aegean islands, Cyprus or the Syrian/Iraqi border strip WILL
 * still be stored — they are inside the box and near a Turkish province
 * centre. nearest_city_km is persisted on every row precisely so a proper
 * border polygon can filter them later without re-ingesting anything.
 */
const MAX_NEAREST_CITY_KM = 250;

/** Raw detections older than this are pruned after each run. */
const RETENTION_DAYS = 90;

interface NormalisedDetection {
  product: string;
  acquiredAt: Date;
  latitude: number;
  longitude: number;
  satellite: string | null;
  instrument: string | null;
  confidenceRaw: string;
  confidenceTier: 'low' | 'nominal' | 'high';
  brightnessK: number | null;
  brightness2K: number | null;
  frpMw: number | null;
  scanKm: number | null;
  trackKm: number | null;
  daynight: string | null;
}

export interface ProductStats {
  product: string;
  fetched: number;
  inserted: number;
  duplicates: number;
  rejected: number;
  error: string | null;
}

export interface IngestStats {
  /** Products that returned at least one row this run. */
  products: string[];
  perProduct: ProductStats[];
  fetched: number;
  malformed: number;
  outsideBbox: number;
  outsideBorder: number;
  outsideCityRadius: number;
  inserted: number;
  duplicates: number;
  pruned: number;
}

/**
 * FIRMS sends acq_time as an UNPADDED HHMM integer in UTC: "3" is 00:03,
 * "45" is 00:45, "1330" is 13:30. Reading it as hours, or as a padded
 * string, shifts every timestamp — and every duration and spread figure
 * computed from it later.
 */
export function parseAcquiredAt(acqDate: string, acqTime: string): Date | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(acqDate.trim());
  if (!dateMatch) return null;

  const raw = Number.parseInt(acqTime.trim(), 10);
  if (!Number.isFinite(raw) || raw < 0 || raw > 2359) return null;

  const hours = Math.floor(raw / 100);
  const minutes = raw % 100;
  if (hours > 23 || minutes > 59) return null;

  return new Date(
    Date.UTC(
      Number(dateMatch[1]),
      Number(dateMatch[2]) - 1,
      Number(dateMatch[3]),
      hours,
      minutes,
      0
    )
  );
}

/**
 * Normalises confidence to a tier using EXACTLY the thresholds the Flutter
 * client applies in FirePoint.riskTier: numeric >=80 high, >=30 medium,
 * else low; letters h/high high, n/nominal medium, else low.
 *
 * The one difference is vocabulary — the client calls the middle tier
 * 'medium', FIRMS calls it 'nominal' and so do we. The boundaries are the
 * same, which is what matters for "high confidence" meaning one thing.
 */
export function confidenceTier(raw: string): 'low' | 'nominal' | 'high' {
  const value = raw.toLowerCase().trim();
  const numeric = Number.parseInt(value, 10);
  if (Number.isFinite(numeric) && /^\d+$/.test(value)) {
    if (numeric >= 80) return 'high';
    if (numeric >= 30) return 'nominal';
    return 'low';
  }
  if (value.includes('high') || value === 'h') return 'high';
  if (value.includes('nominal') || value === 'n') return 'nominal';
  return 'low';
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Maps one CSV row onto the common shape, coping with the fact that the two
 * products do not share column names:
 *
 *   VIIRS_SNPP_NRT: latitude,longitude,bright_ti4,scan,track,acq_date,
 *                   acq_time,satellite,instrument,confidence,version,
 *                   bright_ti5,frp,daynight
 *   MODIS_NRT:      ...,brightness,...,bright_t31,...
 *
 * Which one arrived is decided from the header, never assumed from the
 * product name — the fallback ladder means either can turn up.
 */
function normaliseRow(
  columns: Map<string, number>,
  cells: string[],
  product: string
): NormalisedDetection | null {
  const get = (name: string): string | undefined => {
    const index = columns.get(name);
    return index === undefined ? undefined : cells[index];
  };

  const latitude = numberOrNull(get('latitude'));
  const longitude = numberOrNull(get('longitude'));
  if (latitude === null || longitude === null) return null;

  const acqDate = get('acq_date');
  const acqTime = get('acq_time');
  if (acqDate === undefined || acqTime === undefined) return null;
  const acquiredAt = parseAcquiredAt(acqDate, acqTime);
  if (acquiredAt === null) return null;

  const confidenceRaw = (get('confidence') ?? '').trim();
  if (confidenceRaw === '') return null;

  // bright_ti4 is VIIRS' I-4 channel, brightness is MODIS' equivalent;
  // bright_ti5 / bright_t31 are the respective second channels.
  const brightnessK = numberOrNull(get('bright_ti4') ?? get('brightness'));
  const brightness2K = numberOrNull(get('bright_ti5') ?? get('bright_t31'));

  return {
    product,
    acquiredAt,
    latitude,
    longitude,
    satellite: get('satellite')?.trim() || null,
    instrument: get('instrument')?.trim() || null,
    confidenceRaw,
    confidenceTier: confidenceTier(confidenceRaw),
    brightnessK,
    brightness2K,
    frpMw: numberOrNull(get('frp')),
    scanKm: numberOrNull(get('scan')),
    trackKm: numberOrNull(get('track')),
    daynight: get('daynight')?.trim().charAt(0) || null,
  };
}

function isWithinTurkeyBbox(lat: number, lng: number): boolean {
  return (
    lat >= TURKEY_BBOX.minLat &&
    lat <= TURKEY_BBOX.maxLat &&
    lng >= TURKEY_BBOX.minLng &&
    lng <= TURKEY_BBOX.maxLng
  );
}

class FireIngestJob {
  start() {
    console.log('🛰️  Fire Ingest Job starting...');
    cron.schedule('*/30 * * * *', async () => {
      await this.runIngest();
    });
    this.runIngest();
  }

  /**
   * The code can be deployed before migration 002 has been applied — that is
   * the expected order, since the migration is run by hand. Missing table is
   * therefore a normal state, not an error: skip quietly and say why.
   */
  private async tableExists(): Promise<boolean> {
    const result = await pool.query(
      `SELECT to_regclass('public.fire_detections') AS table_name`
    );
    return result.rows[0]?.table_name !== null;
  }

  async runIngest(): Promise<IngestStats> {
    const stats: IngestStats = {
      products: [],
      perProduct: [],
      fetched: 0,
      malformed: 0,
      outsideBbox: 0,
      outsideBorder: 0,
      outsideCityRadius: 0,
      inserted: 0,
      duplicates: 0,
      pruned: 0,
    };

    try {
      if (!(await this.tableExists())) {
        console.log(
          '⏭️  fire_detections does not exist — skipping ingest. ' +
            'Apply database/migrations/002_add_fire_detections.sql first.'
        );
        return stats;
      }

      const apiKey = process.env.NASA_API_KEY;
      if (!apiKey) {
        console.warn('⚠️  NASA_API_KEY not set — fire ingest skipped');
        return stats;
      }

      // Each product is fetched and persisted independently so one failing
      // or empty source cannot take the run down with it.
      for (const attempt of INGEST_PRODUCTS) {
        const productStats: ProductStats = {
          product: attempt.product,
          fetched: 0,
          inserted: 0,
          duplicates: 0,
          rejected: 0,
          error: null,
        };
        stats.perProduct.push(productStats);

        try {
          const csv = await this.fetchProduct(apiKey, attempt.product, attempt.days);
          if (csv === null) continue;

          const before = { ...stats };
          const detections = this.parseCsv(csv, attempt.product, stats);
          await this.persist(detections, stats);

          productStats.fetched = stats.fetched - before.fetched;
          productStats.inserted = stats.inserted - before.inserted;
          productStats.duplicates = stats.duplicates - before.duplicates;
          productStats.rejected =
            stats.outsideBbox - before.outsideBbox +
            (stats.outsideBorder - before.outsideBorder) +
            (stats.outsideCityRadius - before.outsideCityRadius) +
            (stats.malformed - before.malformed);
          if (productStats.fetched > 0) stats.products.push(attempt.product);
        } catch (error) {
          productStats.error = (error as Error).message;
          console.warn(
            `⚠️  ${attempt.product} ingest failed, continuing with the rest:`,
            productStats.error
          );
        }
      }

      if (stats.products.length === 0) {
        console.warn('⚠️  No FIRMS product returned data — nothing ingested');
      }

      stats.pruned = await this.pruneOldDetections();

      // Clustering runs in the same tick as ingest so a detection never sits
      // unattached for a whole cron interval.
      await fireClusterJob.runClustering();

      console.log(
        `🛰️  Ingest [${stats.products.join(', ') || 'none'}]: fetched ${stats.fetched}, ` +
          `inserted ${stats.inserted}, duplicates ${stats.duplicates}, ` +
          `outside bbox ${stats.outsideBbox}, outside border ${stats.outsideBorder}, ` +
          `beyond ${MAX_NEAREST_CITY_KM}km ${stats.outsideCityRadius}, ` +
          `malformed ${stats.malformed}, ` +
          `pruned ${stats.pruned}`
      );
      for (const p of stats.perProduct) {
        console.log(
          `      ${p.product.padEnd(17)} fetched ${String(p.fetched).padStart(5)} ` +
            `inserted ${String(p.inserted).padStart(5)} dup ${String(p.duplicates).padStart(5)} ` +
            `rejected ${String(p.rejected).padStart(5)}` +
            (p.error ? `  ERROR: ${p.error}` : '')
        );
      }
      return stats;
    } catch (error) {
      console.error('❌ Fire ingest failed:', (error as Error).message);
      return stats;
    }
  }

  /**
   * Fetches one product. Returns null when the source is reachable but has no
   * rows for the area, which is normal for a satellite that has not passed
   * over Turkey in the window.
   */
  private async fetchProduct(
    apiKey: string,
    product: string,
    days: number
  ): Promise<string | null> {
    const url = `${FIRMS_BASE}/${encodeURIComponent(apiKey)}/${product}/${FIRMS_AREA}/${days}`;
    const response = await axios.get<string>(url, {
      timeout: 20_000,
      responseType: 'text',
    });
    const csv = response.data;
    if (csv.trim().split(/\r?\n/).filter(Boolean).length <= 1) return null;
    return csv;
  }

  private parseCsv(
    csv: string,
    product: string,
    stats: IngestStats
  ): NormalisedDetection[] {
    const lines = csv.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length <= 1) return [];

    const header = lines[0].split(',').map((name) => name.trim().toLowerCase());
    const columns = new Map<string, number>();
    header.forEach((name, index) => columns.set(name, index));

    const detections: NormalisedDetection[] = [];
    for (let i = 1; i < lines.length; i++) {
      stats.fetched++;
      const cells = lines[i].split(',');
      const detection = normaliseRow(columns, cells, product);
      if (detection === null) {
        stats.malformed++;
        continue;
      }
      if (!isWithinTurkeyBbox(detection.latitude, detection.longitude)) {
        stats.outsideBbox++;
        continue;
      }
      detections.push(detection);
    }
    return detections;
  }

  /**
   * Resolves the nearest province and region for each detection, then inserts.
   * ON CONFLICT DO NOTHING against the natural key makes re-running the same
   * fetch a no-op rather than a duplicate.
   */
  /**
   * Resolves and inserts a whole fetch in a fixed number of round trips.
   *
   * The first version issued one nearest-province query per detection, so a
   * single 300-row fetch meant 300 sequential round trips to Neon and took
   * over a minute. At peak season that scales to thousands. This does the
   * same work in three queries regardless of row count:
   *
   *   1. read the 81-row province table once and map ids to region keys,
   *   2. one query resolving border containment and nearest province for
   *      every point at once,
   *   3. chunked multi-row inserts.
   */
  private async persist(
    detections: NormalisedDetection[],
    stats: IngestStats
  ): Promise<void> {
    if (detections.length === 0) return;

    const regionByCityId = await this.loadCityRegions();
    const resolved = await this.resolveBatch(detections);

    const rows: unknown[][] = [];
    for (let i = 0; i < detections.length; i++) {
      const detection = detections[i];
      const info = resolved[i];

      // Border gate. When the border table is absent (migration 003 not
      // applied yet) info.inside is null and the older distance heuristic is
      // used instead, so ingest keeps working either way.
      if (info.inside === false) {
        stats.outsideBorder++;
        continue;
      }
      if (
        info.inside === null &&
        info.distanceKm !== null &&
        info.distanceKm > MAX_NEAREST_CITY_KM
      ) {
        stats.outsideCityRadius++;
        continue;
      }

      rows.push([
        detection.product,
        detection.acquiredAt,
        detection.latitude,
        detection.longitude,
        detection.satellite,
        detection.instrument,
        detection.confidenceRaw,
        detection.confidenceTier,
        detection.brightnessK,
        detection.brightness2K,
        detection.frpMw,
        detection.scanKm,
        detection.trackKm,
        detection.daynight,
        info.cityId,
        info.distanceKm,
        info.cityId === null ? null : regionByCityId.get(info.cityId) ?? null,
      ]);
    }

    const COLUMNS = 17;
    // Postgres caps a statement at 65535 parameters; 500 rows x 17 stays far
    // under it while keeping the number of round trips small.
    const CHUNK = 500;
    for (let offset = 0; offset < rows.length; offset += CHUNK) {
      const chunk = rows.slice(offset, offset + CHUNK);
      const values: unknown[] = [];
      const tuples = chunk.map((row, index) => {
        const base = index * COLUMNS;
        values.push(...row);
        return (
          `($${base + 1}, $${base + 2}, $${base + 3}::numeric, $${base + 4}::numeric, ` +
          `ST_SetSRID(ST_MakePoint($${base + 4}::double precision, ` +
          `$${base + 3}::double precision), 4326), ` +
          `$${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, ` +
          `$${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, ` +
          `$${base + 13}, $${base + 14}, $${base + 15}, $${base + 16}, $${base + 17})`
        );
      });

      const result = await pool.query(
        `INSERT INTO fire_detections (
           product, acquired_at, latitude, longitude, geom,
           satellite, instrument, confidence_raw, confidence_tier,
           brightness_k, brightness2_k, frp_mw, scan_km, track_km, daynight,
           city_id, nearest_city_km, region_key
         ) VALUES ${tuples.join(', ')}
         ON CONFLICT ON CONSTRAINT fire_detections_natural_key DO NOTHING`,
        values
      );

      const inserted = result.rowCount ?? 0;
      stats.inserted += inserted;
      stats.duplicates += chunk.length - inserted;
    }
  }

  /**
   * Whether the Turkish border row is present. Cached per process: the table
   * is static, and this runs before every batch.
   */
  private borderChecked = false;
  private borderPresent = false;

  private async borderAvailable(): Promise<boolean> {
    if (this.borderChecked) return this.borderPresent;
    const result = await pool.query(
      `SELECT to_regclass('public.country_borders') AS tbl`
    );
    if (result.rows[0]?.tbl === null) {
      this.borderChecked = true;
      this.borderPresent = false;
      console.warn(
        '⚠️  country_borders missing — falling back to the nearest-province ' +
          'distance filter. Apply migration 003 to enable the border gate.'
      );
      return false;
    }
    const row = await pool.query(
      `SELECT 1 FROM country_borders WHERE iso_a3 = 'TUR' LIMIT 1`
    );
    this.borderChecked = true;
    this.borderPresent = (row.rowCount ?? 0) > 0;
    return this.borderPresent;
  }

  /** id -> canonical region key for all 81 provinces, read once per run. */
  private async loadCityRegions(): Promise<Map<number, string | null>> {
    const result = await pool.query(
      `SELECT id, region,
              ST_Y(location::geometry) AS lat,
              ST_X(location::geometry) AS lng
       FROM turkey_cities`
    );
    const map = new Map<number, string | null>();
    for (const row of result.rows) {
      map.set(
        Number(row.id),
        regionKeyForRegionName(row.region) ??
          (row.lat !== null && row.lng !== null
            ? regionKeyForCoordinates(Number(row.lat), Number(row.lng))
            : null)
      );
    }
    return map;
  }

  /**
   * One query: for every point, is it inside the country gate and which
   * province is nearest. `inside` is null when country_borders has no Turkish
   * row yet, which is how this stays safe before migration 003 is applied.
   */
  private async resolveBatch(
    detections: NormalisedDetection[]
  ): Promise<Array<{ inside: boolean | null; cityId: number | null; distanceKm: number | null }>> {
    const lats = detections.map((d) => d.latitude);
    const lngs = detections.map((d) => d.longitude);

    // Referencing country_borders in the query at all fails outright when the
    // table is absent — a CTE against a missing relation is a parse error, not
    // a null. That would take the whole ingest down between deploying this
    // code and applying migration 003, so the gate is only built into the
    // query once the table is known to be there.
    const hasBorder = await this.borderAvailable();

    const borderSelect = hasBorder
      ? `ST_Contains((SELECT geom_gate FROM country_borders WHERE iso_a3 = 'TUR' LIMIT 1), p.geom)`
      : `NULL::boolean`;

    const result = await pool.query(
      `WITH pts AS (
         SELECT ordinality AS idx,
                ST_SetSRID(ST_MakePoint(lng, lat), 4326) AS geom
         FROM unnest($1::double precision[], $2::double precision[])
              WITH ORDINALITY AS t(lat, lng, ordinality)
       )
       SELECT p.idx,
              ${borderSelect} AS inside,
              c.id AS city_id,
              c.dist_km
       FROM pts p
       LEFT JOIN LATERAL (
         SELECT tc.id,
                ST_Distance(tc.location::geography, p.geom::geography) / 1000 AS dist_km
         FROM turkey_cities tc
         ORDER BY tc.location <-> p.geom
         LIMIT 1
       ) c ON true
       ORDER BY p.idx`,
      [lats, lngs]
    );

    return result.rows.map((row: any) => ({
      inside: row.inside === null ? null : Boolean(row.inside),
      cityId: row.city_id === null ? null : Number(row.city_id),
      distanceKm: row.dist_km === null ? null : Number(row.dist_km),
    }));
  }

  /**
   * Raw pixels are only needed while they can still be clustered into or
   * extend an incident. Everything older is dead weight — measured volume is
   * roughly 400 detections/day off-season, so 90 days is well under any
   * storage concern while keeping a full season's tail available.
   */
  private async pruneOldDetections(): Promise<number> {
    const result = await pool.query(
      `DELETE FROM fire_detections
       WHERE acquired_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`
    );
    return result.rowCount ?? 0;
  }
}

export default new FireIngestJob();
