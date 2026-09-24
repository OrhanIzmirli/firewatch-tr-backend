import { Router, Request, Response } from 'express';
import pool from '../config/database';
import cacheService from '../services/cacheService';
import { rateLimit } from '../middleware/security';
import { RegionKey, isRegionKey, regionKeyForCoordinates } from '../utils/regions';
import { PIXEL_HECTARES, PRODUCT } from '../services/burnedAreaRaster';

const router = Router();

/**
 * GET /api/loss-summary?region=&city_id=&months=12
 *
 * The "Kayıplar ve restorasyon" screen. Two halves, deliberately unequal:
 *
 *   burned_area   satellite-mapped burned hectares per month and per
 *                 district, from NASA MCD64A1. Real numbers, with their
 *                 provenance and their caveats in the payload itself.
 *
 *   restoration   ALWAYS { status: 'no_data', tracked: true }. There is no
 *                 data source for restoration; no table exists for it; this
 *                 handler has no code path that could put a number there.
 *                 When verified official records exist one day, they get
 *                 their own migration and this object changes shape then.
 *
 * Missing migration 010 → burned_area.available = false with an empty body,
 * never a 500: the screen must render its "waiting" state, not an error.
 */

const CACHE_TTL_SECONDS = 6 * 3600;
const DEFAULT_MONTHS = 12;
const MAX_MONTHS = 24;
const TOP_DISTRICTS = 20;
/** Measured publish lag (38–50 d); the ETA shown is the middle of it. */
const EXPECTED_LAG_DAYS = 42;

const RESTORATION_NO_DATA = {
  status: 'no_data' as const,
  tracked: true,
  message_tr:
    'Restorasyon verisi yok, takip ediliyor. Ağaçlandırma ve iyileşme bilgisi yalnızca doğrulanmış resmi kayıt sağlandığında gösterilir; tahmin üretilmez.',
  message_en:
    'No restoration data; tracking. Reforestation and recovery will be shown only when a verified official record exists; nothing is estimated.',
  source: null,
};

const SOURCE = {
  product: PRODUCT,
  provider: 'NASA LP DAAC (MODIS Terra+Aqua burned area), fetched via AppEEARS',
  resolution_m: 500,
  pixel_ha: Math.round(PIXEL_HECTARES * 100) / 100,
  caveat_tr:
    'Uydunun 500 m çözünürlükte haritaladığı yanmış alandır. Küçük yangınları kaçırır ve arazi örtüsü ayrımı yapmaz: tarım alanı yanıkları da dahildir. Her değer bir alt sınırdır.',
  caveat_en:
    'Burned area mapped by satellite at 500 m. Small fires are missed and land cover is not distinguished: agricultural burns are included. Every value is a floor.',
  credit: 'Giglio, L., Justice, C., Boschetti, L., Roy, D. (2021). MCD64A1 MODIS/Terra+Aqua Burned Area Monthly L3 Global 500m SIN Grid V061. NASA EOSDIS LP DAAC.',
};

interface DistrictRef {
  id: number;
  name: string;
  provinceId: number;
  provinceName: string;
  region: RegionKey | null;
}

let districtCache: { loadedAt: number; rows: DistrictRef[] } | null = null;
const DISTRICT_CACHE_MS = 3_600_000;

async function loadDistricts(): Promise<DistrictRef[]> {
  if (districtCache && Date.now() - districtCache.loadedAt < DISTRICT_CACHE_MS) {
    return districtCache.rows;
  }
  const result = await pool.query(
    `SELECT id, name, province_id, province_name,
            ST_Y(location) AS lat, ST_X(location) AS lng
       FROM turkey_districts`
  );
  const rows = result.rows.map((r: any) => ({
    id: Number(r.id),
    name: String(r.name),
    provinceId: Number(r.province_id),
    provinceName: String(r.province_name),
    region: regionKeyForCoordinates(Number(r.lat), Number(r.lng)),
  }));
  districtCache = { loadedAt: Date.now(), rows };
  return rows;
}

function monthsBack(latest: string, count: number): string[] {
  const [y, m] = latest.split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out.reverse();
}

function nextMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

