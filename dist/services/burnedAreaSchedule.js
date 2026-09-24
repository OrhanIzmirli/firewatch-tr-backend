"use strict";
/**
 * Which months the burned-area job may ask NASA for. Pure date arithmetic,
 * kept out of the job so it can be unit-tested without a database.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EARLIEST_PUBLISH_DAYS = void 0;
exports.firstOfMonthUTC = firstOfMonthUTC;
exports.lastDayOfMonthUTC = lastDayOfMonthUTC;
exports.addDaysUTC = addDaysUTC;
exports.parseBackfillFrom = parseBackfillFrom;
exports.eligibleMonths = eligibleMonths;
/** Do not even ask CMR before the month has been over this long. */
exports.EARLIEST_PUBLISH_DAYS = 30;
function firstOfMonthUTC(year, monthIndex) {
    return new Date(Date.UTC(year, monthIndex, 1));
}
function lastDayOfMonthUTC(month) {
    return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
}
function addDaysUTC(d, days) {
    return new Date(d.getTime() + days * 86400000);
}
/** Parses 'YYYY-MM' (env) into the first of that month, UTC; falls back on garbage. */
function parseBackfillFrom(value, fallback) {
    const m = /^(\d{4})-(\d{2})$/.exec((value ?? fallback).trim());
    if (!m)
        return parseBackfillFrom(fallback, fallback);
    return firstOfMonthUTC(Number(m[1]), Number(m[2]) - 1);
}
/**
 * Months from `from` up to the newest month whose end is at least
 * EARLIEST_PUBLISH_DAYS in the past. Never the current month.
 */
function eligibleMonths(now, from) {
    const months = [];
    let m = firstOfMonthUTC(from.getUTCFullYear(), from.getUTCMonth());
    for (;;) {
        const publishable = addDaysUTC(lastDayOfMonthUTC(m), exports.EARLIEST_PUBLISH_DAYS + 1);
        if (publishable.getTime() > now.getTime())
            break;
        months.push(m);
        m = firstOfMonthUTC(m.getUTCFullYear(), m.getUTCMonth() + 1);
        if (months.length > 600)
            break; // a typo in the env must not loop forever
    }
    return months;
}
