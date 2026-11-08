"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.newsKind = newsKind;
exports.isGreenStory = isGreenStory;
const newsGeography_1 = require("./newsGeography");
const turkishText_1 = require("./turkishText");
const RECOVERY = /ağaçlandır|fidan dik|fidan dağıt|fidanlar? toprakla|hatıra orman|yeniden yeşer|orman.*rehabilitasyon|yanan alan/;
const PREPARATION = /yangın (tatbikat|eğitim|sezon|önlem|hazırlı)|orman yangın.*(tatbikat|eğitim|önlem|hazırlı)|yangın gözetleme|yangın kule|arazöz.*(teslim|eğitim)|orman.*(tatbikat)/;
const NATURE = /yaban hayat|yaban keçi|milli park|tabiat park|doğa koruma|orman köylü|orman haftası|orman kahraman/;
/** "Ormancı" alone says nothing about the subject: traffic training is not forest news. */
const FORESTER = /ormancı/;
const FORESTER_TOPIC = /ağaçlandır|fidan|dikim|restorasyon|rehabilitasyon|yenileme|yeşer|erozyon|iklim|proje|orman varlığ/;
const FIELD = /anız|otluk|tarla|ot yangın|ekili alan|tarım alan|örtü yangın|çöplük|bahçe yangın/;
const FIRE = /yangın|alev/;
const BLOCKED = /cinayet|kaza yaptı|maç|seçim|bakan.*istifa/;
/** Null when the headline is about none of these. */
function newsKind(title) {
    const t = (0, turkishText_1.turkishToLower)(title);
    if (BLOCKED.test(t))
        return null;
    if (RECOVERY.test(t))
        return 'recovery';
    if (PREPARATION.test(t))
        return 'preparation';
    if (FIELD.test(t) && FIRE.test(t) && !/orman yangın/.test(t))
        return 'field';
    if (/orman/.test(t) && FIRE.test(t))
        return 'fire';
    if (NATURE.test(t) || (FORESTER.test(t) && FORESTER_TOPIC.test(t)))
        return 'nature';
    return FIRE.test(t) ? 'fire' : null;
}
/** Recovery, preparation or nature news about Turkey: welcome in the feed even with no fire. */
function isGreenStory(title) {
    const kind = newsKind(title);
    return (kind === 'recovery' || kind === 'preparation' || kind === 'nature') && (0, newsGeography_1.assessTurkey)(title, title).turkey;
}
