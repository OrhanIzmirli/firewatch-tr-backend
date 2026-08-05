"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveLocation = resolveLocation;
exports.resolveRegionForCity = resolveRegionForCity;
const database_1 = __importDefault(require("../config/database"));
const regions_1 = require("../utils/regions");
const EMPTY = {
    cityId: null,
    cityName: null,
    regionName: null,
    regionKey: null,
    distanceKm: null,
};
async function resolveLocation(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng))
        return EMPTY;
    try {
        const result = await database_1.default.query(`SELECT id, name, region,
              ST_Distance(
                location::geography,
                ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
              ) / 1000 AS distance_km
       FROM turkey_cities
       ORDER BY location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
       LIMIT 1`, [lng, lat]);
        const row = result.rows[0];
        if (!row)
            return { ...EMPTY, regionKey: (0, regions_1.regionKeyForCoordinates)(lat, lng) };
        return {
            cityId: Number(row.id),
            cityName: row.name ?? null,
            regionName: row.region ?? null,
            regionKey: (0, regions_1.regionKeyForRegionName)(row.region) ?? (0, regions_1.regionKeyForCoordinates)(lat, lng),
            distanceKm: Number(row.distance_km),
        };
    }
    catch (error) {
        console.error('resolveLocation failed:', error.message);
        // Never let a lookup failure silently drop the region entirely.
        return { ...EMPTY, regionKey: (0, regions_1.regionKeyForCoordinates)(lat, lng) };
    }
}
/** Resolves the region for a province we already know the id of. */
async function resolveRegionForCity(cityId) {
    try {
        const result = await database_1.default.query(`SELECT region,
              ST_Y(location::geometry) AS lat,
              ST_X(location::geometry) AS lng
       FROM turkey_cities WHERE id = $1`, [cityId]);
        const row = result.rows[0];
        if (!row)
            return null;
        return ((0, regions_1.regionKeyForRegionName)(row.region) ??
            (row.lat !== null && row.lng !== null
                ? (0, regions_1.regionKeyForCoordinates)(Number(row.lat), Number(row.lng))
                : null));
    }
    catch (error) {
        console.error('resolveRegionForCity failed:', error.message);
        return null;
    }
}
