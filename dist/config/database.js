"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = require("pg");
const pool = new pg_1.Pool({
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
exports.default = pool;
