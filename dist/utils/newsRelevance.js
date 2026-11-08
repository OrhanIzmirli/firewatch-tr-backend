"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isGreenStory = void 0;
exports.checkRelevance = checkRelevance;
exports.isInFiresFeed = isInFiresFeed;
exports.relevantPageIds = relevantPageIds;
const newsKinds_1 = require("./newsKinds");
Object.defineProperty(exports, "isGreenStory", { enumerable: true, get: function () { return newsKinds_1.isGreenStory; } });
const turkishText_1 = require("./turkishText");
const wildfireRelevance_1 = require("./wildfireRelevance");
const newsGeography_1 = require("./newsGeography");
/**
 * Which news items belong in the app's fires feed. Used twice:
 *   - jobs/newsScraperJob.ts, before an RSS item is stored, and
 *   - services/newsService.ts, when news is read, so rows stored under an
 *     older, looser filter stay in the table but leave the feed.
 * Moved here unchanged from newsScraperJob.ts so the service can use it
 * without importing the scraper job (which imports the service).
 */
// STRICT WHITELIST — specific fire/disaster terms are checked against the
// TITLE + summary (broad recall); the two generic organizational names
// below are checked against the TITLE only.
//
// A few words from the original request are intentionally replaced with
// safer compounds after empirically testing against 355 live RSS articles
// and re-discovering collisions already found and fixed in earlier
// passes: bare 'sel' matches the extremely productive Turkish "-sel"
// adjective suffix (Selçuk, ASELSAN, yükseldi, bitkisel, kitlesel...);
// bare 'afet' matches inside the name "Şerafettin"; bare 'tahliye' collides
// with its legal "release from custody" sense; bare 'uyarı'/'risk'/
// 'tehlike' are generic words used across every news domain (a judge's
// "sert uyarı", a hair-dye article asking "kimler risk altında?", a
// wildlife story where "dokunmak bile tehlikeli"), not just weather/fire.
const MUST_HAVE_KEYWORDS = [
    'yangın', 'yangin', 'orman yangını', 'orman yangini', 'alevler', 'alev aldı', 'duman',
    'tahliye edildi', 'tahliye emri', 'bina tahliye',
    'kuraklık', 'sel felaketi', 'sel baskını', 'seller bastı', 'ani sel', 'sele kapıldı', 'taşkın',
    'fırtına', 'hortum', 'kasırga', 'heyelan', 'çığ düştü', 'çığ tehlikesi',
    'hava uyarısı', 'sarı kod', 'turuncu kod', 'kırmızı kod',
    'yangın uyarısı', 'sel uyarısı', 'fırtına uyarısı',
    'acil durum', 'felaket', 'doğal afet', 'yangın riski', 'yangın tehlikesi',
    'sıcak hava dalgası', 'aşırı sıcak', 'kavurucu sıcak',
    'maki alan', 'zeytinlik yangın', 'ormanlık alan',
    'wildfire', 'forest fire', 'fire', 'blaze', 'smoke', 'evacuation',
    'flood', 'drought', 'storm', 'hurricane', 'disaster', 'emergency',
    'heat wave', 'extreme heat', 'wildland fire',
];
// 'itfaiye'/'afad' also respond to traffic rescues, floods, and building
// collapses — routine "itfaiye ekipleri de sevk edildi" boilerplate shows
// up in almost any accident article's body. Restricted to the title, where
// their presence is a far stronger signal the story is actually about a
// fire/disaster response rather than incidental dispatch-list filler.
// (Empirically confirmed: broadening these two to full-text matching
// pulled in a fatal traffic-barrier collision and a bus-crash story via
// this exact boilerplate.)
const TITLE_ONLY_KEYWORDS = ['itfaiye', 'afad'];
const BLOCKED_KEYWORDS = [
    // Şiddet/Suç
    'öldürüldü', 'öldürdü', 'cinayet', 'katil', 'ceset', 'infaz',
    'saldırı', 'bomba', 'terör', 'silahlı', 'silah', 'suç', 'hırsız',
    'mahkeme', 'dava', 'beraat', 'dolandırıcı', 'uyuşturucu', 'tutuklama', 'tutuklandı',
    'yargılanıyor', 'hapis cezası',
    // Spor
    'futbol', 'basketbol', 'voleybol', 'maç', 'gol', 'şampiyon', 'transfer', 'lig', 'forma', 'spor',
    // Eğlence/Magazin
    'dizi', 'film', 'müzik', 'şarkı', 'şarkıcı', 'konser', 'magazin', 'oyuncu',
    'ünlü', 'sosyete', 'defile', 'gündem olan paylaşım', 'sanatçı', 'güzellik', 'makyaj', 'kozmetik',
    // Ekonomi
    'borsa', 'dolar', 'euro', 'faiz', 'enflasyon', 'bütçe', 'vergi', 'ekonomi',
    'cryptocurrency', 'bitcoin', 'nft',
    // Siyaset
    // NOTE: bare 'bakan' is also the present participle of "bakmak" (to look
    // after/attend to), e.g. "yangına bakan itfaiyeci" (the firefighter
    // attending to the fire) — a real but rare headline construction. Kept
    // in per explicit repeated request; 'bakanlık'/'bakanı' below already
    // cover the far more common "X Bakanı"/"X Bakanlığı" inflections without
    // that risk.
    'seçim', 'oy kullan', 'parti', 'milletvekili', 'meclis', 'cumhurbaşkanı', 'cumhurbaşkan',
    'muhalefet', 'iktidar', 'siyasi', 'hükümet', 'bakanlık', 'bakanı', 'bakan',
    // Askeri
    // NOTE: bare 'ordu' was tested and dropped — it's also the name of a
    // real Turkish province (Ordu, on the Black Sea coast), so it would
    // have blocked legitimate fire/flood news about that region.
    'mayın', 'denizaltı', 'fırkateyn', 'patlayıcı', 'silah sistemi',
    'savunma sanayii', 'mke', 'roket', 'hava savunma', 'nato', 'askeri', 'savaş', 'defense',
    'operasyon', 'gözaltı', 'fetö', 'pkk', 'iha düşürüldü', 'füze', 'nükleer',
    // Diplomatik / Uluslararası ilişkiler
    'ambassador', 'diplomat', 'summit', 'treaty', 'alliance', 'military',
    // Teknoloji
    'startup', 'yapay zeka', 'robot', 'fintek', 'yatırım', 'ihracat', 'ithalat',
    'teknoloji', 'akıllı telefon', 'yazılım şirketi', 'e-ticaret', 'telefon', 'bilgisayar', 'uzay',
    // Turizm/Seyahat
    'kruvaziyer', 'turist', 'tatil köyü', 'otel', 'schengen', 'vize',
    'turizm', 'uçuş', 'havayolu', 'pasaport', 'tatil',
    // Kişisel/Magazin
    'evlilik', 'boşanma', 'bebek', 'hamile', 'moda',
    'saç boyası', 'alerjik reaksiyon', 'otopsi', 'velayet', 'iletişim başkanı',
    // Uluslararası (Türkiye dışı)
    'kongo', 'ebola', 'japonya', 'venezuela', 'filistin', 'israil', 'israel', 'gazze',
    'hindistan', 'pakistan', 'bangladeş', 'nepal', 'mısır',
    'fransa', 'france', 'almanya', 'germany', 'rusya', 'russia', 'ukrayna', 'ukraine',
    'suriye', 'syria', 'irak', 'iran', 'yunanistan', 'çin', 'china', 'ingiltere',
    'avrupa birliği',
    // NOTE: bare 'abd' (Turkish abbreviation for "USA") intentionally
    // dropped — it's also the start of extremely common Turkish given names
    // (Abdullah, Abdurrahman, Abdulkadir...), which would get blocked since
    // matching is case-insensitive substring, not whole-word.
    // Deprem — out of scope for this app (wildfire-focused, not general
    // disaster coverage) per explicit product decision.
    'deprem',
    // Diğer
    'saç', 'dyson', 'bokashi', 'madalya', 'solotürk', 'fetih',
    'kadına yönelik', 'çocuk hakları', 'gezegen', 'petrol stok', 'zeytin satıcı', 'kurban hisse',
    'ta mektep', 'belediyesi çocuk', 'osmanlı', 'tarihi',
    'hakkını aradı', 'kovuldu', 'işten çıkarıldı', 'görevden alındı', 'istifa etti',
    // Dini/Bayram
    'kızılay', 'kurban', 'bayram', 'köfte', 'çorba', 'diyet', 'kanser', 'imece', 'zeytin', 'panik atak',
    'hatim', 'iftar', 'sahur', 'ramazan', 'kadir gecesi', 'mevlid', 'aşure',
    'hacı aday', 'hac ziyareti', 'hacı', 'umre', 'harem', 'medine', 'mekke', 'kabe',
    // Şehit/Asker cenazesi
    'şehit', 'cenaze', 'asker', 'jandarma', 'bakan yardımcısı', 'tören', 'tabut', 'gözyaşı',
    'şehitler', 'gaziler', 'gazi', 'askeri tören', 'askeri cenaze', 'asker uğurlama',
    'asker cenazesi', 'asker şehit', 'asker gazi', 'asker gazisi',
    'asker yaralı', 'asker yaralısı', 'asker yaralanma', 'asker yaralanması', 'asker yaralandı',
];
function checkRelevance(title, fullText) {
    const titleLower = (0, turkishText_1.turkishToLower)(title).trim();
    const fullLower = (0, turkishText_1.turkishToLower)(fullText).trim();
    const hasMustHave = MUST_HAVE_KEYWORDS.some(kw => fullLower.includes(kw)) ||
        TITLE_ONLY_KEYWORDS.some(kw => titleLower.includes(kw));
    if (!hasMustHave)
        return { relevant: false, reason: 'no_must_have' };
    if (BLOCKED_KEYWORDS.some(kw => fullLower.includes(kw))) {
        return { relevant: false, reason: 'blocked' };
    }
    if (titleLower.length <= 10)
        return { relevant: false, reason: 'too_short' };
    // The feed is wildfires only: building/vehicle fires, storms, floods and
    // weather pass the whitelist above but are not what the app is for.
    if (!(0, wildfireRelevance_1.assessWildfire)(title, fullText).wildfire)
        return { relevant: false, reason: 'not_wildfire' };
    // ...and wildfires in Turkey: a fire abroad stays only when it is in a
    // neighbouring country and the text ties it to Turkey (utils/newsGeography.ts).
    if (!(0, newsGeography_1.assessTurkey)(title, fullText).turkey)
        return { relevant: false, reason: 'foreign' };
    return { relevant: true, reason: 'ok' };
}
/**
 * Read-side form of the filter: a stored row is in the feed when its title
 * and stored summary pass checkRelevance, exactly as the scraper builds
 * fullText from an RSS item.
 */
function isInFiresFeed(row) {
    const title = row.title ?? '';
    return checkRelevance(title, `${title} ${row.summary ?? ''}`).relevant || (0, newsKinds_1.isGreenStory)(title);
}
/**
 * Ids of the feed page `limit`/`offset` counted over relevant rows only,
 * keeping the input order (the caller sorts newest first).
 */
function relevantPageIds(rows, limit, offset) {
    return rows.filter(isInFiresFeed).slice(offset, offset + limit).map((r) => r.id);
}
