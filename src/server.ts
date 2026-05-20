import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import compression from 'compression';
import fireRoutes from './routes/fires';
import notificationRoutes from './routes/notifications';
import newsRoutes from './routes/news';

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
app.use(compression());

// Routes
app.use('/api/fires', fireRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/notify', notificationRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'FireWatch TR backend is running',
    timestamp: new Date().toISOString(),
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
  });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Server Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
  });
});

app.listen(PORT, () => {
  console.log(` FireWatch TR backend running on port ${PORT}`);
});