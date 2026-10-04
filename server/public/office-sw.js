// Сервис-воркер Hunter Office: нужен для установки приложения. Данные и API не кэшируем,
// чтобы никогда не показывать устаревшие цифры; без сети показываем короткую страницу.
const OFFLINE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Нет сети</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0614;color:#f1ebff;font:16px system-ui;text-align:center;padding:24px"><div><div style="font-size:42px">📡</div><p>Нет соединения с сервером.<br>Проверьте интернет и повторите.</p><button onclick="location.reload()" style="padding:12px 24px;border:0;border-radius:12px;background:#9b5cff;color:#fff;font:700 15px system-ui">Обновить</button></div>';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } })));
});
