// MDKKUQUIZ Service Worker
// ทำหน้าที่แค่ลงทะเบียนให้เว็บ "ติดตั้งได้" (installable)
// และ cache เฉพาะไฟล์ static ของตัวเอง
// ไม่แตะ requests ไปหา Google Apps Script (script.google.com) เด็ดขาด

const CACHE_NAME = 'mdkkuquiz-v3.26.0'; // semver — bump ทุกครั้งที่ deploy JS ใหม่; ถ้ามีของใหม่ให้เพิ่ม entry ใน js/changelog.js ด้วย
const STATIC_ASSETS = [
    './',
    'index.html',
    'css/variables.css',
    'css/base.css',
    'css/selection.css',
    'css/quiz-core.css',
    'css/modals.css',
    'css/results.css',
    'css/responsive.css',
    'css/info-banner.css',
    'css/themes.css',
    'css/edit-modal.css',
    'css/fast-mode.css',
    'css/features.css',
    'css/scratchpad.css',
    'js/config.js',
    'js/med-keyword-skill.js',
    'js/changelog.js',
    'js/version.js',
    'js/db.js',
    'js/api.js',
    'js/interaction-log.js',
    'js/search.js',
    'js/quiz-core.js',
    'js/quiz-render.js',
    'js/chatbot.js',
    'js/glossary.js',
    'js/meq.js',
    'js/scratchpad.js',
    'js/similar.js',
    'js/study-sets.js',
    'js/vote.js',
    'js/discussion.js',
    'js/pending-reports.js',
    'js/report.js',
    'js/app-feedback.js',
    'js/reviews-donations.js',
    'js/ui.js',
    'js/auth-edit.js',
    'js/sync.js',
    'js/edit-modal.js',
    'js/app.js',
    'js/pdf-generator.js',
    'js/grader.js',
    'js/th-sarabun-font.js'
];

// ติดตั้ง: cache ไฟล์ static
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
    );
    self.skipWaiting();
});

// Activate: ล้าง cache เก่า
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Message: หน้าเว็บถาม version ปัจจุบันผ่าน MessageChannel — CACHE_NAME คือ source of truth เดียว
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'GET_VERSION' && event.ports[0]) {
        event.ports[0].postMessage({ version: CACHE_NAME });
    }
});

// Fetch: Cache-first เฉพาะไฟล์ static ของ origin ตัวเองเท่านั้น
self.addEventListener('fetch', (event) => {
    // ปล่อยทุก request ข้าม origin ผ่านตรง (GAS, Google APIs, CDN, รูปภายนอก ฯลฯ)
    // — ห้าม fetch() แทน browser: request แบบ no-cors เช่น <img> ข้ามเว็บจะกลายเป็น CORS error ใน SW
    if (new URL(event.request.url).origin !== self.location.origin) {
        return; // browser จัดการเอง
    }

    // สำหรับไฟล์ static ของแอป: cache-first พร้อม ignoreSearch เพื่อให้รองรับ query parameters เช่น ?subject=...
    event.respondWith(
        caches.match(event.request, { ignoreSearch: true }).then((cached) => {
            return cached || fetch(event.request);
        })
    );
});