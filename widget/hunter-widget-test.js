// Hunter: проверка загрузки виджета с сервера. Вставить отдельным правилом в «User JavaScript and CSS»
// (URL паттерн https://*.pocketoption.com/*), открыть платформу и посмотреть табличку в левом нижнем углу.
(function () {
  var U = 'https://hunterai.space/widget/ping.js';
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;left:12px;bottom:12px;padding:10px 14px;border-radius:10px;background:#1c1233;color:#fff;font:600 13px/1.6 sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5)';
  box.innerHTML = '<b>Hunter: проверка загрузки</b>';
  var line = function (t, ok) { var d = document.createElement('div'); d.textContent = (ok ? '✅ ' : '❌ ') + t; box.appendChild(d); };
  (document.body || document.documentElement).appendChild(box);
  // 1) Загрузка кода через fetch и запуск через new Function
  fetch(U, { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (code) {
    line('1. fetch: загружено', true);
    try { new Function(code)(); line('2. new Function: работает', true); } catch (e) { line('2. new Function: запрещено (' + e.message + ')', false); }
  }).catch(function (e) { line('1. fetch: заблокировано (' + e.message + ')', false); });
  // 3) Подключение тегом <script>
  var s = document.createElement('script');
  s.src = U + '?tag=1';
  s.onload = function () { line('3. тег <script>: работает', true); };
  s.onerror = function () { line('3. тег <script>: заблокировано', false); };
  (document.head || document.documentElement).appendChild(s);
})();
