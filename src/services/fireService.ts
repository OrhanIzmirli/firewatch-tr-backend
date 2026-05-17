import pool from '../config/database';
import { Fire, ApiResponse } from '../types';

class FireService {
  // Get all fires with filtering
  async getAllFires(city?: string, status?: string, limit: number = 20, offset: number = 0): Promise<Fire[]> {
    let query = 'SELECT * FROM fires WHERE 1=1';
    const params: any[] = [];

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
      const result = await pool.query(query, params);
      return result.rows;
    } catch (error) {
      console.error('Error fetching fires:', error);
      throw error;
    }
  }

  // Get single fire by ID
  async getFireById(id: number): Promise<Fire | null> {
    try {
      const result = await pool.query('SELECT * FROM fires WHERE id = $1', [id]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('Error fetching fire:', error);
      throw error;
    }
  }

  // Create new fire
  async createFire(data: Omit<Fire, 'id' | 'created_at' | 'updated_at'>): Promise<Fire> {
    const { title, location, city, district, description, latitude, longitude, status, risk_level, severity, source_url } = data;
    
    try {
      const result = await pool.query(
        `INSERT INTO fires (title, location, city, district, description, latitude, longitude, status, risk_level, severity, source_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [title, location, city, district, description, latitude, longitude, status, risk_level, severity, source_url]
      );
      return result.rows[0];
    } catch (error) {
      console.error('Error creating fire:', error);
      throw error;
    }
  }

  // Update fire
  async updateFire(id: number, data: Partial<Fire>): Promise<Fire | null> {
    const updates: string[] = [];
    const params: any[] = [];
    let paramCount = 1;

    Object.entries(data).forEach(([key, value]) => {
      if (value !== undefined && key !== 'id' && key !== 'created_at') {
        updates.push(`${key} = $${paramCount}`);
        params.push(value);
        paramCount++;
      }
    });

    if (updates.length === 0) return this.getFireById(id);

    params.push(id);
    const query = `UPDATE fires SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramCount} RETURNING *`;

    try {
      const result = await pool.query(query, params);
      return result.rows[0] || null;
    } catch (error) {
      console.error('Error updating fire:', error);
      throw error;
    }
  }

  // Delete fire
  async deleteFire(id: number): Promise<boolean> {
    try {
      const result = await pool.query('DELETE FROM fires WHERE id = $1', [id]);
      return result.rowCount ? result.rowCount > 0 : false;
    } catch (error) {
      console.error('Error deleting fire:', error);
      throw error;
    }
  }

  // Get fires count
  async getFiresCount(city?: string, status?: string): Promise<number> {
    let query = 'SELECT COUNT(*) FROM fires WHERE 1=1';
    const params: any[] = [];

    if (city) {
      query += ' AND city = $' + (params.length + 1);
      params.push(city);
    }

    if (status) {
      query += ' AND status = $' + (params.length + 1);
      params.push(status);
    }

    try {
      const result = await pool.query(query, params);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      console.error('Error counting fires:', error);
      throw error;
    }
  }
}

export default new FireService();