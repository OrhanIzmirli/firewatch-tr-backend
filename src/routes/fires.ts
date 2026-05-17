import { Router } from 'express';
import fireController from '../controllers/fireController';

const router = Router();

// GET /api/fires - Get all fires
router.get('/', (req, res) => fireController.getAllFires(req, res));

// GET /api/fires/:id - Get single fire
router.get('/:id', (req, res) => fireController.getFireById(req, res));

// POST /api/fires - Create fire
router.post('/', (req, res) => fireController.createFire(req, res));

export default router;