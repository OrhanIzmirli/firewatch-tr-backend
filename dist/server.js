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
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const morgan_1 = __importDefault(require("morgan"));
const compression_1 = __importDefault(require("compression"));
const fires_1 = __importDefault(require("./routes/fires"));
const notifications_1 = __importDefault(require("./routes/notifications"));
const news_1 = __importDefault(require("./routes/news"));
const newsScraperJob_1 = __importDefault(require("./jobs/newsScraperJob"));
const riskCalculatorJob_1 = __importDefault(require("./jobs/riskCalculatorJob"));
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
        const result = await (await Promise.resolve().then(() => __importStar(require('./config/database')))).default.query(`
      SELECT DISTINCT ON (region) 
        region, general_risk_score, risk_level, temperature, 
        humidity, wind_speed, wind_direction, dryness_index, 
        vegetation_density, date
      FROM risk_data
      ORDER BY region, date DESC
    `);
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
