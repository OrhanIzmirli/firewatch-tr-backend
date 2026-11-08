"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toPublicNews = toPublicNews;
const newsGeography_1 = require("./newsGeography");
const newsSourceLogos_1 = require("./newsSourceLogos");
/**
 * What leaves the API: headline, source and link. Any older client still
 * reads the text fields, so they stay present and empty.
 */
function toPublicNews(row) {
    const { image_url: _image, thumbnail_url: _thumb, ...rest } = row;
    const province = (0, newsGeography_1.provinceInTitle)(row.title);
    const when = row.published_at ?? row.created_at;
    return {
        ...(0, newsSourceLogos_1.withSourceLogo)(rest),
        summary: '',
        body: '',
        highlights: [],
        paragraphs: [],
        province,
        thumb_path: province && when ? `/api/news/thumb/${encodeURIComponent(province)}/${new Date(when).toISOString().slice(0, 10)}` : null,
    };
}
