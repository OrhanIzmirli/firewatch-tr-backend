"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.headlineProvince = headlineProvince;
exports.toPublicNews = toPublicNews;
const newsGeography_1 = require("./newsGeography");
const newsKinds_1 = require("./newsKinds");
const placeMention_1 = require("../services/placeMention");
const newsSourceLogos_1 = require("./newsSourceLogos");
/** The province a headline is about, directly or through one of its districts. */
function headlineProvince(title, districts = []) {
    const direct = (0, newsGeography_1.provinceInTitle)(title);
    if (direct)
        return direct;
    const provinces = new Set((0, placeMention_1.mentionedDistricts)(title, districts).map((m) => m.district.provinceName));
    return provinces.size === 1 ? [...provinces][0] : null;
}
/**
 * What leaves the API: headline, source and link. Any older client still
 * reads the text fields, so they stay present and empty.
 */
function toPublicNews(row, districts = []) {
    const { image_url: _image, thumbnail_url: _thumb, ...rest } = row;
    const province = headlineProvince(row.title, districts);
    const when = row.published_at ?? row.created_at;
    return {
        ...(0, newsSourceLogos_1.withSourceLogo)(rest),
        summary: '',
        body: '',
        highlights: [],
        paragraphs: [],
        province,
        kind: (0, newsKinds_1.newsKind)(row.title),
        thumb_path: province && when ? `/api/news/thumb/${encodeURIComponent(province)}/${new Date(when).toISOString().slice(0, 10)}` : null,
    };
}
