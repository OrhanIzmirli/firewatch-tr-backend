"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NO_MINIMUM_VERSION = void 0;
exports.minSupportedVersion = minSupportedVersion;
const express_1 = require("express");
const security_1 = require("../middleware/security");
exports.NO_MINIMUM_VERSION = '0.0.0';
/** The lowest app version allowed to run. A bad value forces nobody. */
function minSupportedVersion(value) {
    const v = value?.trim() ?? '';
    return /^\d+(\.\d+){0,2}$/.test(v) ? v : exports.NO_MINIMUM_VERSION;
}
const router = (0, express_1.Router)();
/** GET /api/app-config. Set MIN_SUPPORTED_VERSION in the environment to force an update. */
router.get('/', (0, security_1.rateLimit)('app-config', 120, 60000), (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'success', data: { min_supported_version: minSupportedVersion(process.env.MIN_SUPPORTED_VERSION) } });
});
exports.default = router;
