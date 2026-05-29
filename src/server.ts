import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import compression from 'compression';
import fireRoutes from './routes/fires';
import notificationRoutes from './routes/notifications';
import newsRoutes from './routes/news';
import newsScraperJob from './jobs/newsScraperJob';
import riskCalculatorJob from './jobs/riskCalculatorJob';

require('dotenv').config();

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

// Manuel scraper tetikleyici
app.get('/api/admin/scrape', async (req, res) => {
  try {
    console.log('🔧 Manual scrape triggered');
    await newsScraperJob.runScraper();
    res.json({ status: 'success', message: 'Scraper completed' });
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