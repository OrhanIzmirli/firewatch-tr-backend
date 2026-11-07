"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROVINCE_FORMER_NAMES = void 0;
exports.provincePolygonsAvailable = provincePolygonsAvailable;
exports.resetProvinceCache = resetProvinceCache;
exports.provinceIdSql = provinceIdSql;
exports.resolveProvinces = resolveProvinces;
exports.resolveProvince = resolveProvince;
exports.currentProvinceName = currentProvinceName;
exports.withFormerNames = withFormerNames;
exports.canonicalProvinceNames = canonicalProvinceNames;
let polygons = null;
/** Whether migration 015 is applied. Only a "yes" is memoised. */
function provincePolygonsAvailable(db) {
    if (!polygons) {
        polygons = db
            .query(`SELECT to_regprocedure('province_for_point(geometry)') IS NOT NULL AS ok`)
            .then((r) => {
            const ok = r.rows[0]?.ok === true;
            if (!ok)
                polygons = null;
            return ok;
        })
            .catch(() => {
            polygons = null;
            return false;
        });
    }
    return polygons;
}
function resetProvinceCache() {
    polygons = null;
}
/**
 * SQL for the province id of the geometry expression [point] (SRID 4326).
 * The ONLY place in src/ allowed to pick a province by distance to its
 * centre, and only as the pre-015 fallback.
 */
function provinceIdSql(point, usePolygons) {
    return usePolygons
        ? `province_for_point(${point})`
        : `(SELECT tc.id FROM turkey_cities tc ORDER BY tc.location <-> ${point} LIMIT 1)`;
}
/**
 * Resolves many points in one query, in input order; null where a point
 * could not be resolved (no provinces loaded at all).
 */
async function resolveProvinces(db, points) {
    if (points.length === 0)
        return [];
    const usePolygons = await provincePolygonsAvailable(db);
    const result = await db.query(`WITH pts AS (
       SELECT idx, ST_SetSRID(ST_MakePoint(lng, lat), 4326) AS g
         FROM unnest($1::float8[], $2::float8[]) WITH ORDINALITY AS t(lat, lng, idx)
     ),
     assigned AS (SELECT idx, g, ${provinceIdSql('g', usePolygons)} AS pid FROM pts)
     SELECT a.idx, tc.id, tc.name, tc.region,
            ST_Distance(tc.location::geography, a.g::geography) / 1000 AS distance_km
       FROM assigned a
       LEFT JOIN turkey_cities tc ON tc.id = a.pid
      ORDER BY a.idx`, [points.map((p) => p.lat), points.map((p) => p.lng)]);
    return result.rows.map((row) => row.id === null
        ? null
        : {
            id: Number(row.id),
            name: String(row.name),
            region: row.region === null ? null : String(row.region),
            distanceKm: Number(row.distance_km),
        });
}
async function resolveProvince(db, lat, lng) {
    return (await resolveProvinces(db, [{ lat, lng }]))[0] ?? null;
}
/**
 * Former official names people (and news) still use, keyed by the current
 * name. turkey_cities called Mersin "İçel" until migration 015.
 */
exports.PROVINCE_FORMER_NAMES = {
    Mersin: ['İçel'],
};
/** Current name for a current or former name ("İçel" → "Mersin"). */
function currentProvinceName(name) {
    for (const [current, formers] of Object.entries(exports.PROVINCE_FORMER_NAMES)) {
        if (name === current || formers.includes(name))
            return current;
    }
    return name;
}
/** [names] plus the former names of any that have one. */
function withFormerNames(names) {
    const out = [];
    for (const name of names) {
        out.push(name);
        out.push(...(exports.PROVINCE_FORMER_NAMES[name] ?? []));
    }
    return out;
}
/** Distinct current names for names found in text (former names folded in). */
function canonicalProvinceNames(found) {
    return [...new Set([...found].map(currentProvinceName))];
}
