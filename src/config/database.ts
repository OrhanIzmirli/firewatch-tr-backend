import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('❌ DB error:', err);
});

pool.query('SELECT NOW()').then(() => {
  console.log('✅ PostgreSQL connected');
}).catch((err) => {
  console.error('❌ DB connection failed:', err.message);
});

export default pool;