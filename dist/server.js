"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require('dotenv').config();
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const morgan_1 = __importDefault(require("morgan"));
const compression_1 = __importDefault(require("compression"));
const fires_1 = __importDefault(require("./routes/fires"));
const notifications_1 = __importDefault(require("./routes/notifications"));
const news_1 = __importDefault(require("./routes/news"));
const feedback_1 = __importDefault(require("./routes/feedback"));
const newsScraperJob_1 = __importStar(require("./jobs/newsScraperJob"));
const riskCalculatorJob_1 = __importDefault(require("./jobs/riskCalculatorJob"));
const cacheService_1 = __importDefault(require("./services/cacheService"));
const database_1 = __importDefault(require("./config/database"));
const app = (0, express_1.default)();
const PORT = process.env.PORT || 5000;
app.use((0, cors_1.default)());
// Default 100kb is too small for base64-encoded fire report photos.
app.use(express_1.default.json({ limit: '15mb' }));
app.use((0, morgan_1.default)('dev'));
app.use((0, compression_1.default)());
app.use('/api/fires', fires_1.default);
app.use('/api/news', news_1.default);
app.use('/api/notify', notifications_1.default);
app.use('/api/feedback', feedback_1.default);
app.get('/api/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        message: 'FireWatch TR backend is running',
        timestamp: new Date().toISOString(),
    });
});
// Admin endpoint'lerini token ile koru — ADMIN_TOKEN env'de yoksa erişim kapalı
function requireAdminToken(req, res, next) {
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
        await newsScraperJob_1.default.runScraper();
        res.json({ status: 'success', message: 'Scraper completed' });
    }
    catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});
// Manuel risk hesaplama tetikleyici
app.get('/api/admin/risk', requireAdminToken, async (req, res) => {
    try {
        console.log('🔧 Manual risk calculation triggered');
        await riskCalculatorJob_1.default.runCalculator();
        res.json({ status: 'success', message: 'Risk calculation completed' });
    }
    catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
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
        const rows = await database_1.default.query('SELECT id, title, summary FROM news');
        const toDelete = [];
        for (const row of rows.rows) {
            const fullText = `${row.title} ${row.summary || ''}`;
            if (!(0, newsScraperJob_1.checkRelevance)(row.title, fullText).relevant) {
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
            await database_1.default.query('DELETE FROM news WHERE id = ANY($1)', [toDelete]);
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
    }
    catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});
// Risk verisi endpoint
app.get('/api/risk/summary', async (req, res) => {
    try {
        const cacheKey = 'risk:summary';
        const cached = await cacheService_1.default.get(cacheKey);
        if (cached) {
            res.json({ status: 'success', data: cached });
            return;
        }
        // NOTE: ordered by created_at, not date. risk_data.date is a DATE
        // column (day precision only), but the calculator runs twice a day —
        // two same-day rows tie on date with no reliable tiebreaker, so
        // "ORDER BY date DESC" could serve either run. created_at is a full
        // TIMESTAMP (DEFAULT CURRENT_TIMESTAMP) and always distinguishes them.
        const result = await database_1.default.query(`
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
        await cacheService_1.default.set(cacheKey, result.rows, 300); // calculator runs every 3h, 5 min cache is safe
        res.json({ status: 'success', data: result.rows });
    }
    catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});
app.use((err, req, res, next) => {
    console.error('Server Error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
});
// Lightweight self-healing migration — this project has no formal migration
// runner, so schema additions to tables that already exist in production
// (like fire_reports) are applied here on startup rather than relying on
// schema.sql, which Postgres only executes on first container init.
async function runStartupMigrations() {
    try {
        await database_1.default.query(`ALTER TABLE fire_reports ADD COLUMN IF NOT EXISTS photo_urls TEXT[] DEFAULT '{}'`);
        await database_1.default.query(`CREATE TABLE IF NOT EXISTS feedback (
      id SERIAL PRIMARY KEY,
      rating INTEGER,
      category VARCHAR(50),
      message TEXT,
      email VARCHAR(255),
      app_version VARCHAR(20),
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    }
    catch (error) {
        console.error('Startup migration failed:', error.message);
    }
}
newsScraperJob_1.default.start();
riskCalculatorJob_1.default.start();
console.log('Background jobs started');
runStartupMigrations();
app.listen(PORT, () => {
    console.log(`FireWatch TR backend running on port ${PORT}`);
});
