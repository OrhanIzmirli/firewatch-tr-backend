"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = require("pg");
const pool = new pg_1.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'postgres',
    ssl: { rejectUnauthorized: false },
});
pool.on('connect', (client) => {
    client.query('SET search_path TO public');
});
pool.on('error', (err) => {
    console.error('❌ Unexpected database error:', err);
});
pool.query('SELECT NOW()', (err, result) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
    }
    else {
        console.log('✅ PostgreSQL connected');
    }
});
exports.default = pool;
