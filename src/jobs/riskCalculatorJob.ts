import { allScopeAllowedSql } from '../utils/alertConsent';
import cron from 'node-cron';
import pool from '../config/database';
import cacheService from '../services/cacheService';
import { RegionFireStats, loadRegionFireStats } from '../services/nearbyFireCount';
import type { WeatherData } from '../services/weatherProviders';
import { weatherCellKey, weatherSource } from '../services/weatherSource';
import notificationService from '../services/notificationService';
import { multipleDetectionsAlertText, riskAlertText } from '../services/alertText';
import { regionKeyForCoordinates, regionKeyForRegionName } from '../utils/regions';
import { RiskResult, calculateRisk } from '../services/riskScore';

const REGIONS = [
  { name: 'Ege', display: 'Ege', lat: 38.42, lng: 27.14 },
  { name: 'Akdeniz', display: 'Akdeniz', lat: 36.9, lng: 30.7 },
  { name: 'Marmara', display: 'Marmara', lat: 40.18, lng: 29.07 },
  { name: 'Karadeniz', display: 'Karadeniz', lat: 41.28, lng: 36.33 },
  { name: 'Ic Anadolu', display: 'İç Anadolu', lat: 39.93, lng: 32.86 },
  { name: 'Dogu Anadolu', display: 'Doğu Anadolu', lat: 39.9, lng: 41.27 },
  { name: 'Guneydogu Anadolu', display: 'Güneydoğu Anadolu', lat: 37.07, lng: 37.38 },
];

type Region = typeof REGIONS[number];

const RISK_ALERT_THRESHOLD = 70;
const RISK_ALERT_TTL_SECONDS = 6 * 60 * 60;
const CRITICAL_FIRE_THRESHOLD = 5;
const CRITICAL_ALERT_TTL_SECONDS = 3 * 60 * 60;

class RiskCalculatorJob {
  start() {
    console.log('Risk Calculator Job starting...');
    cron.schedule('0 */3 * * *', async () => {
      await this.runCalculator();
    });
    this.runCalculator();
  }

