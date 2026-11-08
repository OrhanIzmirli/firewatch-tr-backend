/**
 * Which news sources the backend may read automatically. Decided by the
 * source audit of 2026-11-08 (each source's terms and robots.txt). Only a
 * headline, the source's name and a link are kept; text is never stored.
 */

/** Client identity. Never pretend to be a browser: a source that refuses bots is respected. */
export const NEWS_USER_AGENT = 'FireWatchTR/1.2 (wildfire information app; firewatch.tr@gmail.com)';

/** Publishers offering RSS whose terms do not forbid automated reading of headlines (audit of 2026-11-08). */
export const RSS_SOURCES: { url: string; source: string; region: string | null }[] = [
  // National
  { url: "https://www.indyturk.com/rss.xml", source: "Independent Türkçe", region: null },
  { url: "https://bianet.org/rss/bianet", source: "Bianet", region: null },
  { url: "https://www.diken.com.tr/feed/", source: "Diken", region: null },
  { url: "https://www.evrensel.net/rss/haber.xml", source: "Evrensel", region: null },
  { url: "https://www.karar.com/rss", source: "Karar", region: null },
  { url: "https://yesilgazete.org/feed/", source: "Yeşil Gazete", region: null },
  { url: "https://haber.sol.org.tr/rss.xml", source: "soL Haber", region: null },
  { url: "https://www.yeniasya.com.tr/rss/son-dakika", source: "Yeni Asya", region: null },
  { url: "https://serbestiyet.com/feed/", source: "Serbestiyet", region: null },
  // Local
  { url: 'https://www.izmirhaber.com.tr/rss', source: 'İzmir Haber', region: 'Ege' },
  { url: 'https://www.bursahaber.com/rss', source: 'Bursa Haber', region: 'Marmara' },
  { url: "https://www.antalyaekspres.com.tr/rss", source: "Antalya Ekspres", region: "Akdeniz" },
  { url: "https://www.antalyakorfez.com/rss", source: "Antalya Körfez", region: "Akdeniz" },
  { url: "https://fethiyegazetesi.com/feed/", source: "Fethiye Gazetesi", region: "Ege" },
  { url: "https://www.fethiyehaber.com/feed/", source: "Fethiye Haber", region: "Ege" },
  { url: "https://www.egedesonsoz.com/rss", source: "Ege'de Son Söz", region: "Ege" },
  { url: "https://www.egetelgraf.com/rss", source: "Ege Telgraf", region: "Ege" },
  { url: "https://www.haberekspres.com.tr/rss", source: "Haber Ekspres", region: "Ege" },
  { url: "https://www.aydinhaberleri.com/rss", source: "Aydın Haberleri", region: "Ege" },
  { url: "https://www.aydinpost.com/rss", source: "Aydın Post", region: "Ege" },
  { url: "https://www.aydinses.com/rss", source: "Aydın Ses", region: "Ege" },
  { url: "https://www.manisahaber.com/rss", source: "Manisa Haber", region: "Ege" },
  { url: "https://www.manisahaberleri.com/rss", source: "Manisa Haberleri", region: "Ege" },
  { url: "https://www.mersinhaber.com/sitemap/rss", source: "Mersin Haber", region: "Akdeniz" },
  { url: "https://www.tarsusgazetesi.com/feed", source: "Tarsus Gazetesi", region: "Akdeniz" },
  { url: "https://hatayvatan.com/feed", source: "Hatay Vatan", region: "Akdeniz" },
  { url: "https://www.iskenderungazetesi.com/feed/", source: "İskenderun Gazetesi", region: "Akdeniz" },
  { url: "https://www.kahramanmarashaber.com/feed/", source: "Kahramanmaraş Haber", region: "Akdeniz" },
  { url: "https://www.16haber.com/rss.xml", source: "16 Haber", region: "Marmara" },
  { url: "https://www.bursagazetesi.com/rss", source: "Bursa Gazetesi", region: "Marmara" },
  { url: "https://www.yenimarmaragazetesi.com/rss", source: "Yeni Marmara", region: "Marmara" },
  { url: "https://gazetekocaeli.com/feed/", source: "Gazete Kocaeli", region: "Marmara" },
  { url: "https://gazetesakarya.com/feed/", source: "Gazete Sakarya", region: "Marmara" },
  { url: "https://www.yenisakarya.com/rss", source: "Yeni Sakarya", region: "Marmara" },
  { url: "https://www.bolununsesi.com/rss", source: "Bolunun Sesi", region: "Karadeniz" },
  { url: "https://karabukajans.com/rss", source: "Karabük Ajans", region: "Karadeniz" },
];

