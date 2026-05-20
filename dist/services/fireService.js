"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const database_1 = __importDefault(require("../config/database"));
class FireService {
    // Get all fires with filtering
    async getAllFires(city, status, limit = 20, offset = 0) {
        let query = 'SELECT * FROM fires WHERE 1=1';
        const params = [];
        if (city) {
            query += ' AND city = $' + (params.length + 1);
            params.push(city);
        }
        if (status) {
            query += ' AND status = $' + (params.length + 1);
            params.push(status);
        }
        query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
        params.push(limit, offset);
        try {
            const result = await database_1.default.query(query, params);
            return result.rows;
        }
        catch (error) {
            console.error('Error fetching fires:', error);
            throw error;
        }
    }
    // Get single fire by ID
    async getFireById(id) {
        try {
            const result = await database_1.default.query('SELECT * FROM fires WHERE id = $1', [id]);
            return result.rows[0] || null;
        }
        catch (error) {
            console.error('Error fetching fire:', error);
            throw error;
        }
    }
    // Create new fire
    async createFire(data) {
        const { title, location, city, district, description, latitude, longitude, status, risk_level, severity, source_url } = data;
        try {
            const result = await database_1.default.query(`INSERT INTO fires (title, location, city, district, description, latitude, longitude, status, risk_level, severity, source_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`, [title, location, city, district, description, latitude, longitude, status, risk_level, severity, source_url]);
            return result.rows[0];
        }
        catch (error) {
            console.error('Error creating fire:', error);
            throw error;
        }
    }
    // Update fire
    async updateFire(id, data) {
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
            return this.getFireById(id);
        params.push(id);
        const query = `UPDATE fires SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramCount} RETURNING *`;
        try {
            const result = await database_1.default.query(query, params);
            return result.rows[0] || null;
        }
        catch (error) {
            console.error('Error updating fire:', error);
            throw error;
        }
    }
    // Delete fire
    async deleteFire(id) {
        try {
            const result = await database_1.default.query('DELETE FROM fires WHERE id = $1', [id]);
            return result.rowCount ? result.rowCount > 0 : false;
        }
        catch (error) {
            console.error('Error deleting fire:', error);
            throw error;
        }
    }
    // Get fires count
    async getFiresCount(city, status) {
        let query = 'SELECT COUNT(*) FROM fires WHERE 1=1';
        const params = [];
        if (city) {
            query += ' AND city = $' + (params.length + 1);
            params.push(city);
        }
        if (status) {
            query += ' AND status = $' + (params.length + 1);
            params.push(status);
        }
        try {
            const result = await database_1.default.query(query, params);
            return parseInt(result.rows[0].count, 10);
        }
        catch (error) {
            console.error('Error counting fires:', error);
            throw error;
        }
    }
}
exports.default = new FireService();
