"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const security_1 = require("../middleware/security");
const router = (0, express_1.Router)();
const FILE = path_1.default.join(process.cwd(), 'public', 'nature', 'facts.json');
/**
 * GET /api/nature/facts: the "Did you know?" pool. Every entry was checked
 * against the page it links to (FACTS-DOGRULAMA.md in the app repo). Lives
 * in a file so facts can be added with a backend deploy and no app update.
 */
router.get('/facts', (0, security_1.rateLimit)('nature-facts', 60, 60000), async (_req, res) => {
    try {
        const facts = JSON.parse(await fs_1.promises.readFile(FILE, 'utf8'));
        res.set('Cache-Control', 'public, max-age=3600');
        res.json({ status: 'success', data: facts });
    }
    catch (error) {
        console.error('nature facts failed:', error.message);
        res.status(503).json({ status: 'error', code: 'facts_unavailable' });
    }
});
exports.default = router;
