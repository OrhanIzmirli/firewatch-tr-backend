import cron from 'node-cron';
import axios from 'axios';
import pool from '../config/database';
import cacheService from '../services/cacheService';

const REGIONS = [
  { name: 'Ege', display: 'Ege', lat: 38.42, lng: 27.14 },
  { name: 'Akdeniz', display: 'Akdeniz', lat: 36.9, lng: 30.7 },
  { name: 'Marmara', display: 'Marmara', lat: 40.18, lng: 29.07 },
  { name: 'Karadeniz', display: 'Karadeniz', lat: 41.28, lng: 36.33 },
  { name: 'Ic Anadolu', display: 'İç Anadolu', lat: 39.93, lng: 32.86 },
  { name: 'Dogu Anadolu', display: 'Doğu Anadolu', lat: 39.9, lng: 41.27 },
  { name: 'Guneydogu Anadolu', display: 'Güneydoğu Anadolu', lat: 37.07, lng: 37.38 },
];

const NASA_API_KEY = '2fe2d1a21d4de517b1e877a27e308c6f';
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

class RiskCalculatorJob {
  start() {
    console.log('Risk Calculator Job starting...');
    cron.schedule('0 */12 * * *', async () => {
      await this.runCalculator();
    });
    this.runCalculator();
  }

  async runCalculator() {
    console.log('Running risk calculator at:', new Date().toISOString());

    for (const region of REGIONS) {
      try {
        const weather = await this.fetchWeather(region.lat, region.lng);
        const fireCount = await this.fetchFireCount(region.lat, region.lng);
        const risk = this.calculateRisk(weather, fireCount);

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

        console.log(`OK ${region.name}: Score=${risk.score}, Temp=${weather.temperature}, Hum=${weather.humidity}, Wind=${weather.windSpeed}, Fire=${fireCount}`);
      } catch (error) {
        console.error(`Error for ${region.name}:`, (error as Error).message);
      }
    }

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

  private async fetchFireCount(lat: number, lng: number): Promise<number> {
    const cacheKey = `nasa:fires:${lat}:${lng}`;
    const cached = await cacheService.get<number>(cacheKey);
    if (cached !== null) {
      console.log(`Cache HIT: ${cacheKey}`);
      return cached;
    }

    try {
      const area = `${lng - 2},${lat - 2},${lng + 2},${lat + 2}`;
      const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${NASA_API_KEY}/VIIRS_SNPP_NRT/${area}/1`;
      const response = await axios.get(url, { timeout: 15000 });
      const lines = (response.data as string).trim().split('\n');
      const count = Math.max(0, lines.length - 1);

      await cacheService.set(cacheKey, count, CACHE_TTL);
      return count;
    } catch {
      return 0;
    }
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

    score = Math.min(100, score);

    const drynessIndex = Math.min(100, Math.round(
      (weather.temperature / 45) * 60 + ((100 - weather.humidity) / 100) * 40
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