function expectedAround(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  const monthEnd = new Date(Date.UTC(y, m, 0));
  return new Date(monthEnd.getTime() + EXPECTED_LAG_DAYS * 86_400_000).toISOString().slice(0, 10);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

router.get('/', rateLimit('loss_summary', 60, 60_000), async (req: Request, res: Response) => {
  try {
    const region = typeof req.query.region === 'string' && isRegionKey(req.query.region)
      ? req.query.region
      : null;
    const cityRaw = Number(req.query.city_id);
    const cityId = Number.isInteger(cityRaw) && cityRaw > 0 ? cityRaw : null;
    const monthsRaw = Number(req.query.months);
    const months = Number.isInteger(monthsRaw)
      ? Math.min(MAX_MONTHS, Math.max(1, monthsRaw))
      : DEFAULT_MONTHS;

    const cacheKey = 'loss-summary:v1:' + JSON.stringify({ region, cityId, months });
    const cached = await cacheService.get<unknown>(cacheKey);
    if (cached) {
      res.set('Cache-Control', 'public, max-age=1800, stale-while-revalidate=3600');
      res.set('X-Cache', 'HIT');
      res.json(cached);
      return;
    }

    const payload = await buildSummary(region, cityId, months);
    await cacheService.set(cacheKey, payload, CACHE_TTL_SECONDS);
    res.set('Cache-Control', 'public, max-age=1800, stale-while-revalidate=3600');
    res.set('X-Cache', 'MISS');
    res.json(payload);
  } catch (error) {
    console.error('Loss summary error:', error);
    res.status(500).json({ status: 'error', message: 'Unable to build loss summary' });
  }
});

async function buildSummary(region: RegionKey | null, cityId: number | null, months: number) {
  const filters = { region, city_id: cityId, months };

  let coverageRows;
  try {
    coverageRows = await pool.query(
      `SELECT to_char(year_month, 'YYYY-MM') AS ym, status, downloaded_at, unattributed_count
         FROM burned_area_fetches
        WHERE product = $1
        ORDER BY year_month`,
      [PRODUCT]
    );
  } catch (error) {
    if ((error as { code?: string }).code === '42P01') {
      return {
        status: 'success',
        filters,
        burned_area: {
          available: false,
          source: SOURCE,
          coverage: null,
          totals: null,
          by_month: [],
          by_district: [],
          note_tr: 'Yanan alan verisi henüz hazırlanıyor.',
          note_en: 'Burned-area data is not ready yet.',
        },
        restoration: RESTORATION_NO_DATA,
      };
    }
    throw error;
  }

  const downloaded = coverageRows.rows.filter((r: any) => r.status === 'downloaded');
  const latest = downloaded.length > 0 ? String(downloaded[downloaded.length - 1].ym) : null;
  const downloadedSet = new Set<string>(downloaded.map((r: any) => String(r.ym)));
  const pendingMonths = coverageRows.rows
    .filter((r: any) => r.status !== 'downloaded')
    .map((r: any) => String(r.ym));

  const districts = await loadDistricts();
  const selected = districts.filter(
    (d) => (region === null || d.region === region) && (cityId === null || d.provinceId === cityId)
  );
  const selectedIds = selected.map((d) => d.id);
  const byId = new Map(districts.map((d) => [d.id, d]));

  if (latest === null || selectedIds.length === 0) {
    const nextExpected = latest === null
      ? (coverageRows.rows.length > 0 ? String(coverageRows.rows[0].ym) : null)
      : nextMonth(latest);
    return {
      status: 'success',
      filters,
      burned_area: {
        available: latest !== null,
        source: SOURCE,
        coverage: {
          latest_month: latest,
          latest_fetched_at: null,
          months_available: downloaded.length,
          next_expected_month: nextExpected,
          next_expected_around: nextExpected ? expectedAround(nextExpected) : null,
          pending_months: pendingMonths,
        },
        totals: { hectares: 0, pixel_count: 0, incidents_with_burned_area: 0, outside_district_boundaries_ha: 0 },
        by_month: [],
        by_district: [],
        restriction: selectedIds.length === 0 ? 'no districts match the filter' : null,
      },
      restoration: RESTORATION_NO_DATA,
    };
  }

  const window = monthsBack(latest, months);
  const windowStart = `${window[0]}-01`;
  const windowEnd = `${latest}-01`;

  const [monthly, districtTotals, incidents, unattributed] = await Promise.all([
    pool.query(
      `SELECT to_char(year_month, 'YYYY-MM') AS ym,
              sum(hectares)::float AS hectares, sum(pixel_count)::int AS pixels
         FROM burned_area_monthly
        WHERE product = $1 AND year_month BETWEEN $2 AND $3
          AND district_id = ANY($4::int[])
        GROUP BY year_month ORDER BY year_month`,
      [PRODUCT, windowStart, windowEnd, selectedIds]
    ),
    pool.query(
      `SELECT district_id, sum(hectares)::float AS hectares, sum(pixel_count)::int AS pixels,
              to_char(max(year_month), 'YYYY-MM') AS last_month
         FROM burned_area_monthly
        WHERE product = $1 AND year_month BETWEEN $2 AND $3
          AND district_id = ANY($4::int[])
        GROUP BY district_id ORDER BY hectares DESC LIMIT $5`,
      [PRODUCT, windowStart, windowEnd, selectedIds, TOP_DISTRICTS]
    ),
    pool.query(
      `SELECT count(*)::int AS n
         FROM fire_incidents
        WHERE optical_source = $1 AND optical_burnt_area_ha > 0
          AND ($2::text IS NULL OR region_key = $2)
          AND ($3::int  IS NULL OR city_id = $3)`,
      [PRODUCT, region, cityId]
    ),
    // Only meaningful country-wide: a pixel outside every polygon has no
    // province to be filtered by.
    region === null && cityId === null
      ? pool.query(
          `SELECT coalesce(sum(unattributed_count), 0)::int AS n
             FROM burned_area_fetches
            WHERE product = $1 AND status = 'downloaded' AND year_month BETWEEN $2 AND $3`,
          [PRODUCT, windowStart, windowEnd]
        )
      : Promise.resolve({ rows: [{ n: 0 }] }),
  ]);

  const monthlyMap = new Map<string, { hectares: number; pixels: number }>(
    monthly.rows.map((r: any) => [String(r.ym), { hectares: Number(r.hectares), pixels: Number(r.pixels) }])
  );
  const byMonth = window.map((ym) => {
    const hit = monthlyMap.get(ym);
    return {
      year_month: ym,
      // false = NASA has not published (or we have not fetched) this month;
      // a 0 with available=true means the satellite mapped nothing.
      available: downloadedSet.has(ym),
      hectares: hit ? round1(hit.hectares) : 0,
      pixel_count: hit ? hit.pixels : 0,
    };
  });

  const totalHa = monthly.rows.reduce((s: number, r: any) => s + Number(r.hectares), 0);
  const totalPx = monthly.rows.reduce((s: number, r: any) => s + Number(r.pixels), 0);
  const latestFetched = downloaded[downloaded.length - 1].downloaded_at;
  const next = nextMonth(latest);

  return {
    status: 'success',
    filters,
    burned_area: {
      available: true,
      source: SOURCE,
      coverage: {
        latest_month: latest,
        latest_fetched_at: latestFetched,
        months_available: downloaded.length,
        next_expected_month: next,
        next_expected_around: expectedAround(next),
        pending_months: pendingMonths,
        latency_note_tr:
          'NASA bir ayın verisini ay bittikten yaklaşık 6 hafta sonra yayımlar (ölçülen: 38–50 gün).',
        latency_note_en:
          'NASA publishes a month roughly six weeks after it ends (measured: 38–50 days).',
      },
      totals: {
        hectares: round1(totalHa),
        pixel_count: totalPx,
        incidents_with_burned_area: Number(incidents.rows[0].n),
        outside_district_boundaries_ha: round1(Number(unattributed.rows[0].n) * PIXEL_HECTARES),
      },
      by_month: byMonth,
      by_district: districtTotals.rows.map((r: any) => {
        const d = byId.get(Number(r.district_id));
        return {
          district_id: Number(r.district_id),
          district_name: d?.name ?? null,
          province_id: d?.provinceId ?? null,
          province_name: d?.provinceName ?? null,
          region_key: d?.region ?? null,
          hectares: round1(Number(r.hectares)),
          pixel_count: Number(r.pixels),
          last_month: String(r.last_month),
        };
      }),
    },
    restoration: RESTORATION_NO_DATA,
  };
}

export default router;
