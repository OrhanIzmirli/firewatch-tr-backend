"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.relatedNews = relatedNews;
const incidentNewsMatch_1 = require("./incidentNewsMatch");
const provinces_1 = require("./provinces");
/** Same story and province gates as "confirmed by news", newest first. */
async function relatedNews(db, city, from, to, limit) {
    const [news, cities] = await Promise.all([
        db.query(`SELECT id, title, summary, source, source_url, COALESCE(published_at, created_at) AS at
         FROM news
        WHERE COALESCE(published_at, created_at) BETWEEN $1::timestamptz - interval '1 day' AND $2::timestamptz + interval '1 day'
        ORDER BY at DESC
        LIMIT 400`, [from, to]),
        db.query(`SELECT name FROM turkey_cities`),
    ]);
    const cityNames = (0, provinces_1.withFormerNames)(cities.rows.map((r) => String(r.name)));
    const out = [];
    for (const r of news.rows) {
        const article = { id: Number(r.id), title: r.title, summary: r.summary, publishedAt: new Date(r.at) };
        if (!(0, incidentNewsMatch_1.withinDayWindow)(article.publishedAt, from, to))
            continue;
        const ok = city ? (0, incidentNewsMatch_1.isStoryAboutProvince)(article, city, cityNames) : (0, incidentNewsMatch_1.isForestFireStory)(article);
        if (!ok)
            continue;
        out.push({ id: article.id, title: r.title, source: r.source, url: r.source_url, published_at: article.publishedAt.toISOString() });
        if (out.length >= limit)
            break;
    }
    return out;
}
