"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.provinceInTitle = provinceInTitle;
exports.assessTurkey = assessTurkey;
const turkishText_1 = require("./turkishText");
/**
 * Is this wildfire news about Turkey?
 *
 * The RSS sources are Turkish outlets, so a story is Turkish unless it
 * names a foreign country or place. Then it stays only when the fire is
 * in a neighbouring country AND the text ties it to Turkey (names Turkey,
 * a Turkish province, the border or the forestry directorate).
 * "Endonezya'da orman yangınları" is out; "Yunanistan'daki yangın
 * Edirne'den görüldü" stays; "Kanada yangınlarının dumanı Türkiye'ye
 * ulaştı" is out too, because Canada is not a neighbour (the exception is
 * for fires that can reach us).
 *
 * Place names match only as whole words, lower-cased with the Turkish İ
 * rule. An apostrophe ends a word, so "yunanistan'daki" and
 * "endonezya'da" match while "iran" does not match inside "iranı".
 */
const NEIGHBOURS = {
    Yunanistan: ['yunanistan', 'yunan', 'rodos', 'sakız adası', 'midilli', 'girit', 'semadirek', 'limni', 'atina', 'selanik', 'dedeağaç', 'evros', 'eğriboz', 'mora'],
    Bulgaristan: ['bulgaristan', 'bulgar', 'sofya', 'burgaz', 'filibe'],
    Gürcistan: ['gürcistan', 'gürcü', 'tiflis', 'batum', 'acara'],
    Suriye: ['suriye', 'şam', 'halep', 'lazkiye', 'idlib', 'afrin', 'rakka', 'haseke', 'kamışlı'],
    Irak: ['irak', 'bağdat', 'musul', 'erbil', 'kerkük', 'süleymaniye', 'duhok'],
    İran: ['iran', 'tahran', 'tebriz', 'urmiye'],
    Ermenistan: ['ermenistan', 'erivan'],
    Azerbaycan: ['azerbaycan', 'bakü', 'nahçıvan', 'karabağ'],
    Kıbrıs: ['kıbrıs', 'kktc', 'lefkoşa', 'girne', 'magosa', 'gazimağusa', 'baf', 'limasol', 'larnaka'],
};
const FAR = [
    // Europe
    'avrupa', 'ispanya', 'portekiz', 'fransa', 'korsika', 'italya', 'sicilya', 'sardinya', 'almanya', 'avusturya', 'isviçre',
    'hollanda', 'belçika', 'ingiltere', 'britanya', 'iskoçya', 'galler', 'irlanda', 'isveç', 'norveç', 'finlandiya', 'danimarka',
    'polonya', 'çekya', 'çek cumhuriyeti', 'slovakya', 'macaristan', 'romanya', 'moldova', 'ukrayna', 'rusya', 'sibirya', 'yakutistan',
    'belarus', 'litvanya', 'letonya', 'estonya', 'hırvatistan', 'bosna', 'sırbistan', 'karadağ', 'arnavutluk', 'makedonya', 'kosova', 'slovenya',
    'malta', 'tenerife', 'kanarya', 'mallorca', 'katalonya', 'endülüs', 'provence', 'marsilya', 'lizbon', 'madrid', 'roma',
    // Americas
    'abd', 'amerika', 'kaliforniya', 'los angeles', 'hawaii', 'maui', 'teksas', 'florida', 'alaska', 'oregon', 'nevada', 'arizona', 'kolorado',
    'washington', 'new york', 'kanada', 'alberta', 'quebec', 'ontario', 'british columbia', 'meksika', 'brezilya', 'amazon', 'şili', 'arjantin',
    'bolivya', 'paraguay', 'uruguay', 'peru', 'kolombiya', 'venezuela', 'ekvador', 'guatemala', 'honduras',
    // Asia-Pacific
    'avustralya', 'yeni zelanda', 'endonezya', 'sumatra', 'borneo', 'kalimantan', 'malezya', 'filipinler', 'tayland', 'vietnam', 'kamboçya',
    'japonya', 'güney kore', 'kuzey kore', 'çin', 'moğolistan', 'hindistan', 'nepal', 'bangladeş', 'pakistan', 'afganistan', 'kazakistan',
    'özbekistan', 'türkmenistan', 'kırgızistan', 'tacikistan',
    // Middle East and Africa
    'israil', 'filistin', 'gazze', 'lübnan', 'beyrut', 'ürdün', 'suudi arabistan', 'yemen', 'mısır', 'libya', 'tunus', 'cezayir', 'fas',
    'afrika', 'güney afrika', 'kongo', 'kenya', 'tanzanya', 'etiyopya', 'nijerya', 'angola', 'zambiya', 'madagaskar',
];
const PROVINCES = [
    'adana', 'adıyaman', 'afyonkarahisar', 'afyon', 'ağrı', 'amasya', 'ankara', 'antalya', 'artvin', 'aydın', 'balıkesir', 'bilecik', 'bingöl',
    'bitlis', 'bolu', 'burdur', 'bursa', 'çanakkale', 'çankırı', 'çorum', 'denizli', 'diyarbakır', 'edirne', 'elazığ', 'erzincan', 'erzurum',
    'eskişehir', 'gaziantep', 'giresun', 'gümüşhane', 'hakkari', 'hakkâri', 'hatay', 'isparta', 'mersin', 'istanbul', 'izmir', 'kars', 'kastamonu',
    'kayseri', 'kırklareli', 'kırşehir', 'kocaeli', 'konya', 'kütahya', 'malatya', 'manisa', 'kahramanmaraş', 'mardin', 'muğla', 'muş', 'nevşehir',
    'niğde', 'ordu', 'rize', 'sakarya', 'samsun', 'siirt', 'sinop', 'sivas', 'tekirdağ', 'tokat', 'trabzon', 'tunceli', 'şanlıurfa', 'uşak', 'van',
    'yozgat', 'zonguldak', 'aksaray', 'bayburt', 'karaman', 'kırıkkale', 'batman', 'şırnak', 'bartın', 'ardahan', 'iğdır', 'yalova', 'karabük',
    'kilis', 'osmaniye', 'düzce',
];
/** Turkey, a province, the border or OGM: the story reaches Turkey. */
const TURKEY_MARKERS = ['türkiye', 'türk', 'ogm', 'orman genel müdürlüğü', ...PROVINCES];
/** Weather idioms that name a place without being about it. */
const NOT_A_PLACE = /afrika sıca\S*|sibirya soğu\S*|balkan soğu\S*/g;
const WORD_CHAR = 'a-zçğıöşüâîû0-9';
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compile = (words) => words.map((w) => ({ w, re: new RegExp(`(^|[^${WORD_CHAR}])${escape(w)}(?![${WORD_CHAR}])`) }));
const FAR_RE = compile(FAR);
const NEIGHBOUR_RE = Object.entries(NEIGHBOURS).map(([country, words]) => ({ country, res: compile(words) }));
const TURKEY_RE = [
    ...compile(TURKEY_MARKERS),
    // "sınırda", "sınırına", "sınır hattı" — but not "sınırlı" or "sınırsız"
    { w: 'sınır', re: new RegExp(`(^|[^${WORD_CHAR}])sınır(?![ls])`) },
];
const PROVINCE_RE = compile(PROVINCES);
const DISPLAY = { afyon: 'afyonkarahisar', 'hakkâri': 'hakkari' };
/** The province a headline names, in its usual spelling, or null. */
function provinceInTitle(title) {
    const text = (0, turkishText_1.turkishToLower)(title);
    const hit = PROVINCE_RE.find(({ re }) => re.test(text));
    if (!hit)
        return null;
    const w = DISPLAY[hit.w] ?? hit.w;
    return (w[0] === 'i' ? 'İ' : w[0] === 'ı' ? 'I' : w[0].toUpperCase()) + w.slice(1);
}
function assessTurkey(title, fullText) {
    const text = (0, turkishText_1.turkishToLower)(`${title} ${fullText}`).replace(NOT_A_PLACE, ' ');
    const far = FAR_RE.filter(({ re }) => re.test(text)).map(({ w }) => w);
    const neighbours = NEIGHBOUR_RE
        .filter(({ res }) => res.some(({ re }) => re.test(text)))
        .map(({ country }) => country);
    if (far.length === 0 && neighbours.length === 0) {
        return { turkey: true, basis: 'no_foreign_place', matched: [] };
    }
    if (far.length > 0)
        return { turkey: false, basis: 'far_country', matched: far };
    const reach = TURKEY_RE.filter(({ re }) => re.test(text)).map(({ w }) => w);
    return reach.length > 0
        ? { turkey: true, basis: 'neighbour_reaching_turkey', matched: [...neighbours, ...reach] }
        : { turkey: false, basis: 'neighbour_only', matched: neighbours };
}
