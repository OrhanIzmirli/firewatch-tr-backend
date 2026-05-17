import { Router } from 'express';
import newsController from '../controllers/newsController';

const router = Router();

// GET /api/news - Get all news
router.get('/', (req, res) => newsController.getAllNews(req, res));

// GET /api/news/:id - Get single news
router.get('/:id', (req, res) => newsController.getNewsById(req, res));

export default router;