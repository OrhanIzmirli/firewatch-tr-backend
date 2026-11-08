"use strict";
/**
 * Text of the region-wide push notifications. Kept apart from the job so the
 * wording can be tested: a notification may only state what the numbers in
 * front of it show.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.riskAlertText = riskAlertText;
exports.multipleDetectionsAlertText = multipleDetectionsAlertText;
/**
 * The published reading, not a guess at the cause: a score over the alert
 * threshold can come from wind and detections on a mild, humid day, so the
 * old fixed "Sıcaklık yüksek, nem düşük" could be false.
 */
function riskAlertText(a) {
    return {
        title: `🔥 Yüksek Yangın Riski - ${a.regionDisplay}`,
        body: `Risk skoru: ${a.score}/100. Sıcaklık ${Math.round(a.temperature)}°C, nem %${Math.round(a.humidity)}, ` +
            `rüzgâr ${Math.round(a.windSpeed)} km/sa. Dikkatli olun.`,
    };
}
/** A satellite count is heat detections, never confirmed fires. */
function multipleDetectionsAlertText(regionDisplay, highConfidenceCount) {
    return {
        title: '🛰️ Çoklu Uydu Isı Tespiti',
        body: `${regionDisplay}: son 24 saatte ${highConfidenceCount} yüksek güvenilirlikli uydu ısı tespiti. ` +
            `Doğrulanmış yangın değildir; yangın görürseniz 112'yi arayın.`,
    };
}
