import pool from '../config/database';
import { News } from '../types';

// Jaccard similarity over word tokens — catches near-duplicate titles that
// differ only by a repeated/dropped word or minor punctuation (the same
// story re-published with a slightly edited headline, or an RSS glitch
// that duplicates a word), which a simple source_id/source_url uniqueness
// check doesn't catch since those come from different underlying URLs.
function titleSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    s.toLowerCase().trim().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersection++;
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const DUPLICATE_TITLE_THRESHOLD = 0.8;

class NewsService {
  async getAllNews(category?: string, limit: number = 20, offset: number = 0): Promise<News[]> {
    let query = 'SELECT * FROM news WHERE 1=1';
    const params: any[] = [];

    if (category) {
      query += ' AND category = $' + (params.length + 1);
      params.push(category);
    }

    query += ' ORDER BY published_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(limit, offset);

    try {
      console.log('📰 Executing query:', query, params);
      const result = await Promise.race([
        pool.query(query, params),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Query timeout after 8s')), 8000)
        ),
      ]) as any;
      console.log('📰 Query result rows:', result.rows.length);
      return result.rows;
    } catch (error) {
      console.error('❌ Error fetching news:', error);
      throw error;
    }
  }

  async getNewsById(id: number): Promise<News | null> {
    try {
      console.log('📰 getNewsById:', id);
      const result = await Promise.race([
        pool.query('SELECT * FROM news WHERE id = $1', [id]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Query timeout after 8s')), 8000)
        ),
      ]) as any;
      return result.rows[0] || null;
    } catch (error) {
      console.error('❌ Error fetching news by id:', error);
      throw error;
    }
  }

  // returns null when the row already exists (source_id/source_url conflict,
  // or a near-duplicate title within the last 3 days) instead of throwing
  async createNews(data: Omit<News, 'id' | 'created_at'>): Promise<News | null> {
    const {
      title, summary, body, source, source_url, source_id,
      category, is_breaking, published_at, read_minutes,
      related_region, highlights, paragraphs,
    } = data;

    try {
      const recent = await pool.query(
        `SELECT title FROM news WHERE created_at > NOW() - INTERVAL '3 days' ORDER BY created_at DESC LIMIT 200`
      );
      const isDuplicateTitle = recent.rows.some(
        (row: { title: string }) => titleSimilarity(title, row.title) >= DUPLICATE_TITLE_THRESHOLD
      );
      if (isDuplicateTitle) {
        return null;
      }

      const result = await pool.query(
        `INSERT INTO news
          (title, summary, body, source, source_url, source_id, category, is_breaking, published_at, read_minutes, related_region, highlights, paragraphs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          title, summary, body, source, source_url, source_id,
          category, is_breaking || false, published_at,
          read_minutes, related_region,
          highlights || [], paragraphs || [],
        ]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error('❌ Error creating news:', error);
      throw error;
    }
  }

  async updateNews(id: number, data: Partial<News>): Promise<News | null> {
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

    if (updates.length === 0) return this.getNewsById(id);

    params.push(id);
    const query = `UPDATE news SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;

    try {
      const result = await pool.query(query, params);
      return result.rows[0] || null;
    } catch (error) {
      console.error('❌ Error updating news:', error);
      throw error;
    }
  }

  async deleteNews(id: number): Promise<boolean> {
    try {
      const result = await pool.query('DELETE FROM news WHERE id = $1', [id]);
      return result.rowCount ? result.rowCount > 0 : false;
    } catch (error) {
      console.error('❌ Error deleting news:', error);
      throw error;
    }
  }

  async getNewsCount(category?: string): Promise<number> {
    let query = 'SELECT COUNT(*) FROM news WHERE 1=1';
    const params: any[] = [];

    if (category) {
      query += ' AND category = $' + (params.length + 1);
      params.push(category);
    }

    try {
      const result = await Promise.race([
        pool.query(query, params),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Count timeout after 8s')), 8000)
        ),
      ]) as any;
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      console.error('❌ Error counting news:', error);
      throw error;
    }
  }
}

export default new NewsService();