"use strict";
/**
 * Which FIRMS products the "first answer wins" lookups try, and in what order.
 *
 * Suomi NPP (VIIRS_SNPP_NRT) is retired. The FIRMS site announced that
 * delivery of S-NPP observations would cease on November 2, 2026, and that
 * users should move to the other VIIRS platforms, NOAA-21 and NOAA-20. Our
 * own data agrees: the last S-NPP detection stored by the ingest job is
 * 2026-11-02 11:59 UTC; from Nov 3 S-NPP returned nothing while NOAA-20/21
 * kept arriving. NOAA-20 and NOAA-21 carry the same VIIRS instrument and the
 * same CSV columns, so swapping the product changes no parsing anywhere.
 *
 * Both lookups below stop at the first acceptable answer, so S-NPP first
 * meant: an empty S-NPP response, then MODIS (1 km, a handful of detections
 * a day) instead of VIIRS. S-NPP stays last only in case FIRMS ever serves
 * it again.
 *
 * jobs/fireIngestJob.ts is not affected: it fetches every product on every
 * run and unions them, so an empty S-NPP simply adds nothing.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.THERMAL_ATTEMPTS = exports.RISK_FIRE_STATS_ATTEMPTS = void 0;
/** riskCalculatorJob.fetchFireStats: 4°x4° box around a region, small windows. */
exports.RISK_FIRE_STATS_ATTEMPTS = [
    { product: 'VIIRS_NOAA20_NRT', days: 1 },
    { product: 'VIIRS_NOAA21_NRT', days: 1 },
    { product: 'MODIS_NRT', days: 1 },
    { product: 'VIIRS_NOAA20_NRT', days: 2 },
    { product: 'VIIRS_NOAA21_NRT', days: 2 },
    { product: 'VIIRS_SNPP_NRT', days: 1 },
];
/**
 * routes/thermal.ts: the whole country, two days as the primary window (see
 * the comment there for why one day is too short).
 */
exports.THERMAL_ATTEMPTS = [
    { product: 'VIIRS_NOAA20_NRT', days: 2 },
    { product: 'VIIRS_NOAA21_NRT', days: 2 },
    { product: 'VIIRS_NOAA20_NRT', days: 3 },
    { product: 'VIIRS_NOAA21_NRT', days: 3 },
    { product: 'MODIS_NRT', days: 2 },
    { product: 'VIIRS_SNPP_NRT', days: 2 },
];
