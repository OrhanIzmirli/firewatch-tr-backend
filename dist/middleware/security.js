"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.consumeRateLimit = consumeRateLimit;
exports.rateLimit = rateLimit;
exports.requireAdminToken = requireAdminToken;
exports.securityHeaders = securityHeaders;
const crypto_1 = __importDefault(require("crypto"));
const buckets = new Map();
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now)
            buckets.delete(key);
    }
}, 10 * 60000);
cleanupTimer.unref();
/// Shared in-memory sliding-window counter behind both the rateLimit()
/// middleware and any ad-hoc, request-body-dependent checks (e.g. feedback's
/// per-category limit, which isn't known until the body is parsed and so
/// can't be a fixed router-level middleware). Resets on process restart —
/// an accepted tradeoff at this app's scale, same as the rest of this file.
function consumeRateLimit(key, max, windowMs) {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        return true;
    }
    bucket.count += 1;
    return bucket.count <= max;
}
function rateLimit(name, max, windowMs) {
    return (req, res, next) => {
        const now = Date.now();
        const key = `${name}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
        const bucket = buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            buckets.set(key, { count: 1, resetAt: now + windowMs });
            next();
            return;
        }
        bucket.count += 1;
        res.setHeader('RateLimit-Limit', max.toString());
        res.setHeader('RateLimit-Remaining', Math.max(0, max - bucket.count).toString());
        res.setHeader('RateLimit-Reset', Math.ceil(bucket.resetAt / 1000).toString());
        if (bucket.count > max) {
            res.status(429).json({ status: 'error', message: 'Too many requests' });
            return;
        }
        next();
    };
}
function safeEqual(left, right) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && crypto_1.default.timingSafeEqual(a, b);
}
function requireAdminToken(req, res, next) {
    const expected = process.env.ADMIN_TOKEN;
    if (!expected || expected.length < 32) {
        res.status(503).json({ status: 'error', message: 'Admin endpoint disabled' });
        return;
    }
    const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const supplied = req.header('x-admin-token') || bearer;
    if (!supplied || !safeEqual(supplied, expected)) {
        res.status(401).json({ status: 'error', message: 'Invalid or missing credentials' });
        return;
    }
    next();
}
function securityHeaders(_req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
}
