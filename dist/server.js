"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const morgan_1 = __importDefault(require("morgan"));
const compression_1 = __importDefault(require("compression"));
const fires_1 = __importDefault(require("./routes/fires"));
const notifications_1 = __importDefault(require("./routes/notifications"));
const news_1 = __importDefault(require("./routes/news"));
const newsScraperJob_1 = __importDefault(require("./jobs/newsScraperJob"));
const riskCalculatorJob_1 = __importDefault(require("./jobs/riskCalculatorJob"));
const cacheService_1 = __importDefault(require("./services/cacheService"));
const database_1 = __importDefault(require("./config/database"));
require('dotenv').config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 5000;
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use((0, morgan_1.default)('dev'));
app.use((0, compression_1.default)());
app.use('/api/fires', fires_1.default);
app.use('/api/news', news_1.default);
app.use('/api/notify', notifications_1.default);
app.get('/api/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        message: 'FireWatch TR backend is running',
        timestamp: new Date().toISOString(),
    });
});
// Manuel scraper tetikleyici
app.get('/api/admin/scrape', async (req, res) => {
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
app.get('/api/admin/risk', async (req, res) => {
    try {
        console.log('🔧 Manual risk calculation triggered');
        await riskCalculatorJob_1.default.runCalculator();
        res.json({ status: 'success', message: 'Risk calculation completed' });
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
        const result = await database_1.default.query(`
      SELECT DISTINCT ON (region)
        region, general_risk_score, risk_level, temperature,
        humidity, wind_speed, wind_direction, dryness_index,
        vegetation_density, date
      FROM risk_data
      ORDER BY region, date DESC
    `);
        await cacheService_1.default.set(cacheKey, result.rows, 300); // calculator runs every 12h, 5 min cache is safe
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
newsScraperJob_1.default.start();
riskCalculatorJob_1.default.start();
console.log('Background jobs started');
app.listen(PORT, () => {
    console.log(`FireWatch TR backend running on port ${PORT}`);
});
