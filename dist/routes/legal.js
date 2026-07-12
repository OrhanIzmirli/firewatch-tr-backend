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
function page(title, body) {
    return `<!DOCTYPE html>
<html lang="en">
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
const privacyTr = `
<h1>FireWatch TR — Gizlilik Politikası</h1>
<p class="updated">Son güncelleme: 2026</p>
<p class="lang-switch"><a href="/privacy/en">English version</a> · <a href="/privacy/tr">Türkçe</a></p>

<p>FireWatch TR ("uygulama"), NASA uydu verilerini kullanarak Türkiye genelinde orman yangını ve termal anomali bilgisi gösterir. Bu sayfa hangi verileri topladığımızı, neden topladığımızı ve verilerinizle ilgili haklarınızı açıklar.</p>

<h2>Topladığımız veriler</h2>
<table>
<tr><th>Veri türü</th><th>Neden toplanır</th></tr>
<tr><td>Konum (GPS koordinatları)</td><td>Yakınındaki yangın tespitlerini göstermek ve isteğe bağlı arka plan uyarıları için. Sadece izin verdiğinde toplanır.</td></tr>
<tr><td>Cihaz belirteci (FCM token)</td><td>Push bildirimleri (yangın uyarıları) göndermek için.</td></tr>
<tr><td>Yangın raporları</td><td>Kullanıcının gönül gönüllü bildirdiği yangınlar: konum (lat/lng), fotoğraf (isteğe bağlı), açıklama.</td></tr>
<tr><td>Geri bildirim / hata bildirimi</td><td>Puan, kategori, mesaj ve isteğe bağlı e-posta — uygulamayı geliştirmek için.</td></tr>
<tr><td>Uygulama kullanımı</td><td>Toplanmıyor. Uygulamada herhangi bir analitik/izleme SDK'sı bulunmamaktadır.</td></tr>
</table>

<h2>Konum verisi</h2>
<p>İzin verdiğinde, uygulama konumunu yalnızca bilinen termal tespitlere olan mesafeyi hesaplamak için kullanır. Konum verisi sunucuda saklanmaz — tek bir hesaplama için bellekte kullanılır ve hemen atılır. Arka plan konum erişimi tamamen isteğe bağlıdır ve uygulama içinde ayrı, açık bir onay gerektirir.</p>

<h2>NASA yangın/termal verisi</h2>
<p>Yangın ve termal anomali verileri NASA'nın FIRMS (Fire Information for Resource Management System) servisinden gelir. Bu veri kamuya açık uydu bilgisidir ve kimliğinizle ilişkilendirilmez.</p>

<h2>Veri saklama süresi</h2>
<p>Konum verisi hiç saklanmaz. Yangın raporları ve geri bildirimler, uygulamayı işletmek ve geliştirmek amacıyla süresiz olarak saklanır; silinmesini istediğinizde aşağıdaki iletişim adresinden talep edebilirsiniz. FCM cihaz belirteci, bildirimleri kapattığınızda veya uygulamayı kaldırdığınızda pasif hale gelir.</p>

<h2>Üçüncü taraf servisler</h2>
<p>Uygulama şu üçüncü taraf servisleri kullanır:</p>
<ul>
  <li><strong>NASA FIRMS</strong> — yangın/termal tespit verisi</li>
  <li><strong>Open-Meteo</strong> — hava durumu verisi (risk hesaplaması için)</li>
  <li><strong>Firebase (Google)</strong> — push bildirimleri</li>
  <li><strong>Render</strong> — arka uç sunucu barındırma</li>
  <li><strong>Neon</strong> — veritabanı barındırma</li>
  <li><strong>Upstash</strong> — önbellek (Redis) barındırma</li>
</ul>
<p>Bu servislere yalnızca işlevlerini yerine getirmeleri için gereken veriler iletilir (ör. bildirim göndermek için cihaz belirteci). Veriniz reklam amacıyla satılmaz veya paylaşılmaz.</p>

<h2>Yapmadıklarımız</h2>
<ul>
  <li>Kişisel verilerinizi üçüncü taraflara satmıyoruz.</li>
  <li>Verilerinizi reklam amacıyla kullanmıyoruz.</li>
  <li>Hesap oluşturmanızı istemiyoruz; isim, iletişim veya kimlik belgesi toplamıyoruz.</li>
  <li>Uygulama içi analitik veya davranış izleme kullanmıyoruz.</li>
</ul>

<h2>Haklarınız</h2>
<p>Gönderdiğiniz yangın raporu, geri bildirim veya e-posta adresinin silinmesini istediğinizde, aşağıdaki iletişim adresinden bize ulaşabilirsiniz. Talebinizi makul bir sürede yerine getiririz.</p>

<h2>İletişim</h2>
<p>Bu politika veya verileriniz hakkında sorularınızı <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> adresine gönderebilirsiniz.</p>
`;
const privacyEn = `
<h1>FireWatch TR — Privacy Policy</h1>
<p class="updated">Last updated: 2026</p>
<p class="lang-switch"><a href="/privacy/en">English version</a> · <a href="/privacy/tr">Türkçe</a></p>

<p>FireWatch TR ("the app") shows wildfire and thermal-anomaly information across Turkey using NASA satellite data. This page explains what data we collect, why, and your rights over it.</p>

<h2>Data we collect</h2>
<table>
<tr><th>Data type</th><th>Why we collect it</th></tr>
<tr><td>Location (GPS coordinates)</td><td>To show fire detections near you and, optionally, run background alerts. Only collected with your permission.</td></tr>
<tr><td>Device token (FCM)</td><td>To deliver push notifications (fire alerts) to your device.</td></tr>
<tr><td>Fire reports</td><td>Fires you voluntarily report: location (lat/lng), optional photo, description.</td></tr>
<tr><td>Feedback / bug reports</td><td>Rating, category, message, and an optional email — used to improve the app.</td></tr>
<tr><td>App usage / analytics</td><td>Not collected. The app contains no analytics or tracking SDK.</td></tr>
</table>

<h2>Location data</h2>
<p>With your permission, the app uses your location only to compute distance to known thermal detections. Location data is never stored server-side — it's used in memory for a single calculation and discarded immediately. Background location access is entirely optional and requires a separate, explicit opt-in inside the app.</p>

<h2>NASA fire/thermal data</h2>
<p>Fire and thermal-anomaly data comes from NASA's FIRMS (Fire Information for Resource Management System). This is public satellite data and is never linked to your identity.</p>

<h2>Data retention</h2>
<p>Location data is never stored. Fire reports and feedback are retained indefinitely to operate and improve the service; you can request deletion at any time via the contact email below. Your FCM device token becomes inactive once you disable notifications or uninstall the app.</p>

<h2>Third-party services</h2>
<p>The app relies on the following third-party services:</p>
<ul>
  <li><strong>NASA FIRMS</strong> — fire/thermal detection data</li>
  <li><strong>Open-Meteo</strong> — weather data (for risk scoring)</li>
  <li><strong>Firebase (Google)</strong> — push notifications</li>
  <li><strong>Render</strong> — backend server hosting</li>
  <li><strong>Neon</strong> — database hosting</li>
  <li><strong>Upstash</strong> — cache (Redis) hosting</li>
</ul>
<p>Only the data each service needs to do its job is shared with it (e.g. a device token to deliver a notification). Your data is never sold or shared for advertising.</p>

<h2>What we don't do</h2>
<ul>
  <li>We do not sell personal data to third parties.</li>
  <li>We do not use your data for advertising.</li>
  <li>We do not require an account or collect names, contacts, or identity documents.</li>
  <li>We do not use in-app analytics or behavioral tracking.</li>
</ul>

<h2>Your rights</h2>
<p>You can request deletion of any fire report, feedback submission, or email address you've provided by contacting us below. We'll act on your request within a reasonable time.</p>

<h2>Contact</h2>
<p>Questions about this policy or your data can be sent to <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.</p>
`;
router.get('/privacy', (req, res) => {
    res.type('html').send(page('FireWatch TR — Privacy Policy / Gizlilik Politikası', `${privacyTr}<hr/>${privacyEn}`));
});
router.get('/privacy/tr', (req, res) => {
    res.type('html').send(page('FireWatch TR — Gizlilik Politikası', privacyTr));
});
router.get('/privacy/en', (req, res) => {
    res.type('html').send(page('FireWatch TR — Privacy Policy', privacyEn));
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
    res.type('html').send(page('FireWatch TR — Terms of Service / Kullanım Koşulları', `${termsTr}<hr/>${termsEn}`));
});
router.get('/terms/tr', (req, res) => {
    res.type('html').send(page('FireWatch TR — Kullanım Koşulları', termsTr));
});
router.get('/terms/en', (req, res) => {
    res.type('html').send(page('FireWatch TR — Terms of Service', termsEn));
});
exports.default = router;
