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
import { rateLimit, requireAdminToken as secureAdminToken, securityHeaders } from './middleware/security';
import newsScraperJob, { checkRelevance } from './jobs/newsScraperJob';
import riskCalculatorJob from './jobs/riskCalculatorJob';
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

app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'FireWatch TR backend is running',
    timestamp: new Date().toISOString(),
  });
});

app.get('/privacy', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FireWatch TR — Privacy Policy</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 720px; margin: 0 auto; padding: 32px 20px 80px; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 26px; margin-bottom: 4px; }
  h2 { font-size: 18px; margin-top: 32px; }
  .updated { color: #666; font-size: 14px; margin-bottom: 32px; }
  ul { padding-left: 20px; }
  a { color: #d84315; }
</style>
</head>
<body>
<h1>FireWatch TR — Privacy Policy</h1>
<p class="updated">Last updated: 2026</p>

<p>FireWatch TR ("the app") shows wildfire and thermal-anomaly information for Turkey using NASA satellite data. This page explains what data the app collects and how it's used.</p>

<h2>Location data</h2>
<p>With your permission, the app uses your device's location to show nearby fire detections and, optionally, to run periodic background checks that can alert you to fires near you. Location data is used only to compute distance to known detections — it is not sold, shared with advertisers, or used for tracking. Background location access is entirely optional and requires a separate, explicit opt-in inside the app.</p>

<h2>NASA fire/thermal data</h2>
<p>Fire and thermal-anomaly data comes from NASA's FIRMS (Fire Information for Resource Management System) service. This data is public satellite information and is not linked to your identity.</p>

<h2>Feedback and reports</h2>
<p>If you submit feedback or report a fire, we store what you provide (message, optional email/photo, and app version) to review and improve the app. Providing an email is optional and used only if we need to follow up with you.</p>

<h2>Notifications</h2>
<p>If you enable push notifications, we store a device token (via Firebase Cloud Messaging) solely to deliver fire alerts to your device.</p>

<h2>What we don't do</h2>
<ul>
  <li>We do not sell personal data to third parties.</li>
  <li>We do not use your data for advertising.</li>
  <li>We do not require an account or collect names, contacts, or identity documents.</li>
</ul>

<h2>Data retention</h2>
<p>Location data is not stored — it is used in-memory for a single distance calculation and discarded. Feedback and fire reports are retained to help operate and improve the service.</p>

<h2>Contact</h2>
<p>Questions about this policy or your data can be sent to <a href="mailto:rhn23lk@gmail.com">rhn23lk@gmail.com</a>.</p>
</body>
</html>`);
});

app.get('/terms', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FireWatch TR — Terms of Service</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 720px; margin: 0 auto; padding: 32px 20px 80px; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 26px; margin-bottom: 4px; }
  h2 { font-size: 18px; margin-top: 32px; }
  .updated { color: #666; font-size: 14px; margin-bottom: 32px; }
</style>
</head>
<body>
<h1>FireWatch TR — Terms of Service</h1>
<p class="updated">Last updated: 2026</p>

<p>By using FireWatch TR, you agree to the following:</p>

<h2>Informational purposes only</h2>
<p>FireWatch TR displays satellite-derived thermal anomaly data as informational guidance. It is <strong>not</strong> an official emergency warning system and must not be relied on as your sole source of safety information during a wildfire or other emergency. Always follow official guidance from AFAD, local authorities, and emergency services.</p>

<h2>Data accuracy</h2>
<p>Fire/thermal detections come from NASA FIRMS and may be delayed, incomplete, or include false positives (e.g. industrial heat sources). We make no guarantee of accuracy, completeness, or timeliness.</p>

<h2>User-submitted content</h2>
<p>Fire reports and feedback you submit should be accurate and not abusive, illegal, or spam. We may remove content that violates this.</p>

<h2>No warranty</h2>
<p>The app is provided "as is" without warranty of any kind. We are not liable for decisions made based on information shown in the app.</p>

<h2>Contact</h2>
<p>Questions about these terms can be sent to <a href="mailto:rhn23lk@gmail.com">rhn23lk@gmail.com</a>.</p>
</body>
</html>`);
});

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
  console.log('Background jobs started');
}

runStartupMigrations();

app.listen(PORT, () => {
  console.log(`FireWatch TR backend running on port ${PORT}`);
});
