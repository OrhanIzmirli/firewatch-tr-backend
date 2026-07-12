import cron from 'node-cron';
import axios from 'axios';
import pool from '../config/database';
import cacheService from '../services/cacheService';
import notificationService from '../services/notificationService';

const REGIONS = [
  { name: 'Ege', display: 'Ege', lat: 38.42, lng: 27.14 },
  { name: 'Akdeniz', display: 'Akdeniz', lat: 36.9, lng: 30.7 },
  { name: 'Marmara', display: 'Marmara', lat: 40.18, lng: 29.07 },
  { name: 'Karadeniz', display: 'Karadeniz', lat: 41.28, lng: 36.33 },
  { name: 'Ic Anadolu', display: 'İç Anadolu', lat: 39.93, lng: 32.86 },
  { name: 'Dogu Anadolu', display: 'Doğu Anadolu', lat: 39.9, lng: 41.27 },
  { name: 'Guneydogu Anadolu', display: 'Güneydoğu Anadolu', lat: 37.07, lng: 37.38 },
];

const CACHE_TTL = 300; // 5 dakika

interface WeatherData {
  temperature: number;
  humidity: number;
  windSpeed: number;
  windDirection: string;
}

interface RiskResult {
  score: number;
  level: string;
  drynessIndex: number;
  vegetationPressure: number;
}

