"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NEWS_MATCH_DAY_WINDOW = exports.NEWS_MATCH_RADIUS_KM = void 0;
exports.haversineKm = haversineKm;
exports.turkeyDay = turkeyDay;
exports.withinDayWindow = withinDayWindow;
exports.isStoryAboutProvince = isStoryAboutProvince;
exports.isForestFireStory = isForestFireStory;
exports.confirmationDistanceKm = confirmationDistanceKm;
exports.matchIncidentsToNews = matchIncidentsToNews;
const wildfireRelevance_1 = require("../utils/wildfireRelevance");
const officialStatusExtractor_1 = require("./officialStatusExtractor");
const placeMention_1 = require("./placeMention");
const provinces_1 = require("./provinces");
/**
 * "Haberlerde doğrulandı": a wrong match is worse than none, so every gate
 * refuses when in doubt. An article must be a forest-fire story, name
 * exactly one province, the incident's, and exactly one district in it,
 * whose centre is within NEWS_MATCH_RADIUS_KM of the incident, published
 * within a Turkish calendar day of the detections.
 *
 * Related-news lists use the same story and province gates, without the
 * district and distance ones.
 */
exports.NEWS_MATCH_RADIUS_KM = 15;
exports.NEWS_MATCH_DAY_WINDOW = 1;
function haversineKm(aLat, aLng, bLat, bLng) {
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(bLat - aLat);
    const dLng = rad(bLng - aLng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(h));
}
/** Day number on the Turkish calendar (UTC+3, no DST). */
function turkeyDay(d) {
    return Math.floor((d.getTime() + 3 * 3600000) / 86400000);
}
function withinDayWindow(published, first, last) {
    const day = turkeyDay(published);
    return day >= turkeyDay(first) - exports.NEWS_MATCH_DAY_WINDOW && day <= turkeyDay(last) + exports.NEWS_MATCH_DAY_WINDOW;
}
/** A forest-fire story that names this one province and no other. */
function isStoryAboutProvince(article, province, cityNames) {
    const text = `${article.title} ${article.summary ?? ''}`;
    const verdict = (0, wildfireRelevance_1.assessWildfire)(article.title, text);
    if (!verdict.wildfire || verdict.basis !== 'strong')
        return false;
    const named = (0, provinces_1.canonicalProvinceNames)((0, officialStatusExtractor_1.mentionedCities)(text, [...cityNames]));
    return named.length === 1 && named[0] === province;
}
function isForestFireStory(article) {
    const verdict = (0, wildfireRelevance_1.assessWildfire)(article.title, `${article.title} ${article.summary ?? ''}`);
    return verdict.wildfire && verdict.basis === 'strong';
}
/** Distance in km when the article confirms this incident, otherwise null. */
function confirmationDistanceKm(incident, article, ctx) {
    if (!incident.city)
        return null;
    if (!withinDayWindow(article.publishedAt, incident.firstAt, incident.lastAt))
        return null;
    if (!isStoryAboutProvince(article, incident.city, ctx.cityNames))
        return null;
    const text = `${article.title} ${article.summary ?? ''}`;
    const mention = (0, placeMention_1.singleDistrict)((0, placeMention_1.mentionedDistricts)(text, ctx.districts, [incident.city]));
    if (mention === null || mention.district.provinceName !== incident.city)
        return null;
    const km = haversineKm(incident.lat, incident.lng, mention.district.lat, mention.district.lng);
    return km <= exports.NEWS_MATCH_RADIUS_KM ? km : null;
}
/**
 * incident id -> article id. An article confirms only its closest incident,
 * and an incident takes its closest article; on a tie, nothing.
 */
function matchIncidentsToNews(incidents, articles, ctx) {
    const bestForArticle = new Map();
    for (const article of articles) {
        for (const incident of incidents) {
            const km = confirmationDistanceKm(incident, article, ctx);
            if (km === null)
                continue;
            const best = bestForArticle.get(article.id);
            if (!best || km < best.km)
                bestForArticle.set(article.id, { incident: incident.id, km, tied: false });
            else if (km === best.km)
                best.tied = true;
        }
    }
    const bestForIncident = new Map();
    for (const [article, best] of bestForArticle) {
        if (best.tied)
            continue;
        const current = bestForIncident.get(best.incident);
        if (!current || best.km < current.km)
            bestForIncident.set(best.incident, { article, km: best.km });
    }
    return new Map([...bestForIncident].map(([incident, b]) => [incident, b.article]));
}
