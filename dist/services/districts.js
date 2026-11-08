"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadDistricts = loadDistricts;
const database_1 = __importDefault(require("../config/database"));
let cached = null;
/** Every district, loaded once per process: the table changes only by migration. */
function loadDistricts() {
    if (!cached) {
        cached = database_1.default
            .query('SELECT id, name, province_id, province_name FROM turkey_districts')
            .then((r) => r.rows.map((d) => ({ id: d.id, name: d.name, provinceId: d.province_id, provinceName: d.province_name, lat: 0, lng: 0 })))
            .catch((error) => {
            cached = null;
            throw error;
        });
    }
    return cached;
}
