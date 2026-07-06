require('dotenv').config();

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import compression from 'compression';
import fireRoutes from './routes/fires';
import notificationRoutes from './routes/notifications';
import newsRoutes from './routes/news';
import newsScraperJob from './jobs/newsScraperJob';
import riskCalculatorJob from './jobs/riskCalculatorJob';
import cacheService from './services/cacheService';
import pool from './config/database';

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
app.use(compression());

app.use('/api/fires', fireRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/notify', notificationRoutes);

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'FireWatch TR backend is running',
    timestamp: new Date().toISOString(),
  });
});

// Admin endpoint'lerini token ile koru — ADMIN_TOKEN env'de yoksa erişim kapalı
function requireAdminToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    res.status(503).json({ status: 'error', message: 'Admin endpoint disabled: ADMIN_TOKEN not configured' });
    return;
  }
  if (req.query.token !== adminToken) {
    res.status(401).json({ status: 'error', message: 'Invalid or missing token' });
    return;
  }
  next();
}

// Manuel scraper tetikleyici
app.get('/api/admin/scrape', requireAdminToken, async (req, res) => {
  try {
    console.log('🔧 Manual scrape triggered');
    await newsScraperJob.runScraper();
    res.json({ status: 'success', message: 'Scraper completed' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: (error as Error).message });
  }
});

// Manuel risk hesaplama tetikleyici
app.get('/api/admin/risk', requireAdminToken, async (req, res) => {
  try {
    console.log('🔧 Manual risk calculation triggered');
    await riskCalculatorJob.runCalculator();
    res.json({ status: 'success', message: 'Risk calculation completed' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: (error as Error).message });
  }
});

// Risk verisi endpoint
app.get('/api/risk/summary', async (req, res) => {
  try {
    const cacheKey = 'risk:summary';
    const cached = await cacheService.get<any[]>(cacheKey);
    if (cached) {
      res.json({ status: 'success', data: cached });
      return;
    }

    const result = await pool.query(`
      SELECT DISTINCT ON (region)
        region, general_risk_score, risk_level, temperature,
        humidity, wind_speed, wind_direction, dryness_index,
        vegetation_density, date
      FROM risk_data
      ORDER BY region, date DESC
    `);

    await cacheService.set(cacheKey, result.rows, 300); // calculator runs every 12h, 5 min cache is safe
    res.json({ status: 'success', data: result.rows });
  } catch (error) {
    res.status(500).json({ status: 'error', message: (error as Error).message });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Server Error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

newsScraperJob.start();
riskCalculatorJob.start();
console.log('Background jobs started');

app.listen(PORT, () => {
  console.log(`FireWatch TR backend running on port ${PORT}`);
});