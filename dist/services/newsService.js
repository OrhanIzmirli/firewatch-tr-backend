"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const database_1 = __importDefault(require("../config/database"));
class NewsService {
    async getAllNews(category, limit = 20, offset = 0) {
        let query = 'SELECT * FROM news WHERE 1=1';
        const params = [];
        if (category) {
            query += ' AND category = $' + (params.length + 1);
            params.push(category);
        }
        query += ' ORDER BY published_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
        params.push(limit, offset);
        try {
            console.log('📰 Executing query:', query, params);
            const result = await Promise.race([
                database_1.default.query(query, params),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Query timeout after 8s')), 8000)),
            ]);
            console.log('📰 Query result rows:', result.rows.length);
            return result.rows;
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
            return result.rows[0] || null;
        }
        catch (error) {
            console.error('❌ Error fetching news by id:', error);
            throw error;
        }
    }
    // returns null when the row already exists (source_id/source_url conflict) instead of throwing
    async createNews(data) {
        const { title, summary, body, source, source_url, source_id, category, is_breaking, published_at, read_minutes, related_region, highlights, paragraphs, } = data;
        try {
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
    async getNewsCount(category) {
        let query = 'SELECT COUNT(*) FROM news WHERE 1=1';
        const params = [];
        if (category) {
            query += ' AND category = $' + (params.length + 1);
            params.push(category);
        }
        try {
            const result = await Promise.race([
                database_1.default.query(query, params),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Count timeout after 8s')), 8000)),
            ]);
            return parseInt(result.rows[0].count, 10);
        }
        catch (error) {
            console.error('❌ Error counting news:', error);
            throw error;
        }
    }
}
exports.default = new NewsService();
