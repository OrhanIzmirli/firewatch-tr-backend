"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const fireController_1 = __importDefault(require("../controllers/fireController"));
const router = (0, express_1.Router)();
// GET /api/fires - Get all fires
router.get('/', (req, res) => fireController_1.default.getAllFires(req, res));
// GET /api/fires/:id - Get single fire
router.get('/:id', (req, res) => fireController_1.default.getFireById(req, res));
// POST /api/fires - Create fire
router.post('/', (req, res) => fireController_1.default.createFire(req, res));
exports.default = router;