interface FireStats {
  total: number;
  highConfidence: number;
}

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

    for (const region of REGIONS) {
      try {
        const weather = await this.fetchWeather(region.lat, region.lng);
        const fireStats = await this.fetchFireStats(region.lat, region.lng);
        const risk = this.calculateRisk(weather, fireStats.total);

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

        console.log(`OK ${region.name}: Score=${risk.score}, Temp=${weather.temperature}, Hum=${weather.humidity}, Wind=${weather.windSpeed}, Fire=${fireStats.total}, HighConf=${fireStats.highConfidence}`);

        // Best-effort: a notification failure must never take down the
        // calculator loop or skip the risk_data row already just written.
        await this.maybeSendRiskAlert(region, risk).catch((err) =>
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

  private async fetchWeather(lat: number, lng: number): Promise<WeatherData> {
    const cacheKey = `weather:${lat}:${lng}`;
    const cached = await cacheService.get<WeatherData>(cacheKey);
    if (cached) {
      console.log(`Cache HIT: ${cacheKey}`);
      return cached;
    }

    const response = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: lat,
        longitude: lng,
        current: 'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m',
        wind_speed_unit: 'kmh',
      },
      timeout: 10000,
    });

    const current = response.data.current;
    const windDeg = current.wind_direction_10m ?? 0;

    const data: WeatherData = {
      temperature: Math.round(current.temperature_2m),
      humidity: Math.round(current.relative_humidity_2m),
      windSpeed: Math.round(current.wind_speed_10m),
      windDirection: this.degToDirection(windDeg),
    };

    await cacheService.set(cacheKey, data, CACHE_TTL);
    return data;
  }

  private async fetchFireStats(lat: number, lng: number): Promise<FireStats> {
    const cacheKey = `nasa:fires:${lat}:${lng}`;
    const cached = await cacheService.get<FireStats>(cacheKey);
    if (cached !== null) {
      console.log(`Cache HIT: ${cacheKey}`);
      return cached;
    }

    const nasaApiKey = process.env.NASA_API_KEY;
    if (!nasaApiKey) throw new Error('NASA_API_KEY is not configured');

    try {
      const area = `${lng - 2},${lat - 2},${lng + 2},${lat + 2}`;
      const attempts = [
        { product: 'VIIRS_SNPP_NRT', days: 1 },
        { product: 'MODIS_NRT', days: 1 },
        { product: 'VIIRS_SNPP_NRT', days: 2 },
      ];
      let stats: FireStats = { total: 0, highConfidence: 0 };
      for (const attempt of attempts) {
        const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(nasaApiKey)}/${attempt.product}/${area}/${attempt.days}`;
        const response = await axios.get(url, { timeout: 15000 });
        stats = this.parseFireStats(response.data as string);
        if (stats.total > 0) break;
      }

      await cacheService.set(cacheKey, stats, CACHE_TTL);
      return stats;
    } catch (error) {
      throw new Error(`NASA thermal count unavailable: ${(error as Error).message}`);
    }
  }

  // High confidence = VIIRS 'h' or a numeric MODIS confidence >= 80 — same
  // tiering the Flutter client uses (fire_api_service.dart _confidenceRank),
  // kept consistent so "high confidence" means the same thing everywhere.
  private parseFireStats(csv: string): FireStats {
    const lines = csv.trim().split(/\r?\n/);
    if (lines.length <= 1) return { total: 0, highConfidence: 0 };

    const header = lines[0].split(',');
    const confidenceIdx = header.indexOf('confidence');

    let highConfidence = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const raw = (confidenceIdx >= 0 ? cols[confidenceIdx] : '')?.trim().toLowerCase() ?? '';
      const numeric = Number(raw);
      if (raw !== '' && !Number.isNaN(numeric)) {
        if (numeric >= 80) highConfidence++;
      } else if (raw === 'h') {
        highConfidence++;
      }
    }

    return { total: lines.length - 1, highConfidence };
  }

  // Region radius is generous (400km) since REGIONS' lat/lng are single
  // representative points for areas that actually span a few hundred km —
  // a tight radius would miss users at the edges of their own region.
  // Tokens with no stored location match every region's alert rather than
  // none — we'd rather over-notify a user we can't place than silently
  // never notify them at all.
  private static readonly REGION_RADIUS_METERS = 400_000;

  private async getActiveTokensNearRegion(region: Region): Promise<string[]> {
    const result = await pool.query(
      `SELECT token FROM fcm_tokens
       WHERE is_active = true
         AND (
           latitude IS NULL OR longitude IS NULL
           OR ST_DWithin(
             ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography,
             ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
             $3
           )
         )
       LIMIT 500`,
      [region.lng, region.lat, RiskCalculatorJob.REGION_RADIUS_METERS]
    );
    return result.rows.map((row: { token: string }) => row.token);
  }

  private async maybeSendRiskAlert(region: Region, risk: RiskResult): Promise<void> {
    if (risk.score < RISK_ALERT_THRESHOLD) return;

    const cacheKey = `notif:region:${region.name}`;
    if (await cacheService.get<boolean>(cacheKey)) return;

    const tokens = await this.getActiveTokensNearRegion(region);
    if (tokens.length === 0) return;

    await notificationService.sendToTokens(
      tokens,
      `🔥 Yüksek Yangın Riski - ${region.display}`,
      `Risk skoru: ${risk.score}/100. Sıcaklık yüksek, nem düşük. Dikkatli olun.`
    );
    await cacheService.set(cacheKey, true, RISK_ALERT_TTL_SECONDS);
  }

  private async maybeSendCriticalFireAlert(region: Region, highConfidenceCount: number): Promise<void> {
    if (highConfidenceCount <= CRITICAL_FIRE_THRESHOLD) return;

    const cacheKey = `notif:critical:${region.name}`;
    if (await cacheService.get<boolean>(cacheKey)) return;

    const tokens = await this.getActiveTokensNearRegion(region);
    if (tokens.length === 0) return;

    await notificationService.sendToTokens(
      tokens,
      '🚨 Kritik: Çoklu Yangın Tespiti',
      `${highConfidenceCount} yüksek güvenilirlikli termal nokta tespit edildi - ${region.display}`
    );
    await cacheService.set(cacheKey, true, CRITICAL_ALERT_TTL_SECONDS);
  }

  private calculateRisk(weather: WeatherData, fireCount: number): RiskResult {
    let score = 0;

    if (weather.temperature >= 40) score += 30;
    else if (weather.temperature >= 35) score += 22;
    else if (weather.temperature >= 30) score += 14;
    else if (weather.temperature >= 25) score += 7;

    if (weather.humidity <= 20) score += 25;
    else if (weather.humidity <= 30) score += 20;
    else if (weather.humidity <= 40) score += 13;
    else if (weather.humidity <= 50) score += 6;

    if (weather.windSpeed >= 50) score += 25;
    else if (weather.windSpeed >= 35) score += 18;
    else if (weather.windSpeed >= 20) score += 11;
    else if (weather.windSpeed >= 10) score += 5;

    if (fireCount >= 10) score += 20;
    else if (fireCount >= 5) score += 15;
    else if (fireCount >= 2) score += 10;
    else if (fireCount >= 1) score += 5;

    // Heat index bonus: high temperature and low humidity together are a
    // well-established synergistic fire-danger multiplier (the interaction
    // this additive bucket scoring otherwise misses — e.g. Fosberg Fire
    // Weather Index combines temp/humidity/wind non-linearly rather than
    // just summing independent thresholds). Tiers are mutually exclusive;
    // only the higher one applies.
    if (weather.temperature > 40 && weather.humidity < 20) {
      score += 20;
    } else if (weather.temperature > 35 && weather.humidity < 30) {
      score += 10;
    }

    score = Math.min(100, score);

    // Dryness index: temp and humidity remain the primary drivers, but wind
    // now also contributes — it accelerates fuel drying and moisture loss,
    // not just fire spread once ignited.
    const drynessIndex = Math.min(100, Math.round(
      (weather.temperature / 45) * 50 + ((100 - weather.humidity) / 100) * 35 + (weather.windSpeed / 80) * 15
    ));

    const vegetationPressure = Math.min(100, Math.round(
      (weather.windSpeed / 80) * 50 + (weather.temperature / 45) * 50
    ));

    return {
      score,
      level: this.calculateRiskLevel(score),
      drynessIndex,
      vegetationPressure,
    };
  }

  private calculateRiskLevel(score: number): string {
    if (score >= 75) return 'Critical';
    if (score >= 50) return 'High';
    if (score >= 25) return 'Medium';
    return 'Low';
  }

  private degToDirection(deg: number): string {
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return directions[Math.round(deg / 45) % 8];
  }
}

export default new RiskCalculatorJob();
