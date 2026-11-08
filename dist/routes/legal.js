"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
const CONTACT_EMAIL = 'firewatch.tr@gmail.com';
const STYLE = `
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; max-width: 720px; margin: 0 auto; padding: 32px 20px 80px; line-height: 1.6; color: #1a1a1a; }
  h1 { font-size: 26px; margin-bottom: 4px; }
  h2 { font-size: 18px; margin-top: 32px; }
  .updated { color: #666; font-size: 14px; margin-bottom: 8px; }
  .lang-switch { font-size: 14px; margin-bottom: 32px; }
  .lang-switch a { margin-right: 12px; }
  ul { padding-left: 20px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border: 1px solid #ddd; vertical-align: top; }
  th { background: #f5f5f5; }
  a { color: #d84315; }
  hr { border: none; border-top: 1px solid #e2e2e2; margin: 48px 0; }
`;
function page(title, body, lang = 'en') {
    return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}
// Every promise in the privacy policy is enforced in code — keep them in
// step: rounding, erasure and log redaction in utils/locationPrivacy.ts and
// controllers/notificationController.ts, the 90-day deletion in
// jobs/privacyRetentionJob.ts.
const POLICY_DATE_TR = '8 Kasım 2026';
const POLICY_DATE_EN = 'November 8, 2026';
const privacyTr = `
<h1>FireWatch TR — Gizlilik Politikası</h1>
<p class="updated">Son güncelleme: ${POLICY_DATE_TR}</p>
<p class="lang-switch"><a href="/privacy/en">English version</a> · <a href="/privacy/tr">Türkçe</a></p>

<p>FireWatch TR ("uygulama"), uydu verileriyle Türkiye'deki orman yangını ve termal tespit bilgilerini gösterir. Bu sayfa hangi verileri işlediğimizi, neden işlediğimizi, ne kadar sakladığımızı ve verilerinizle ilgili haklarınızı açıklar. Uygulamayı kullanmak için hesap açmanız gerekmez.</p>

<h2>Sunucumuzda sakladığımız veriler</h2>
<table>
<tr><th>Veri</th><th>Ne zaman ve neden</th><th>Ne kadar süre</th></tr>
<tr><td>Yaklaşık konum (yaklaşık 1 km hassasiyetinde enlem/boylam)</td><td>Yalnızca konum izni verip bildirimler için otomatik taramayı başlattığınızda. Size bölgenizle ilgili yangın ve risk uyarıları gönderebilmek için. Tam konumunuz saklanmaz; sunucuya yazılmadan önce yaklaşık 1 km'ye yuvarlanır.</td><td>Bildirimler açık olduğu sürece. Bildirimleri kapattığınızda, uygulamada "Konum verimi sil"e dokunduğunuzda veya cihaz belirteciniz geçersizleştiğinde (ör. uygulamayı kaldırdığınızda) hemen silinir.</td></tr>
<tr><td>Cihaz belirteci (Firebase Cloud Messaging token), bildirim kapsamı tercihi (tüm Türkiye / bölge / il), kayıt ve güncelleme zamanı</td><td>Bildirim gönderebilmek ve seçtiğiniz kapsama uymak için. Uygulama her açıldığında belirteci yeniler.</td><td>Uygulamayı son açışınızdan itibaren 90 gün; sonra kayıt tamamen silinir. Uygulamayı yeniden açtığınızda yeni kayıt oluşur.</td></tr>
<tr><td>Yerlerim: verdiğiniz ad, yaklaşık 1 km'ye yuvarlanmış konum, yarıçap (5/10/25 km), iki bildirim tercihi (yeni ısı tespiti, yangın riski), o yer için son risk seviyesi; bu yerler için gönderilen ve bildirim sınırı nedeniyle sonraki bir özete bırakılan uyarıların kaydı (yer, tespit, zaman). Cihazınız hesapla değil, uygulamanın ürettiği rastgele bir kimlikle tanınır; sunucuda bu kimliğin yalnızca gizli anahtarının özeti (hash) tutulur.</td><td>Yalnızca "Yerlerim"e yer eklediğinizde. Yarıçap içinde yeni uydu ısı tespiti olduğunda ya da o yerin yangın riski Yüksek veya Kritik seviyesine çıktığında (günde en fazla bir kez, açılıp kapatılabilir) size bildirim göndermek ve aynı olay için ikinci bildirim göndermemek için.</td><td>Siz silene kadar. Uygulamayı 90 gün açmazsanız ya da cihaz belirteciniz 7 gündür geçersizse tüm yerleriniz silinir. Uyarı kayıtları 30 gün sonra silinir.</td></tr>
<tr><td>Yer araması: "Yerlerim"de yazdığınız arama metni</td><td>Yalnızca "Ara"ya bastığınızda ve mahalle veya adres aranıyorsa. Sonucu bulmak için sunucumuz aracılığıyla OpenStreetMap Nominatim'e iletilir; IP adresiniz ve cihaz kimliğiniz Nominatim'e gönderilmez. İl ve ilçe aramaları telefonunuzda yapılır, gönderilmez.</td><td>Arama metni kaydedilmez ve kayıtlara yazılmaz. Sonuçlar, aynı aramayı tekrarlamamak için metnin geri çevrilemez özetiyle (hash) en fazla 7 gün önbellekte tutulur.</td></tr>
<tr><td>Yangın ihbarı: yaklaşık 1 km'ye yuvarlanmış konum, başlık, açıklama, isteğe bağlı ad ve en fazla 3 fotoğraf</td><td>Yalnızca ihbar gönderdiğinizde. İhbarı incelemek ve uydu tespitleriyle karşılaştırmak için.</td><td>90 gün; sonra fotoğraflarıyla birlikte silinir.</td></tr>
<tr><td>Geri bildirim: puan, kategori, mesaj, uygulama sürümü ve isteğe bağlı e-posta adresi</td><td>Yalnızca geri bildirim gönderdiğinizde. Uygulamayı geliştirmek ve isterseniz size dönebilmek için.</td><td>Silinmesini isteyene kadar.</td></tr>
<tr><td>Sunucu erişim kayıtları: IP adresi, istek yolu, zaman, tarayıcı/uygulama bilgisi</td><td>Hizmeti çalıştırmak, hataları ve kötüye kullanımı tespit etmek için. Konum bilgisi bu kayıtlara yazılmaz.</td><td>Barındırma sağlayıcısının (Render) kısa süreli kayıt saklama süresi boyunca.</td></tr>
</table>

<h2>Konum nasıl kullanılır</h2>
<ul>
  <li><strong>Cihazınızda:</strong> Size yakın tespitlere olan mesafe telefonunuzda hesaplanır.</li>
  <li><strong>Noktasal risk:</strong> Konumum'da ya da bir yerin analizinde risk puanı sunucumuzda hesaplanır. Bunun için nokta yaklaşık 10 km'ye yuvarlanır; hava durumu bu yuvarlanmış noktayla Open-Meteo veya MET Norway'den alınır. Sonuç, yuvarlanmış noktayla en fazla 15 dakika önbellekte tutulur, veritabanına yazılmaz.</li>
  <li><strong>En yakın il sorgusu:</strong> Bulunduğunuz ili göstermek için konumunuz sunucumuza gönderilir. Bu sorgudaki konum saklanmaz ve kayıtlara yazılmaz.</li>
  <li><strong>Bildirimler:</strong> Otomatik taramayı başlattığınızda yaklaşık konumunuz (yaklaşık 1 km) yukarıdaki tabloda yazdığı gibi saklanır.</li>
  <li><strong>Yerlerim:</strong> Aradığınız, haritadan seçtiğiniz ya da "Konumumu ekle" ile o anki konumunuzdan eklediğiniz noktalar yaklaşık 1 km'ye yuvarlanarak saklanır. Yeni tespitlerle eşleştirme sunucuda bu noktalara göre yapılır; bunun için cihazınızın konumu izlenmez.</li>
  <li><strong>Arka plan konumu:</strong> İsteğe bağlıdır ve uygulamada ayrıca onay ister. Uygulama kapalıyken yakındaki tespitleri telefonunuzda kontrol etmek için kullanılır; bu kontrol sırasında konumunuz sunucuya gönderilmez.</li>
  <li>Konum izni vermeden de uygulamayı kullanabilirsiniz. İzni istediğiniz zaman telefon ayarlarından kaldırabilirsiniz.</li>
</ul>

<h2>Yalnızca cihazınızda kalan veriler</h2>
<p>Dil ve bildirim tercihleri, haritadaki il/ilçe kısayollarınız, izleme listeniz ve uygulama içi uyarı kutunuz telefonunuzda saklanır; bize gönderilmez. Uygulamayı kaldırdığınızda silinir.</p>

<h2>Verileri kimlerle paylaşıyoruz</h2>
<p>Verilerinizi satmayız, reklam için kullanmayız ve reklam ağlarıyla paylaşmayız. Uygulamada analitik veya izleme yazılımı yoktur. Verileriniz yalnızca hizmeti bizim adımıza çalıştıran altyapı sağlayıcılarında işlenir:</p>
<ul>
  <li><strong>Render</strong> — sunucu barındırma ve erişim kayıtları</li>
  <li><strong>Neon</strong> — veritabanı (Frankfurt, Almanya)</li>
  <li><strong>Firebase Cloud Messaging (Google)</strong> — bildirimlerin cihazınıza iletilmesi (cihaz belirteci ve bildirim içeriği)</li>
  <li><strong>Upstash</strong> — önbellek; kişisel veri tutulmaz</li>
</ul>
<p>Bu sağlayıcıların sunucuları Türkiye dışında (AB ve ABD) bulunabilir; verileriniz hizmetin sunulması için bu ülkelere aktarılır.</p>

<h2>Uygulamanın doğrudan bağlandığı servisler</h2>
<p>Harita ve bazı katmanlar için uygulama aşağıdaki servislere doğrudan bağlanır. Bu servisler, her internet bağlantısında olduğu gibi IP adresinizi görür; kimliğinizi veya cihaz belirtecinizi göndermeyiz.</p>
<ul>
  <li><strong>CARTO ve OpenStreetMap</strong> — harita karoları (görüntülediğiniz harita bölgesi)</li>
  <li><strong>Google Fonts</strong> — yazı tipleri</li>
  <li><strong>Copernicus EFFIS/GWIS</strong> — yangın hava indeksi; bir yerin indeksine baktığınızda o yerin koordinatları gönderilir. Bu gösterge FireWatch risk puanından ayrıdır ve puana katılmaz</li>
  <li><strong>Open-Meteo</strong> — bir yangının bulunduğu noktadaki rüzgâr (sizin konumunuz değil, yangının konumu gönderilir)</li>
</ul>
<p>Yangın ve termal tespit verileri (NASA FIRMS) ile risk hesabındaki hava durumu (Open-Meteo, MET Norway) sunucumuz tarafından çekilir; bu isteklerde sizinle ilgili veri yoktur. "Paylaş" düğmesiyle gönderdiğiniz içerik seçtiğiniz uygulamaya gider ve sunucumuzdan geçmez.</p>
<p><strong>Veri kaynakları ve atıflar:</strong> Adres araması <a href="https://nominatim.openstreetmap.org/">Nominatim</a> ile yapılır; veriler © OpenStreetMap katkıcıları, ODbL. İl sınırları (haritadaki "Geçmiş yıllar" katmanı ve tespitlerin hangi ile atandığı) <a href="https://www.geoboundaries.org/">geoBoundaries</a> (gbOpen, TUR ADM1) üzerinden OpenStreetMap verisinden türetilmiştir — <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap katkıcıları</a>, <a href="https://opendatacommons.org/licenses/odbl/1-0/">ODbL</a>. Uydu tespitleri NASA FIRMS; hava verisi Open-Meteo ve MET Norway. Bu veriler cihazınızdan bilgi içermez.</p>

<h2>Haklarınız ve verilerinizi silme</h2>
<ul>
  <li><strong>Konum ve takip edilen yerler:</strong> Uygulamada Ayarlar → "Konum verimi sil" sunucudaki konumunuzu ve Yerlerim'deki tüm yerleri hemen siler. Tek bir yeri listeden silebilirsiniz. Bildirimleri kapatmak bildirim konumunuzu siler.</li>
  <li><strong>Diğer veriler:</strong> İhbar, geri bildirim veya e-posta adresinizin silinmesini, verilerinize erişimi ya da düzeltilmesini <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> adresinden isteyebilirsiniz. Kaydı bulabilmemiz için ihbarın veya geri bildirimin tarihini belirtin. Talebinize en geç 30 gün içinde yanıt veririz.</li>
  <li>6698 sayılı Kişisel Verilerin Korunması Kanunu (KVKK) ve uygulandığı durumlarda GDPR kapsamındaki haklarınızı aynı adresten kullanabilirsiniz.</li>
</ul>

<h2>Değişiklikler</h2>
<p>Bu politikayı değiştirdiğimizde bu sayfadaki tarihi güncelleriz; önemli değişiklikleri uygulama içinde de duyururuz.</p>

<h2>İletişim</h2>
<p>Bu politika veya verileriniz hakkındaki sorularınız için: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
`;
const privacyEn = `
<h1>FireWatch TR — Privacy Policy</h1>
<p class="updated">Last updated: ${POLICY_DATE_EN}</p>
<p class="lang-switch"><a href="/privacy/en">English version</a> · <a href="/privacy/tr">Türkçe</a></p>

<p>FireWatch TR ("the app") shows wildfire and thermal-detection information for Turkey based on satellite data. This page explains what data we process, why, how long we keep it, and your rights over it. You do not need an account to use the app.</p>

<h2>Data we store on our server</h2>
<table>
<tr><th>Data</th><th>When and why</th><th>How long</th></tr>
<tr><td>Approximate location (latitude/longitude rounded to about 1 km)</td><td>Only when you grant location permission and start automatic monitoring for notifications. Used to send you fire and risk alerts for your area. Your exact location is never stored; it is rounded to about 1 km before it is written.</td><td>While notifications are on. Deleted immediately when you turn notifications off, tap "Delete my location data" in the app, or your device token becomes invalid (e.g. you uninstall the app).</td></tr>
<tr><td>Device token (Firebase Cloud Messaging), notification scope (all of Turkey / region / province), registration and update time</td><td>To deliver notifications and respect the scope you chose. The app refreshes the token each time it opens.</td><td>90 days after you last opened the app, then deleted entirely. Opening the app again creates a new record.</td></tr>
<tr><td>My Places: the name you give, location rounded to about 1 km, radius (5/10/25 km), alert setting; a record of alerts sent for them or held back for a later summary because of the notification limit (place, detection, time). Your device is identified by a random ID the app generates, not by an account; the server keeps only a hash of that ID's secret key.</td><td>Only when you add a place to "My places". Used to notify you of new satellite heat detections within the radius, and never twice for the same detection.</td><td>Until you delete them. If you don't open the app for 90 days, or your device token has been invalid for 7 days, all your places are deleted. Alert records are deleted after 30 days.</td></tr>
<tr><td>Place search: the text you type in My Places</td><td>Only when you press Search for a neighbourhood or address. It is passed through our server to OpenStreetMap Nominatim; your IP address and device identity are not sent to Nominatim. Province and district searches run on your phone and are not sent.</td><td>The search text is not stored or logged. Results are cached for up to 7 days under an irreversible hash of the text, so the same search is not repeated.</td></tr>
<tr><td>Fire report: location rounded to about 1 km, title, description, optional name and up to 3 photos</td><td>Only when you send a report. Used to review it and compare it with satellite detections.</td><td>90 days, then deleted together with its photos.</td></tr>
<tr><td>Feedback: rating, category, message, app version and an optional email address</td><td>Only when you send feedback. Used to improve the app and, if you wish, to reply to you.</td><td>Until you ask us to delete it.</td></tr>
<tr><td>Server access logs: IP address, request path, time, browser/app information</td><td>To run the service and detect errors and abuse. Locations are never written to these logs.</td><td>For the short log retention period of our hosting provider (Render).</td></tr>
</table>

<h2>How location is used</h2>
<ul>
  <li><strong>Risk at a point:</strong> On My Location or a place's analysis, the risk score is calculated on our server. The point is rounded to about 10 km first; the weather is fetched for that rounded point from Open-Meteo or MET Norway. The result is cached with the rounded point for up to 15 minutes and is not written to the database.</li>
  <li><strong>On your device:</strong> distance to nearby detections is calculated on your phone.</li>
  <li><strong>Nearest-province lookup:</strong> your location is sent to our server to show which province you are in. The location in this lookup is not stored and not logged.</li>
  <li><strong>Notifications:</strong> when you start automatic monitoring, your approximate location (about 1 km) is stored as described in the table above.</li>
  <li><strong>My Places:</strong> points you search for, pick on the map, or add from your current location with "Use my location", are stored rounded to about 1 km. New detections are matched against these points on the server; your device's location is not tracked for this.</li>
  <li><strong>Background location:</strong> optional, with a separate in-app consent. It lets your phone check for nearby detections while the app is closed; your location is not sent to the server during these checks.</li>
  <li>You can use the app without location permission, and you can revoke the permission at any time in your phone's settings.</li>
</ul>

<h2>Data that stays on your device</h2>
<p>Language and notification preferences, your province/district map shortcuts, your watchlist and the in-app alert inbox are stored on your phone and never sent to us. They are removed when you uninstall the app.</p>

<h2>Who we share data with</h2>
<p>We do not sell your data, use it for advertising, or share it with ad networks. The app contains no analytics or tracking software. Your data is processed only by infrastructure providers that run the service on our behalf:</p>
<ul>
  <li><strong>Render</strong> — server hosting and access logs</li>
  <li><strong>Neon</strong> — database (Frankfurt, Germany)</li>
  <li><strong>Firebase Cloud Messaging (Google)</strong> — delivering notifications to your device (device token and notification content)</li>
  <li><strong>Upstash</strong> — cache; holds no personal data</li>
</ul>
<p>These providers may operate servers outside Turkey (in the EU and the US); your data is transferred there to provide the service.</p>

<h2>Services the app connects to directly</h2>
<p>For the map and some layers, the app connects directly to the services below. Like any internet connection, they see your IP address; we do not send them your identity or device token.</p>
<ul>
  <li><strong>CARTO and OpenStreetMap</strong> — map tiles (the map area you view)</li>
  <li><strong>Google Fonts</strong> — fonts</li>
  <li><strong>Copernicus EFFIS/GWIS</strong> — fire weather index; when you look up the index for a place, that place's coordinates are sent. This indicator is separate from the FireWatch risk score and does not feed into it</li>
  <li><strong>Open-Meteo</strong> — wind at a fire's location (the fire's location is sent, not yours)</li>
</ul>
<p>Fire and thermal detections (NASA FIRMS) and the weather used for risk scoring (Open-Meteo, MET Norway) are fetched by our server; those requests contain no data about you. Content you send with a "Share" button goes to the app you choose and does not pass through our server.</p>
<p><strong>Data sources and attribution:</strong> Address search uses <a href="https://nominatim.openstreetmap.org/">Nominatim</a>; data © OpenStreetMap contributors, ODbL. Province boundaries (the map's "Past years" layer and the province a detection is assigned to) are derived from OpenStreetMap data via <a href="https://www.geoboundaries.org/">geoBoundaries</a> (gbOpen, TUR ADM1) — <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>, <a href="https://opendatacommons.org/licenses/odbl/1-0/">ODbL</a>. Satellite detections: NASA FIRMS; weather: Open-Meteo and MET Norway. None of this contains information from your device.</p>

<h2>Your rights and deleting your data</h2>
<ul>
  <li><strong>Location and tracked places:</strong> Settings → "Delete my location data" in the app deletes your location and all your places from our server immediately. You can delete a single place from the list. Turning notifications off deletes your notification location.</li>
  <li><strong>Other data:</strong> to have a report, feedback or email address deleted, or to access or correct your data, write to <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>. Please include the date of the report or feedback so we can find it. We reply within 30 days.</li>
  <li>You can exercise your rights under Turkey's Personal Data Protection Law No. 6698 (KVKK) and, where it applies, the GDPR at the same address.</li>
</ul>

<h2>Changes</h2>
<p>When we change this policy we update the date on this page, and we announce significant changes in the app.</p>

<h2>Contact</h2>
<p>Questions about this policy or your data: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
`;
router.get('/privacy', (req, res) => {
    res.type('html').send(page('FireWatch TR — Privacy Policy / Gizlilik Politikası', `${privacyTr}<hr/>${privacyEn}`, 'tr'));
});
router.get('/privacy/tr', (req, res) => {
    res.type('html').send(page('FireWatch TR — Gizlilik Politikası', privacyTr, 'tr'));
});
router.get('/privacy/en', (req, res) => {
    res.type('html').send(page('FireWatch TR — Privacy Policy', privacyEn, 'en'));
});
const termsTr = `
<h1>FireWatch TR — Kullanım Koşulları</h1>
<p class="updated">Son güncelleme: 2026</p>
<p class="lang-switch"><a href="/terms/en">English version</a> · <a href="/terms/tr">Türkçe</a></p>

<p>FireWatch TR'yi kullanarak aşağıdaki koşulları kabul etmiş olursunuz:</p>

<h2>Yalnızca bilgilendirme amaçlıdır</h2>
<p>FireWatch TR, uydu tabanlı termal anomali verilerini bilgilendirme amacıyla gösterir. Uygulama <strong>resmi bir acil durum uyarı sistemi değildir</strong> ve bir yangın veya başka bir acil durumda tek bilgi kaynağınız olarak kullanılmamalıdır. Her zaman AFAD, yerel yetkililer ve acil durum servislerinin resmi yönlendirmelerini takip edin. Acil bir durumda <strong>112</strong> (Acil Çağrı Merkezi) veya <strong>177</strong> (Orman Yangını İhbar Hattı) numaralarını arayın.</p>

<h2>NASA verisinin doğruluğu</h2>
<p>Yangın/termal tespitler NASA FIRMS'ten gelir ve gecikmeli, eksik olabilir veya yanlış pozitif içerebilir (ör. endüstriyel ısı kaynakları). Doğruluk, eksiksizlik veya güncellik konusunda garanti vermiyoruz.</p>

<h2>Kullanıcı tarafından gönderilen raporlar</h2>
<p>Uygulama içinde gönderilen yangın raporları <strong>doğrulanmamıştır</strong> — NASA verisiyle çapraz kontrol edilse de, insan tarafından bildirilen bilgiler yanlış, yanıltıcı veya güncel olmayabilir. Gönderdiğiniz içerik doğru, kötüye kullanım içermeyen ve yasal olmalıdır; bu koşulları ihlal eden içerikleri kaldırabiliriz.</p>

<h2>Garanti yok</h2>
<p>Uygulama "olduğu gibi" ve herhangi bir garanti verilmeksizin sunulur. Uygulamada gösterilen bilgilere dayanarak alınan kararlardan sorumlu değiliz.</p>

<h2>İletişim</h2>
<p>Bu koşullarla ilgili sorularınızı <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> adresine gönderebilirsiniz.</p>
`;
const termsEn = `
<h1>FireWatch TR — Terms of Service</h1>
<p class="updated">Last updated: 2026</p>
<p class="lang-switch"><a href="/terms/en">English version</a> · <a href="/terms/tr">Türkçe</a></p>

<p>By using FireWatch TR, you agree to the following:</p>

<h2>Informational purposes only</h2>
<p>FireWatch TR displays satellite-derived thermal anomaly data for informational purposes. The app is <strong>not an official emergency warning system</strong> and must not be your sole source of information during a wildfire or other emergency. Always follow official guidance from AFAD, local authorities, and emergency services. In an emergency, call <strong>112</strong> (Emergency Call Center) or <strong>177</strong> (Forest Fire Reporting Line).</p>

<h2>NASA data accuracy</h2>
<p>Fire/thermal detections come from NASA FIRMS and may be delayed, incomplete, or include false positives (e.g. industrial heat sources). We make no guarantee of accuracy, completeness, or timeliness.</p>

<h2>User-submitted reports</h2>
<p>Fire reports submitted through the app are <strong>not verified</strong> — while cross-checked against NASA data, human-submitted information may be inaccurate, misleading, or out of date. Content you submit must be accurate, non-abusive, and lawful; we may remove content that violates this.</p>

<h2>No warranty</h2>
<p>The app is provided "as is" without warranty of any kind. We are not liable for decisions made based on information shown in the app.</p>

<h2>Contact</h2>
<p>Questions about these terms can be sent to <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
`;
router.get('/terms', (req, res) => {
    res.type('html').send(page('FireWatch TR — Terms of Service / Kullanım Koşulları', `${termsTr}<hr/>${termsEn}`, 'tr'));
});
router.get('/terms/tr', (req, res) => {
    res.type('html').send(page('FireWatch TR — Kullanım Koşulları', termsTr, 'tr'));
});
router.get('/terms/en', (req, res) => {
    res.type('html').send(page('FireWatch TR — Terms of Service', termsEn, 'en'));
});
exports.default = router;
