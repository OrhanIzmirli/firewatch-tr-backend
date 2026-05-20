"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pg_1 = require("pg");
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER || 'firewatch_user',
    password: process.env.DB_PASSWORD || 'firewatch_password_123',
    database: process.env.DB_NAME || 'firewatch_db',
};
const pool = new pg_1.Pool(dbConfig);
// Handle connection errors
pool.on('error', (err) => {
    console.error('❌ Unexpected database error:', err);
});
// Test connection
pool.query('SELECT NOW()', (err, result) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
    }
    else {
        console.log('✅ PostgreSQL connected');
    }
});
exports.default = pool;
