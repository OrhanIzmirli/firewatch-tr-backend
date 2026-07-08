"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.turkishToLower = turkishToLower;
/**
 * Turkish-safe lowercase for case-insensitive substring matching.
 *
 * JavaScript's String.prototype.toLowerCase() follows the Unicode default
 * case-folding rules, under which the Turkish capital dotted İ (U+0130)
 * does NOT lowercase to plain ASCII 'i' (U+0069) — it produces 'i' plus a
 * combining dot-above (U+0307), a two-codepoint sequence. Any keyword
 * match like lower.includes('izmir') or lower.includes('ingiltere')
 * silently fails against text containing "İzmir"/"İngiltere" (or any other
 * Turkish proper noun starting with İ — İstanbul, İç Anadolu, İğdır...)
 * even though a human reader would consider them an obvious match, because
 * of that invisible extra combining character. This affects nearly every
 * Turkish news headline, since proper nouns are always capitalized.
 */
function turkishToLower(text) {
    return text.replace(/İ/g, 'i').toLowerCase();
}
