"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const newsController_1 = __importDefault(require("../controllers/newsController"));
const router = (0, express_1.Router)();
// GET /api/news - Get all news
router.get('/', (req, res) => newsController_1.default.getAllNews(req, res));
// GET /api/news/:id - Get single news
router.get('/:id', (req, res) => newsController_1.default.getNewsById(req, res));
exports.default = router;