  async runCalculator() {
    console.log('Running risk calculator at:', new Date().toISOString());

    // The fire component is the app's own count: incidents of the last
    // 24 h inside Turkey, fixed heat sources excluded — the same number
    // /api/risk/summary shows as nearby_fire_count. Null means ingest or
    // clustering is more than 6 h stale; then no row is written, because a
    // score computed without its fire part would read as "no fires".
    const fireStatsByRegion = await loadRegionFireStats(pool);
    if (fireStatsByRegion === null) {
      console.error('Risk calculator skipped: fire counts unavailable (ingest/cluster stale or unreadable)');
      return;
    }

    // All regions in one request. A region with no reading gets no row, so
    // the published score ages and is marked stale instead of being invented.
    const readings = await weatherSource.readMany(REGIONS, 'regions');

    for (const region of REGIONS) {
      try {
        const reading = readings.get(weatherCellKey(region.lat, region.lng));
        if (!reading) throw new Error('weather unavailable from every provider');
        const weather = reading.weather;
        const fireStats = this.fireStatsFor(region, fireStatsByRegion);
        const risk = calculateRisk(weather, fireStats.incidents);

        await pool.query(
          `INSERT INTO risk_data
            (region, date, general_risk_score, risk_level, temperature, humidity,
             wind_speed, wind_direction, dryness_index, vegetation_density)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            region.name,
            new Date(),
            risk.score,
            risk.level,
            weather.temperature,
            weather.humidity,
            weather.windSpeed,
            weather.windDirection,
            risk.drynessIndex,
            risk.vegetationPressure,
          ]
        );

        console.log(`OK ${region.name}: Score=${risk.score}, Temp=${weather.temperature}, Hum=${weather.humidity}, Wind=${weather.windSpeed}, Fire=${fireStats.incidents} (db, 24h), HighConf=${fireStats.highConfidence}`);

        // Best-effort: a notification failure must never take down the
        // calculator loop or skip the risk_data row already just written.
        await this.maybeSendRiskAlert(region, risk, weather).catch((err) =>
          console.error(`Risk alert failed for ${region.name}:`, (err as Error).message)
        );
        await this.maybeSendCriticalFireAlert(region, fireStats.highConfidence).catch((err) =>
          console.error(`Critical alert failed for ${region.name}:`, (err as Error).message)
        );
      } catch (error) {
        console.error(`Error for ${region.name}:`, (error as Error).message);
      }
    }

    await cacheService.delete('risk:summary');
    console.log('Risk calculator completed');
  }

  private fireStatsFor(region: Region, stats: Map<string, RegionFireStats>): RegionFireStats {
    const key = regionKeyForRegionName(region.name) ?? regionKeyForCoordinates(region.lat, region.lng);
    return (key && stats.get(key)) ?? { incidents: 0, highConfidence: 0 };
  }

  // Region radius is generous (400km) since REGIONS' lat/lng are single
  // representative points for areas that actually span a few hundred km —
  // a tight radius would miss users at the edges of their own region.
  // A device with no stored location cannot be matched by distance, so it
  // gets a region's alert only if it picked that region or province, or
  // asked for the whole country (allScopeAllowedSql).
  private static readonly REGION_RADIUS_METERS = 400_000;

  // No LIMIT: notificationService.sendToTokens chunks into 500s internally, so
  // every matching device is reached. The old `LIMIT 500` silently excluded
  // every device past the 500th from region risk alerts.
  //
  // The alert_scope clause layers the user's explicit choice on top of the
  // proximity match: a device that asked for city-only alerts is not woken by
  // a region-wide risk notice unless that region's representative point
  // resolves to their own city.
  /**
   * Every province that belongs to a region, memoised — turkey_cities is a
   * static 81-row table.
   *
   * The province's own `region` column is authoritative; the coordinate boxes
   * are only a fallback for rows where it is missing or spelled in a way we
   * don't recognise. Getting this wrong silently mutes users, so neither
   * source is trusted alone.
   */
  private static cityRegionCache: Map<string, number[]> | null = null;

  private async cityIdsInRegion(regionKey: string | null): Promise<number[]> {
    if (regionKey === null) return [];

    if (RiskCalculatorJob.cityRegionCache === null) {
      const result = await pool.query(
        `SELECT id, region,
                ST_Y(location::geometry) AS lat,
                ST_X(location::geometry) AS lng
         FROM turkey_cities`
      );
      const cache = new Map<string, number[]>();
      for (const row of result.rows) {
        const key =
          regionKeyForRegionName(row.region) ??
          (row.lat !== null && row.lng !== null
            ? regionKeyForCoordinates(Number(row.lat), Number(row.lng))
            : null);
        if (key === null) continue;
        const list = cache.get(key) ?? [];
        list.push(Number(row.id));
        cache.set(key, list);
      }
      RiskCalculatorJob.cityRegionCache = cache;
    }

    return RiskCalculatorJob.cityRegionCache.get(regionKey) ?? [];
  }

  // No LIMIT: notificationService.sendToTokens chunks into 500s internally, so
  // every matching device is reached. The old `LIMIT 500` silently excluded
  // every device past the 500th from region risk alerts.
  //
  // A city-scoped device matches when ITS OWN province sits in the region being
  // alerted — not when its province happens to be the one nearest the region's
  // representative point. That earlier version meant e.g. Ege's representative
  // point resolves to İzmir, so a Muğla user on 'city' scope would never have
  // received an Ege risk alert at all.
  private async getActiveTokensNearRegion(region: Region): Promise<string[]> {
    const regionKey =
      regionKeyForRegionName(region.name) ??
      regionKeyForCoordinates(region.lat, region.lng);
    const cityIds = await this.cityIdsInRegion(regionKey);

    const result = await pool.query(
      `SELECT t.token FROM fcm_tokens t
       WHERE t.is_active = true
         AND ${allScopeAllowedSql('t')}
         AND (
           t.latitude IS NULL OR t.longitude IS NULL
           OR ST_DWithin(
             ST_SetSRID(ST_MakePoint(t.longitude, t.latitude), 4326)::geography,
             ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
             $3
           )
         )
         AND (
           t.alert_scope = 'all'
           OR (t.alert_scope = 'region' AND t.region_key IS NOT NULL AND t.region_key = $4)
           OR (t.alert_scope = 'city' AND t.city_id IS NOT NULL AND t.city_id = ANY($5::int[]))
         )`,
      [region.lng, region.lat, RiskCalculatorJob.REGION_RADIUS_METERS, regionKey, cityIds]
    );
    return result.rows.map((row: { token: string }) => row.token);
  }

  private async maybeSendRiskAlert(region: Region, risk: RiskResult, weather: WeatherData): Promise<void> {
    if (risk.score < RISK_ALERT_THRESHOLD) return;

    const cacheKey = `notif:region:${region.name}`;
    if (await cacheService.get<boolean>(cacheKey)) return;

    const tokens = await this.getActiveTokensNearRegion(region);
    if (tokens.length === 0) return;

    const text = riskAlertText({
      regionDisplay: region.display,
      score: risk.score,
      temperature: weather.temperature,
      humidity: weather.humidity,
      windSpeed: weather.windSpeed,
    });
    await notificationService.sendToTokens(tokens, text.title, text.body);
    await cacheService.set(cacheKey, true, RISK_ALERT_TTL_SECONDS);
  }

  private async maybeSendCriticalFireAlert(region: Region, highConfidenceCount: number): Promise<void> {
    if (highConfidenceCount <= CRITICAL_FIRE_THRESHOLD) return;

    const cacheKey = `notif:critical:${region.name}`;
    if (await cacheService.get<boolean>(cacheKey)) return;

    const tokens = await this.getActiveTokensNearRegion(region);
    if (tokens.length === 0) return;

    const text = multipleDetectionsAlertText(region.display, highConfidenceCount);
    await notificationService.sendToTokens(tokens, text.title, text.body);
    await cacheService.set(cacheKey, true, CRITICAL_ALERT_TTL_SECONDS);
  }
}

export default new RiskCalculatorJob();
