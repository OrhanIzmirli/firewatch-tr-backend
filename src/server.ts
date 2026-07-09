require('dotenv').config();

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import compression from 'compression';
import fireRoutes from './routes/fires';
import notificationRoutes from './routes/notifications';
import newsRoutes from './routes/news';
import newsScraperJob, { checkRelevance } from './jobs/newsScraperJob';
import riskCalculatorJob from './jobs/riskCalculatorJob';
import cacheService from './services/cacheService';
import pool from './config/database';

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
// Default 100kb is too small for base64-encoded fire report photos.
app.use(express.json({ limit: '15mb' }));
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

// Removes existing news rows that fail the current relevance filter — for
// cleaning up articles that were saved by an older/looser filter version.
// Reuses the exact same checkRelevance() the live scraper runs, so this
// never drifts out of sync with whatever the filter currently considers
// relevant. Defaults to a dry run (counts only); pass ?confirm=true to
// actually delete, since this is irreversible.
app.get('/api/admin/clean-news', requireAdminToken, async (req, res) => {
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

// Lightweight self-healing migration — this project has no formal migration
// runner, so schema additions to tables that already exist in production
// (like fire_reports) are applied here on startup rather than relying on
// schema.sql, which Postgres only executes on first container init.
async function runStartupMigrations() {
  try {
    await pool.query(`ALTER TABLE fire_reports ADD COLUMN IF NOT EXISTS photo_urls TEXT[] DEFAULT '{}'`);
  } catch (error) {
    console.error('Startup migration failed:', (error as Error).message);
  }
}

newsScraperJob.start();
riskCalculatorJob.start();
console.log('Background jobs started');

runStartupMigrations();

app.listen(PORT, () => {
  console.log(`FireWatch TR backend running on port ${PORT}`);
});