/** Public announcements of state institutions, read from their own news lists. */
export const OFFICIAL_SOURCES: { url: string; source: string; format: 'ogm' | 'cards' }[] = [
  { url: "https://www.ogm.gov.tr/tr/haberler", source: "OGM", format: 'ogm' },
  { url: "https://www.ogm.gov.tr/antalyaobm/haberler", source: "OGM Antalya", format: 'ogm' },
  { url: "https://www.ogm.gov.tr/muglaobm/haberler", source: "OGM Muğla", format: 'ogm' },
  { url: "https://www.ogm.gov.tr/izmirobm/haberler", source: "OGM İzmir", format: 'ogm' },
  { url: "https://www.ogm.gov.tr/adanaobm/haberler", source: "OGM Adana", format: 'ogm' },
  { url: "https://www.ogm.gov.tr/mersinobm/haberler", source: "OGM Mersin", format: 'ogm' },
  { url: "https://www.ogm.gov.tr/canakkaleobm/haberler", source: "OGM Çanakkale", format: 'ogm' },
  { url: "https://www.ogm.gov.tr/balikesirobm/haberler", source: "OGM Balıkesir", format: 'ogm' },
  { url: "https://www.ogm.gov.tr/bursaobm/haberler", source: "OGM Bursa", format: 'ogm' },
  { url: "https://www.ogm.gov.tr/kastamonuobm/haberler", source: "OGM Kastamonu", format: 'ogm' },
  { url: "https://www.ogm.gov.tr/denizliobm/haberler", source: "OGM Denizli", format: 'ogm' },
  { url: "https://www.ogm.gov.tr/kahramanmarasobm/haberler", source: "OGM Kahramanmaraş", format: 'ogm' },
  { url: "https://www.ogm.gov.tr/boluobm/haberler", source: "OGM Bolu", format: 'ogm' },
  { url: "https://www.ogm.gov.tr/sakaryaobm/haberler", source: "OGM Sakarya", format: 'ogm' },
  { url: "https://www.ogm.gov.tr/zonguldakobm/haberler", source: "OGM Zonguldak", format: 'ogm' },
  { url: "https://www.afad.gov.tr/haberler", source: "AFAD", format: 'cards' },
  { url: "https://antalya.afad.gov.tr/haberler", source: "AFAD Antalya", format: 'cards' },
  { url: "https://www.antalya.gov.tr/haberler", source: "Antalya Valiliği", format: 'cards' },
  { url: "https://mugla.afad.gov.tr/haberler", source: "AFAD Muğla", format: 'cards' },
  { url: "https://www.mugla.gov.tr/haberler", source: "Muğla Valiliği", format: 'cards' },
  { url: "https://izmir.afad.gov.tr/haberler", source: "AFAD İzmir", format: 'cards' },
  { url: "https://aydin.afad.gov.tr/haberler", source: "AFAD Aydın", format: 'cards' },
  { url: "https://www.aydin.gov.tr/haberler", source: "Aydın Valiliği", format: 'cards' },
  { url: "https://manisa.afad.gov.tr/haberler", source: "AFAD Manisa", format: 'cards' },
  { url: "https://www.manisa.gov.tr/haberler", source: "Manisa Valiliği", format: 'cards' },
  { url: "https://denizli.afad.gov.tr/haberler", source: "AFAD Denizli", format: 'cards' },
  { url: "https://www.denizli.gov.tr/haberler", source: "Denizli Valiliği", format: 'cards' },
  { url: "https://balikesir.afad.gov.tr/haberler", source: "AFAD Balıkesir", format: 'cards' },
  { url: "https://www.balikesir.gov.tr/haberler", source: "Balıkesir Valiliği", format: 'cards' },
  { url: "https://canakkale.afad.gov.tr/haberler", source: "AFAD Çanakkale", format: 'cards' },
  { url: "https://www.canakkale.gov.tr/haberler", source: "Çanakkale Valiliği", format: 'cards' },
  { url: "https://mersin.afad.gov.tr/haberler", source: "AFAD Mersin", format: 'cards' },
  { url: "https://www.mersin.gov.tr/haberler", source: "Mersin Valiliği", format: 'cards' },
  { url: "https://adana.afad.gov.tr/haberler", source: "AFAD Adana", format: 'cards' },
  { url: "https://www.adana.gov.tr/haberler", source: "Adana Valiliği", format: 'cards' },
  { url: "https://hatay.afad.gov.tr/haberler", source: "AFAD Hatay", format: 'cards' },
  { url: "https://www.hatay.gov.tr/haberler", source: "Hatay Valiliği", format: 'cards' },
  { url: "https://kahramanmaras.afad.gov.tr/haberler", source: "AFAD Kahramanmaraş", format: 'cards' },
  { url: "https://www.kahramanmaras.gov.tr/haberler", source: "Kahramanmaraş Valiliği", format: 'cards' },
  { url: "https://bursa.afad.gov.tr/haberler", source: "AFAD Bursa", format: 'cards' },
  { url: "https://www.bursa.gov.tr/haberler", source: "Bursa Valiliği", format: 'cards' },
  { url: "https://kocaeli.afad.gov.tr/haberler", source: "AFAD Kocaeli", format: 'cards' },
  { url: "https://www.kocaeli.gov.tr/haberler", source: "Kocaeli Valiliği", format: 'cards' },
  { url: "https://sakarya.afad.gov.tr/haberler", source: "AFAD Sakarya", format: 'cards' },
  { url: "https://www.sakarya.gov.tr/haberler", source: "Sakarya Valiliği", format: 'cards' },
  { url: "https://bolu.afad.gov.tr/haberler", source: "AFAD Bolu", format: 'cards' },
  { url: "https://www.bolu.gov.tr/haberler", source: "Bolu Valiliği", format: 'cards' },
  { url: "https://kastamonu.afad.gov.tr/haberler", source: "AFAD Kastamonu", format: 'cards' },
  { url: "https://www.kastamonu.gov.tr/haberler", source: "Kastamonu Valiliği", format: 'cards' },
  { url: "https://karabuk.afad.gov.tr/haberler", source: "AFAD Karabük", format: 'cards' },
  { url: "https://www.karabuk.gov.tr/haberler", source: "Karabük Valiliği", format: 'cards' },
];

/** Names under which sources removed by the audit were stored; never shown again. */
export const REMOVED_NEWS_SOURCES = [
  'NTV Türkiye', 'Hürriyet', 'CNN Türk', 'Sabah', 'Milliyet', 'Haberturk', 'TRT Haber', 'AA', 'Sözcü',
];

/** The same publishers' sites: GDELT lists them too, and they stay out that way as well. */
const REMOVED_DOMAINS = [
  'ntv.com.tr', 'hurriyet.com.tr', 'cnnturk.com', 'sabah.com.tr', 'milliyet.com.tr',
  'haberturk.com', 'trthaber.com', 'trt.net.tr', 'aa.com.tr', 'sozcu.com.tr',
];

export function isRemovedDomain(domain: string): boolean {
  const d = domain.toLowerCase().replace(/^www\./, '');
  return REMOVED_DOMAINS.some((r) => d === r || d.endsWith(`.${r}`));
}
