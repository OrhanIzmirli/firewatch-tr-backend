require('dotenv').config();

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import compression from 'compression';
import fireRoutes from './routes/fires';
import notificationRoutes from './routes/notifications';
import newsRoutes from './routes/news';
import feedbackRoutes from './routes/feedback';
import thermalRoutes from './routes/thermal';
import incidentRoutes from './routes/incidents';
import legalRoutes from './routes/legal';
import { rateLimit, requireAdminToken as secureAdminToken, securityHeaders } from './middleware/security';
import newsScraperJob, { checkRelevance } from './jobs/newsScraperJob';
import riskCalculatorJob from './jobs/riskCalculatorJob';
import fireIngestJob from './jobs/fireIngestJob';
import fireClusterJob from './jobs/fireClusterJob';
import cacheService from './services/cacheService';
import pool from './config/database';

const app = express();
const PORT = process.env.PORT || 5000;

app.set('trust proxy', 1);
const configuredOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const developmentOrigins = process.env.NODE_ENV === 'production'
  ? []
  : ['http://127.0.0.1:7359', 'http://127.0.0.1:7360', 'http://localhost:7359', 'http://localhost:7360'];
const allowedOrigins = new Set([...configuredOrigins, ...developmentOrigins]);

app.use(securityHeaders);
app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.has(origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Token'],
  maxAge: 86400,
}));
app.use(rateLimit('global', 300, 60_000));
// Default 100kb is too small for base64-encoded fire report photos.
app.use(express.json({ limit: '10mb', type: 'application/json' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(compression());

app.use('/api/fires', fireRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/notify', notificationRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/thermal', thermalRoutes);
app.use('/api/incidents', incidentRoutes);

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'FireWatch TR backend is running',
    timestamp: new Date().toISOString(),
  });
});

app.use(legalRoutes);

// Admin endpoint'lerini token ile koru — ADMIN_TOKEN env'de yoksa erişim kapalı
// Manuel scraper tetikleyici
app.get('/api/admin/scrape', secureAdminToken, async (req, res) => {
  try {
    console.log('🔧 Manual scrape triggered');
    await newsScraperJob.runScraper();
    res.json({ status: 'success', message: 'Scraper completed' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Admin operation failed' });
  }
});

// Manuel risk hesaplama tetikleyici
app.get('/api/admin/risk', secureAdminToken, async (req, res) => {
  try {
    console.log('🔧 Manual risk calculation triggered');
    await riskCalculatorJob.runCalculator();
    res.json({ status: 'success', message: 'Risk calculation completed' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Admin operation failed' });
  }
});

// Manuel FIRMS tespit ingest tetikleyici
app.get('/api/admin/ingest-fires', secureAdminToken, async (req, res) => {
  try {
    console.log('🔧 Manual fire ingest triggered');
    const stats = await fireIngestJob.runIngest();
    const clustering = await fireClusterJob.runClustering();
    res.json({ status: 'success', data: { ingest: stats, clustering } });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Admin operation failed' });
  }
});

// Removes existing news rows that fail the current relevance filter — for
// cleaning up articles that were saved by an older/looser filter version.
// Reuses the exact same checkRelevance() the live scraper runs, so this
// never drifts out of sync with whatever the filter currently considers
// relevant. Defaults to a dry run (counts only); pass ?confirm=true to
// actually delete, since this is irreversible.
app.get('/api/admin/clean-news', secureAdminToken, async (req, res) => {
  try {
    const confirm = req.query.confirm === 'true';
    const rows = await pool.query('SELECT id, title, summary FROM news');
    const toDelete: number[] = [];
    for (const row of rows.rows) {
      const fullText = `${row.title} ${row.summary || ''}`;
      if (!checkRelevance(row.title, fullText).relevant) {
        toDelete.push(row.id);
      }
    }

    if (!confirm) {
      res.json({
        status: 'success',
        dryRun: true,
        message: `${toDelete.length} of ${rows.rows.length} rows would be deleted. Pass ?confirm=true to actually delete.`,
        wouldDeleteCount: toDelete.length,
        totalCount: rows.rows.length,
      });
      return;
    }

    if (toDelete.length > 0) {
      await pool.query('DELETE FROM news WHERE id = ANY($1)', [toDelete]);
    }
    // Note: /api/news responses are cached per (category, limit, offset)
    // with a short TTL — no single key to invalidate here, but it expires
    // on its own within a few minutes.
    res.json({
      status: 'success',
      dryRun: false,
      message: `Deleted ${toDelete.length} of ${rows.rows.length} rows.`,
      deletedCount: toDelete.length,
      totalCount: rows.rows.length,
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Admin operation failed' });
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

    // NOTE: ordered by created_at, not date. risk_data.date is a DATE
    // column (day precision only), but the calculator runs twice a day —
    // two same-day rows tie on date with no reliable tiebreaker, so
    // "ORDER BY date DESC" could serve either run. created_at is a full
    // TIMESTAMP (DEFAULT CURRENT_TIMESTAMP) and always distinguishes them.
    const result = await pool.query(`
      SELECT DISTINCT ON (r1.region)
        r1.region, r1.general_risk_score, r1.risk_level, r1.temperature,
        r1.humidity, r1.wind_speed, r1.wind_direction, r1.dryness_index,
        r1.vegetation_density, r1.date, r1.created_at,
        (
          SELECT r2.general_risk_score FROM risk_data r2
          WHERE r2.region = r1.region AND r2.created_at < r1.created_at
          ORDER BY r2.created_at DESC LIMIT 1
        ) AS previous_risk_score
      FROM risk_data r1
      ORDER BY r1.region, r1.created_at DESC
    `);

    await cacheService.set(cacheKey, result.rows, 300); // calculator runs every 3h, 5 min cache is safe
    res.json({ status: 'success', data: result.rows });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Risk data unavailable' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Server Error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Lightweight self-healing migration — this project has no formal migration
// runner, so schema additions to tables that already exist in production
// (like fire_reports) are applied here on startup rather than relying on
// schema.sql, which Postgres only executes on first container init.
async function runStartupMigrations() {
  try {
    await pool.query(`ALTER TABLE fire_reports ADD COLUMN IF NOT EXISTS photo_urls TEXT[] DEFAULT '{}'`);
    await pool.query(`CREATE TABLE IF NOT EXISTS feedback (
      id SERIAL PRIMARY KEY,
      rating INTEGER,
      category VARCHAR(50),
      message TEXT,
      email VARCHAR(255),
      app_version VARCHAR(20),
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  } catch (error) {
    console.error('Startup migration failed:', (error as Error).message);
  }
}

if (process.env.DISABLE_BACKGROUND_JOBS !== 'true') {
  newsScraperJob.start();
  riskCalculatorJob.start();
  // Skips itself until migration 002 has been applied, so deploying this
  // before running the migration is harmless.
  fireIngestJob.start();
  console.log('Background jobs started');
}

runStartupMigrations();

app.listen(PORT, () => {
  console.log(`FireWatch TR backend running on port ${PORT}`);
});
