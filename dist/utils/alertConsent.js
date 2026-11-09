"use strict";
/**
 * SQL conditions for who may be alerted. Shared so every sender applies the
 * same rule.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.deviceNotMutedSql = deviceNotMutedSql;
exports.allScopeAllowedSql = allScopeAllowedSql;
/**
 * False once the user has turned this device's notifications off. Tracked
 * places have their own device table, so they have to look it up here. A
 * token that never registered in fcm_tokens has nothing turned off.
 */
function deviceNotMutedSql(deviceAlias) {
    return `NOT EXISTS (
    SELECT 1 FROM fcm_tokens muted
    WHERE muted.token = ${deviceAlias}.fcm_token AND muted.is_active = false
  )`;
}
/**
 * A device on the default 'all' scope needs a stored location, or an explicit
 * "whole country" choice. A chosen region or province is already explicit.
 */
function allScopeAllowedSql(tokenAlias) {
    return `(
    ${tokenAlias}.alert_scope <> 'all'
    OR ${tokenAlias}.all_regions_opt_in
    OR (${tokenAlias}.latitude IS NOT NULL AND ${tokenAlias}.longitude IS NOT NULL)
  )`;
}
