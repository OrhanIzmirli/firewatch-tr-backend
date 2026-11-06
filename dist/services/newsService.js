"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const database_1 = __importDefault(require("../config/database"));
const turkishText_1 = require("../utils/turkishText");
const newsSourceLogos_1 = require("../utils/newsSourceLogos");
const newsRelevance_1 = require("../utils/newsRelevance");
// Jaccard similarity over word tokens — catches near-duplicate titles that
// differ only by a repeated/dropped word or minor punctuation (the same
// story re-published with a slightly edited headline, or an RSS glitch
// that duplicates a word), which a simple source_id/source_url uniqueness
// check doesn't catch since those come from different underlying URLs.
function titleSimilarity(a, b) {
    const tokenize = (s) => (0, turkishText_1.turkishToLower)(s).trim().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);
    const tokensA = new Set(tokenize(a));
    const tokensB = new Set(tokenize(b));
    if (tokensA.size === 0 || tokensB.size === 0)
        return 0;
    let intersection = 0;
    for (const t of tokensA)
        if (tokensB.has(t))
            intersection++;
    const union = tokensA.size + tokensB.size - intersection;
    return union === 0 ? 0 : intersection / union;
}
const DUPLICATE_TITLE_THRESHOLD = 0.8;
function withTimeout(promise, message, ms = 8000) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
class NewsService {
    /**
     * Feed page of news, newest first. Rows that fail the current relevance
     * filter (utils/newsRelevance.ts) — stored under an older, looser filter —
     * stay in the table but are left out, and limit/offset count relevant
     * rows only. Titles and summaries are filtered first; full rows are
     * fetched for the page alone.
     */
    async getAllNews(category, limit = 20, offset = 0) {
        try {
            const candidates = await withTimeout(database_1.default.query(`SELECT id, title, summary FROM news
            WHERE ($1::text IS NULL OR category = $1)
            ORDER BY published_at DESC NULLS LAST, id DESC`, [category ?? null]), 'Query timeout after 8s');
            const ids = (0, newsRelevance_1.relevantPageIds)(candidates.rows, limit, offset);
            if (ids.length === 0)
                return [];
            const result = await withTimeout(database_1.default.query('SELECT * FROM news WHERE id = ANY($1::int[])', [ids]), 'Query timeout after 8s');
            const byId = new Map(result.rows.map((r) => [r.id, r]));
            return ids
                .map((id) => byId.get(id))
                .filter((r) => r !== undefined)
                .map(newsSourceLogos_1.withSourceLogo);
        }
        catch (error) {
            console.error('❌ Error fetching news:', error);
            throw error;
        }
    }
    async getNewsById(id) {
        try {
            console.log('📰 getNewsById:', id);
            const result = await Promise.race([
                database_1.default.query('SELECT * FROM news WHERE id = $1', [id]),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Query timeout after 8s')), 8000)),
            ]);
            return result.rows[0] ? (0, newsSourceLogos_1.withSourceLogo)(result.rows[0]) : null;
        }
        catch (error) {
            console.error('❌ Error fetching news by id:', error);
            throw error;
        }
    }
    // returns null when the row already exists (source_id/source_url conflict,
    // or a near-duplicate title within the last 3 days) instead of throwing
    async createNews(data) {
        const { title, summary, body, source, source_url, source_id, category, is_breaking, published_at, read_minutes, related_region, highlights, paragraphs, } = data;
        try {
            const recent = await database_1.default.query(`SELECT title FROM news WHERE created_at > NOW() - INTERVAL '3 days' ORDER BY created_at DESC LIMIT 200`);
            const isDuplicateTitle = recent.rows.some((row) => titleSimilarity(title, row.title) >= DUPLICATE_TITLE_THRESHOLD);
            if (isDuplicateTitle) {
                return null;
            }
            const result = await database_1.default.query(`INSERT INTO news
          (title, summary, body, source, source_url, source_id, category, is_breaking, published_at, read_minutes, related_region, highlights, paragraphs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT DO NOTHING
         RETURNING *`, [
                title, summary, body, source, source_url, source_id,
                category, is_breaking || false, published_at,
                read_minutes, related_region,
                highlights || [], paragraphs || [],
            ]);
            return result.rows[0] || null;
        }
        catch (error) {
            console.error('❌ Error creating news:', error);
            throw error;
        }
    }
    async updateNews(id, data) {
        const updates = [];
        const params = [];
        let paramCount = 1;
        Object.entries(data).forEach(([key, value]) => {
            if (value !== undefined && key !== 'id' && key !== 'created_at') {
                updates.push(`${key} = $${paramCount}`);
                params.push(value);
                paramCount++;
            }
        });
        if (updates.length === 0)
            return this.getNewsById(id);
        params.push(id);
        const query = `UPDATE news SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;
        try {
            const result = await database_1.default.query(query, params);
            return result.rows[0] || null;
        }
        catch (error) {
            console.error('❌ Error updating news:', error);
            throw error;
        }
    }
    async deleteNews(id) {
        try {
            const result = await database_1.default.query('DELETE FROM news WHERE id = $1', [id]);
            return result.rowCount ? result.rowCount > 0 : false;
        }
        catch (error) {
            console.error('❌ Error deleting news:', error);
            throw error;
        }
    }
    /** Number of news items in the feed: same relevance filter as getAllNews. */
    async getNewsCount(category) {
        try {
            const result = await withTimeout(database_1.default.query('SELECT title, summary FROM news WHERE ($1::text IS NULL OR category = $1)', [category ?? null]), 'Count timeout after 8s');
            return result.rows.filter(newsRelevance_1.isInFiresFeed).length;
        }
        catch (error) {
            console.error('❌ Error counting news:', error);
            throw error;
        }
    }
}
exports.default = new NewsService();
