// ==UserScript==
// @name         Pocket Option Trade Tracker (HUNTER TEAM)
// @namespace    trade-tracker
// @version      7.20
// @description  Виджет HUNTER TEAM: счётчик WIN / LOSE, пара и часы платформы. Клик по HUNTER - размытие и лупа, по «Итог» - история сделок.
// @match        https://pocketoption.com/*
// @match        https://po.trade/*
// @match        https://*.pocketoption.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==

(function boot() {
  'use strict';
  // Расширения вроде "User JavaScript and CSS" могут запускать скрипт до загрузки страницы.
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
    return;
  }
  // Защита от двойного запуска (если скрипт подключён дважды).
  if (document.getElementById('pott-widget')) return;
  // Клиентам сервер отдаёт виджет без «Догона», размытия и лупы (они только у сотрудников и тестовых аккаунтов).
  const CLIENT = typeof HUNTER_CLIENT !== 'undefined' && HUNTER_CLIENT === true;


  /* ================= АВТООПРЕДЕЛЕНИЕ ПАРЫ ================= */
  const PAIR_SELECTORS = [
    '.current-symbol',
    '.asset-select__selected',
    '.currentSymbol',
    '.chart-header__name',
    '.asset-name',
    '[class*="symbol"]',
    '[class*="asset"] [class*="name"]',
  ];
  const PAIR_REGEX = /\b([A-Z]{3}\/[A-Z]{3})(\s*OTC)?\b/;

  /* ================= АВТООПРЕДЕЛЕНИЕ ВРЕМЕНИ ================= */
  const TIME_SELECTORS = [
    '.server-time',
    '.current-time',
    '.header-time',
    '.clock-time',
    '[class*="server-time"]',
    '[class*="serverTime"]',
    '[class*="clock"]',
    '[class*="time"]',
  ];
  const TIME_REGEX = /\b([0-2]?\d:[0-5]\d:[0-5]\d)\b/;

  const POLL_MS = 1000;
  const STORAGE_KEY = 'po_trade_tracker_state_v2_compact'; // тот же ключ - счёт сохраняется со старой версии

  /* ================= ХРАНИЛИЩЕ ================= */
  // Работает в любом расширении: localStorage есть всегда, GM_* - только в Tampermonkey/Violentmonkey.
  // При загрузке берётся самая свежая из двух копий.
  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  function readRaw(key) {
    let gm = null, ls = null;
    if (hasGM) { try { gm = GM_getValue(key, null); } catch (e) {} }
    try { ls = window.localStorage.getItem(key); } catch (e) {}
    let a = null, b = null;
    try { a = gm ? JSON.parse(gm) : null; } catch (e) {}
    try { b = ls ? JSON.parse(ls) : null; } catch (e) {}
    if (a && b) return (a._t || 0) >= (b._t || 0) ? a : b;
    return a || b;
  }
  function loadState() {
    return readRaw(STORAGE_KEY) || { pair: 'EUR/USD OTC', win: 0, loss: 0, autoPair: true, scale: 1 };
  }
  function saveState(state) {
    state._t = Date.now();
    const json = JSON.stringify(state);
    try { window.localStorage.setItem(STORAGE_KEY, json); } catch (e) {}
    if (hasGM) { try { GM_setValue(STORAGE_KEY, json); } catch (e) {} }
  }
  // Сохранить на всякий случай и при закрытии/перезагрузке вкладки.
  window.addEventListener('beforeunload', () => saveState(state));
  let state = loadState();
  if (typeof state.scale !== 'number' || !isFinite(state.scale)) state.scale = 1;

  function detectPair() {
    for (const sel of PAIR_SELECTORS) {
      const el = Array.prototype.find.call(document.querySelectorAll(sel), (x) => !ownWidget(x));
      if (el && el.textContent && el.textContent.trim().length > 2) {
        const t = el.textContent.trim();
        if (/[A-Za-z]{3}/.test(t)) return t;
      }
    }
    const candidates = document.querySelectorAll('div, span, a, button');
    for (const el of candidates) {
      if (ownWidget(el)) continue;
      const t = el.textContent && el.textContent.trim();
      if (t && t.length < 20 && PAIR_REGEX.test(t)) {
        const m = t.match(PAIR_REGEX);
        if (m) return m[0];
      }
    }
    return null;
  }

  // Часовой пояс рядом с часами платформы: "UTC+3", "GMT -05:00" и т.п.
  const TZ_REGEX = /\b(?:UTC|GMT)\s*([+\-−]\s*\d{1,2}(?::?\d{2})?)?/i;

  function ownWidget(el) {
    return !!(el.closest && el.closest('#pott-widget, #pott-pairs, #pott-settings, #pott-mini, .pott-quick'));
  }
  // Ищем подпись пояса в самом элементе с часами и в нескольких родителях.
  function tzNear(el) {
    let node = el;
    for (let i = 0; node && i < 4; i++, node = node.parentElement) {
      const t = node.textContent || '';
      if (t.length > 80) break;
      const m = t.match(TZ_REGEX);
      if (m) return normalizeTz(m[0]);
    }
    return null;
  }
  function normalizeTz(raw) {
    const m = raw.replace(/\s+/g, '').replace('−', '-').match(/^(UTC|GMT)([+-])?(\d{1,2})?:?(\d{2})?$/i);
    if (!m) return raw.trim().toUpperCase();
    if (!m[2] || !m[3]) return 'UTC';
    const h = parseInt(m[3], 10), min = m[4] ? parseInt(m[4], 10) : 0;
    if (h === 0 && min === 0) return 'UTC';
    return 'UTC' + m[2] + h + (min ? ':' + String(min).padStart(2, '0') : '');
  }
  // Если сайт пояс не подписывает - вычисляем его: время платформы минус текущее время UTC.
  function tzFromOffset(timeStr) {
    const p = timeStr.split(':').map(Number);
    const platform = p[0] * 3600 + p[1] * 60 + p[2];
    const now = new Date();
    const utc = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
    let diff = platform - utc;
    if (diff > 14 * 3600) diff -= 86400;
    if (diff < -12 * 3600) diff += 86400;
    const q = Math.round(diff / 900) * 900; // пояса кратны 15 минутам
    if (q === 0) return 'UTC';
    const sign = q > 0 ? '+' : '-';
    const a = Math.abs(q), h = Math.floor(a / 3600), min = Math.round((a % 3600) / 60);
    return 'UTC' + sign + h + (min ? ':' + String(min).padStart(2, '0') : '');
  }

  function detectTime() {
    for (const sel of TIME_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (ownWidget(el) || !el.textContent) continue;
        const m = el.textContent.match(TIME_REGEX);
        if (m) return { time: m[1], tz: tzNear(el) || tzFromOffset(m[1]) };
      }
    }
    const candidates = document.querySelectorAll('div, span, a, button');
    for (const el of candidates) {
      if (ownWidget(el)) continue;
      const t = el.textContent && el.textContent.trim();
      if (t && t.length < 20 && TIME_REGEX.test(t)) {
        const m = t.match(TIME_REGEX);
        if (m) return { time: m[1], tz: tzNear(el) || tzFromOffset(m[1]) };
      }
    }
    return null;
  }


  /* ================= ШРИФТ MONTSERRAT ================= */
  if (!document.getElementById('pott-font-montserrat')) {
    const fontLink = document.createElement('link');
    fontLink.id = 'pott-font-montserrat';
    fontLink.rel = 'stylesheet';
    fontLink.href = 'https://fonts.googleapis.com/css2?family=Montserrat:wght@500;600;700;800&display=swap';
    document.documentElement.appendChild(fontLink);
  }

  /* ================= СТИЛИ ================= */
  const style = document.createElement('style');
  style.textContent = `
    #pott-widget {
      position: fixed;
      top: 45%;
      right: 4%;
      width: 232px;
      transform-origin: top left;
      z-index: 2147483647;
      box-sizing: border-box;
      padding: 12px 10px 10px;
      border-radius: 14px;
      /* --- Цвета темы (переопределяются через data-theme) --- */
      --pt-bg: #0e0e10;
      --pt-card: #151517;
      --pt-line: rgba(255,255,255,0.07);
      --pt-edge: rgba(255,255,255,0.08);
      --pt-title: #f2f2f2;
      --pt-divider: rgba(255,255,255,0.35);
      --pt-glow: 0 0 0 transparent;
      --pt-alpha: 1;
      --pt-bg-a: color-mix(in srgb, var(--pt-bg) calc(var(--pt-alpha) * 100%), transparent);
      --pt-card-a: color-mix(in srgb, var(--pt-card) calc(var(--pt-alpha) * 100%), transparent);
      background: var(--pt-bg-a);
      border: 1px solid var(--pt-edge);
      box-shadow: 0 14px 36px rgba(0,0,0,0.65), var(--pt-glow), inset 0 1px 0 rgba(255,255,255,0.04);
      transition: background 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease;
      color: #fff;
      font-family: 'Montserrat', 'Segoe UI', system-ui, -apple-system, sans-serif;
      user-select: none;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #pott-widget * { box-sizing: border-box; font-family: inherit; }

    /* --- Шапка --- */
    #pott-head {
      position: relative;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    /* --- Зона перетаскивания: только левый верхний угол, невидимая --- */
    #pott-drag {
      position: absolute;
      top: 0;
      left: 0;
      width: 60px;
      height: 40px;
      cursor: move;
      background: transparent;
      z-index: 5;
      border-top-left-radius: 14px;
    }
    #pott-title {
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 2.4px;
      color: var(--pt-title);
      pointer-events: none;
    }
    #pott-divider {
      height: 1px;
      margin: 0 6px 2px;
      background: linear-gradient(90deg,
        rgba(255,255,255,0) 0%,
        var(--pt-divider) 50%,
        rgba(255,255,255,0) 100%);
    }
    #pott-exit {
      position: absolute;
      top: -12px;
      right: -10px;
      width: 24px;
      height: 20px;
      padding: 0;
      border: none;
      outline: none;
      border-radius: 0;
      background: transparent;
      box-shadow: none;
      color: rgba(255,255,255,0.3);
      font-size: 9px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s ease, background 0.15s ease;
    }
    #pott-exit:hover { color: #ff5a7a; background: transparent; }
    #pott-exit:focus { outline: none; }

    #pott-widget[hidden] { display: none !important; }

    /* --- Свёрнутый виджет: плашка с итогом слева от баланса сайта --- */
    #pott-mini {
      position: fixed;
      z-index: 2147483646;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      gap: 0;
      padding: 0 3px;
      margin: 0;
      overflow: visible;
      cursor: pointer;
      text-align: center;
      font-family: 'Montserrat', 'Segoe UI', system-ui, -apple-system, sans-serif;
      background: #1c1f2d;
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px;
    }
    #pott-mini[hidden] { display: none !important; }
    .pott-quick {
      --pott-q-border: rgba(255,255,255,0.12);
      position: fixed;
      z-index: 2147483646;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      margin: 0;
      cursor: pointer;
      line-height: 0;
      background: #1c1f2d;
      border: 1px solid var(--pott-q-border);
      border-radius: 6px;
      color: rgba(255,255,255,0.8);
      transition: color 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
    }
    .pott-quick:hover { color: #fff; }
    .pott-quick svg { width: 17px; height: 17px; display: block; }
    .pott-quick-split { padding: 0; overflow: hidden; cursor: default; }
    /* Плашка «Не является финансовой рекомендацией» слева от размытия: только надпись, клики проходят сквозь неё */
    .pott-quick.pott-disc { cursor: default; pointer-events: none; gap: 8px; padding: 0 12px; white-space: nowrap; color: #fff; line-height: 1.12; font-weight: 800; font-family: 'Montserrat', 'Segoe UI', system-ui, -apple-system, sans-serif; text-align: left; justify-content: flex-start; }
    .pott-disc .pott-disc-i { font-size: 1.45em; line-height: 1; flex: none; }
    .pott-disc .pott-disc-t { display: block; }

    /* --- Список пар (клик по названию пары) --- */
    #pott-pairs {
      position: fixed;
      z-index: 2147483647;
      box-sizing: border-box;
      width: 232px;
      max-height: 320px;
      padding: 8px;
      border-radius: 10px;
      background: #1b1e2c;
      border: 1px solid rgba(255,255,255,0.12);
      box-shadow: 0 14px 36px rgba(0,0,0,0.55);
      color: #fff;
      font-family: 'Montserrat', 'Segoe UI', system-ui, -apple-system, sans-serif;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    #pott-pairs[hidden] { display: none !important; }
    #pott-pairs * { box-sizing: border-box; font-family: inherit; }
    #pott-pairs-list {
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 1px;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.18) transparent;
    }
    .pott-pairs-sec {
      padding: 6px 6px 3px;
      font-size: 8.5px;
      font-weight: 700;
      letter-spacing: 1.3px;
      color: rgba(255,255,255,0.4);
    }
    .pott-pairs-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      padding: 7px 8px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: rgba(255,255,255,0.88);
      font-size: 12px;
      font-weight: 700;
      text-align: left;
      cursor: pointer;
    }
    .pott-pairs-item:hover { background: rgba(255,255,255,0.06); color: #fff; }
    .pott-pairs-item.pott-on { color: #b98cff; }
    .pott-pairs-flags { position: relative; flex: 0 0 auto; width: 25px; height: 21px; margin-right: 8px; }
    .pott-flag {
      position: absolute; width: 16px; height: 16px; border-radius: 50%; overflow: hidden;
      box-shadow: 0 0 0 1.5px #1b1e2c; background: #3a3e52;
      display: flex; align-items: center; justify-content: center;
      font-size: 5.5px; font-weight: 800; color: rgba(255,255,255,0.8); letter-spacing: 0;
    }
    .pott-flag svg { width: 100%; height: 100%; display: block; }
    .pott-flag:first-child { left: 0; top: 0; z-index: 1; }
    .pott-flag:last-child { right: 0; bottom: 0; z-index: 2; }
    .pott-pairs-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pott-pairs-pay { flex: 0 0 auto; margin-left: 6px; font-size: 11px; font-weight: 800; font-variant-numeric: tabular-nums; }
    .pott-pairs-pay.pott-hi { color: #3ddc84; }
    .pott-pairs-pay.pott-mid { color: #f5c542; }
    .pott-pairs-pay.pott-lo { color: rgba(255,255,255,0.4); }
    .pott-pairs-empty { padding: 14px 6px; text-align: center; font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.45); }
    #pott-pairs-status {
      padding: 2px 6px 0;
      font-size: 10px;
      font-weight: 600;
      line-height: 1.35;
      color: rgba(255,255,255,0.55);
    }
    #pott-pairs-status:empty { display: none; }
    #pott-pairs-status.pott-err { color: #ff4d6d; }

    /* --- Окошко настроек под шестерёнкой --- */
    #pott-settings {
      position: fixed;
      z-index: 2147483647;
      box-sizing: border-box;
      width: 232px;
      padding: 12px 12px 14px;
      border-radius: 10px;
      background: #1b1e2c;
      border: 1px solid rgba(255,255,255,0.12);
      box-shadow: 0 14px 36px rgba(0,0,0,0.55);
      color: #fff;
      font-family: 'Montserrat', 'Segoe UI', system-ui, -apple-system, sans-serif;
      user-select: none;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    #pott-settings[hidden] { display: none !important; }
    #pott-settings * { box-sizing: border-box; font-family: inherit; }
    .pott-set-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 1.4px;
      color: rgba(255,255,255,0.5);
    }
    .pott-set-head span:last-child {
      letter-spacing: 0;
      font-size: 11px;
      font-weight: 700;
      color: #fff;
    }
    #pott-set-colors {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 8px;
      justify-items: center;
    }
    .pott-sw {
      width: 24px;
      height: 24px;
      padding: 0;
      border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.18);
      cursor: pointer;
      transition: transform 0.12s ease, box-shadow 0.12s ease;
    }
    .pott-sw:hover { transform: scale(1.12); }
    .pott-sw.pott-on { box-shadow: 0 0 0 2px #1b1e2c, 0 0 0 3.5px #fff; }
    .pott-set-sep { height: 1px; background: rgba(255,255,255,0.08); }
    #pott-set-alpha {
      width: 100%;
      margin: 2px 0 0;
      accent-color: #a970ff;
      cursor: pointer;
    }
    .pott-switch { position: relative; display: inline-block; width: 30px; height: 17px; cursor: pointer; }
    .pott-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
    .pott-switch i {
      position: absolute; inset: 0; border-radius: 17px;
      background: rgba(255,255,255,0.15); transition: background 0.15s ease;
    }
    .pott-switch i::after {
      content: ''; position: absolute; top: 2px; left: 2px; width: 13px; height: 13px;
      border-radius: 50%; background: #fff; transition: transform 0.15s ease;
    }
    .pott-switch input:checked + i { background: #3ddc84; }
    .pott-switch input:checked + i::after { transform: translateX(13px); }
    #pott-mg-body { display: flex; flex-direction: column; gap: 7px; transition: opacity 0.15s ease; }
    #pott-mg-body.pott-off { opacity: 0.45; }
    .pott-mg-row {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.75);
    }
    .pott-mg-row input {
      width: 70px; height: 26px; padding: 0 8px; border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.04);
      color: #fff; font-size: 12px; font-weight: 700; text-align: right; outline: none;
    }
    .pott-mg-row input:focus { border-color: rgba(169,112,255,0.7); }
    .pott-mg-check { display: flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.75); cursor: pointer; }
    .pott-mg-check input { accent-color: #3ddc84; margin: 0; }
    #pott-mg-status { font-size: 11px; font-weight: 700; color: #fff; }
    #pott-mg-status.pott-err { color: #ff4d6d; }
    .pott-set-scale {
      display: flex;
      justify-content: space-between;
      font-size: 9px;
      font-weight: 600;
      color: rgba(255,255,255,0.35);
    }
    .pott-q-part {
      height: 100%;
      margin: 0;
      padding: 0;
      border: none;
      background: transparent;
      color: inherit;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
      transition: color 0.15s ease, background-color 0.15s ease;
    }
    #pott-q-blur { flex: 0 0 auto; aspect-ratio: 1 / 1; }
    #pott-q-blur:hover { color: #fff; }
    #pott-q-blur.pott-on { color: #3ddc84; }
    .pott-q-sep { flex: 0 0 1px; align-self: center; height: 56%; background: var(--pott-q-border); }
    #pott-q-count {
      flex: 1 1 auto;
      min-width: 0;
      font-family: 'Montserrat', 'Segoe UI', system-ui, -apple-system, sans-serif;
      font-size: 13px;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
      color: #fff;
    }
    #pott-q-count:hover { color: #ff4d6d; }
    #pott-q-count.pott-zero { color: rgba(255,255,255,0.4); cursor: default; }
    .pott-quick.pott-on { color: #3ddc84; }
    /* Подпись лежит на верхней линии рамки и разрывает её - как «QT Real USD» у баланса.
       Цвет, шрифт и положение копируются с подписи баланса в placeMini(). */
    #pott-mini-label {
      position: absolute;
      left: 50%;
      top: -7px;
      transform: translateX(-50%);
      padding: 0 4px;
      font-size: 11px;
      font-weight: 400;
      line-height: 1.2;
      color: rgba(255,255,255,0.6);
      background: #1d2031;
      white-space: nowrap;
    }
    #pott-mini-row { display: inline-flex; align-items: center; max-width: 100%; }
    #pott-mini-reset {
      position: absolute;
      right: 7px;
      display: inline-flex;
      width: 15px;
      height: 15px;
      color: rgba(255,255,255,0.4);
      cursor: pointer;
      transition: color 0.15s ease, transform 0.15s ease;
    }
    #pott-mini-reset svg { width: 100%; height: 100%; display: block; }
    #pott-mini-reset:hover { color: #fff; }
    #pott-mini-reset.pott-confirm { color: #ff4d6d; transform: rotate(-30deg); }
    #pott-mini-val {
      font-size: 17px;
      font-weight: 800;
      line-height: 1.2;
      color: #fff;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    #pott-mini-val.pott-c-win { color: #3ddc84; }
    #pott-mini-val.pott-c-loss { color: #ff4d6d; }

    /* --- Блоки WIN / LOSE --- */
    .pott-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
    }
    .pott-card {
      border-radius: 10px;
      padding: 8px 6px 9px;
      background: var(--pt-card-a);
      border: 1px solid var(--pt-line);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    }
    .pott-label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 1.8px;
    }
    .pott-win  .pott-label { color: #3ddc84; }
    .pott-loss .pott-label { color: #ff4d6d; }

    .pott-val {
      font-size: 26px;
      font-weight: 800;
      line-height: 1;
      font-variant-numeric: tabular-nums;
      transition: transform 0.15s ease;
    }
    .pott-win  .pott-val { color: #3ddc84; }
    .pott-loss .pott-val { color: #ff4d6d; }
    .pott-bump { transform: scale(1.22); }

    .pott-mini-btns { display: flex; gap: 6px; margin-top: 2px; }
    .pott-btn {
      width: 22px;
      height: 20px;
      padding: 0;
      border-radius: 5px;
      background: transparent;
      line-height: 0;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.12s ease, transform 0.1s ease;
    }
    .pott-btn svg { width: 10px; height: 10px; display: block; }
    .pott-btn svg line { stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
    .pott-btn:active { transform: scale(0.88); }
    .pott-win .pott-btn  { color: #3ddc84; border: 1px solid rgba(61,220,132,0.55); }
    .pott-loss .pott-btn { color: #ff4d6d; border: 1px solid rgba(255,77,109,0.55); }
    .pott-win .pott-btn:hover  { background: rgba(61,220,132,0.14); }
    .pott-loss .pott-btn:hover { background: rgba(255,77,109,0.14); }

    /* --- Блок пары --- */
    #pott-pair-card {
      border-radius: 10px;
      padding: 10px 10px 10px;
      background: var(--pt-card-a);
      border: 1px solid var(--pt-line);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    }
    /* --- Темы --- */
    #pott-widget[data-alpha] .pott-day-head { -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }

    /* --- Выбор темы (раскрывается по клику на пару) --- */
    .pott-set { gap: 7px; padding: 9px 8px 10px; }
    .pott-set .pott-label { color: rgba(255,255,255,0.6); }
    #pott-themes {
      display: flex;
      justify-content: center;
      gap: 9px;
      padding: 2px 0;
    }
    #pott-alpha { display: flex; justify-content: center; gap: 6px; }
    .pott-seg {
      min-width: 48px;
      height: 24px;
      padding: 0 8px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.2);
      background: transparent;
      color: rgba(255,255,255,0.75);
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
    }
    .pott-seg:hover { background: rgba(255,255,255,0.06); }
    .pott-seg.pott-on {
      color: #d9c2ff;
      border-color: rgba(169,112,255,0.75);
      background: rgba(169,112,255,0.16);
      box-shadow: 0 0 10px rgba(169,112,255,0.3);
    }
    .pott-swatch {
      width: 18px;
      height: 18px;
      padding: 0;
      border-radius: 50%;
      border: 1px solid rgba(255,255,255,0.18);
      cursor: pointer;
      transition: transform 0.12s ease, box-shadow 0.12s ease;
    }
    .pott-swatch:hover { transform: scale(1.12); }
    .pott-swatch.pott-on { box-shadow: 0 0 0 2px var(--pt-card), 0 0 0 3.5px #fff; }

    #pott-pair {
      width: 100%;
      padding: 0;
      border: none;
      outline: none;
      background: none;
      color: #fff;
      cursor: pointer;
      border-radius: 6px;
      transition: background 0.15s ease, color 0.15s ease, text-shadow 0.15s ease;
      text-align: center;
      font-family: inherit;
      font-size: 16px;
      font-weight: 800;
      letter-spacing: 0.3px;
    }
    #pott-pair { cursor: default; caret-color: transparent; }
    #pott-clock-tz { color: rgba(255,255,255,0.45); margin-left: -2px; }
    #pott-clock-tz:empty { display: none; }
    /* --- Таймзона - кнопка показать/скрыть баланс --- */
    #pott-clock-tz { cursor: pointer; transition: color 0.15s ease; }
    #pott-clock-tz:hover { color: rgba(255,255,255,0.85); }

    /* --- Баланс сессии --- */
    #pott-balance-card {
      border-radius: 10px;
      padding: 8px 10px 10px;
      background: var(--pt-card-a);
      border: 1px solid var(--pt-line);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    #pott-balance-card[hidden] { display: none; }
    #pott-bal-head {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 20px;
    }
    #pott-bal-total { cursor: pointer; border-radius: 0 0 6px 6px; transition: color 0.15s ease; }
    #pott-bal-total:hover { color: #fff; }

    /* --- Обратная сторона: история по дням --- */
    #pott-view-history { flex: 1 1 auto; min-height: 0; }
    #pott-head, #pott-divider { flex-shrink: 0; }
    #pott-view-history:not([hidden]) {
      display: flex; flex-direction: column; gap: 6px;
      border-radius: 10px; padding: 8px 8px 8px;
      background: var(--pt-card-a); border: 1px solid var(--pt-line);
    }
    #pott-days-head { position: relative; display: flex; align-items: center; justify-content: center; min-height: 20px; }
    #pott-days-head .pott-label { color: rgba(255,255,255,0.55); }
    #pott-days-reset { position: absolute; right: -4px; top: 50%; transform: translateY(-50%); }
    #pott-days-reset:hover { color: #ff4d6d; }
    #pott-days-total { cursor: pointer; transition: background-color 0.15s ease; border-radius: 0 0 6px 6px; }
    #pott-days-total:hover { background-color: rgba(255,255,255,0.04); }
    #pott-view-history { position: relative; }
    #pott-days-confirm {
      position: absolute; inset: 0; z-index: 3;
      display: flex; flex-direction: column; align-items: stretch; justify-content: center; gap: 7px;
      padding: 14px 16px; border-radius: 10px;
      background: color-mix(in srgb, var(--pt-card) 96%, transparent);
    }
    #pott-days-confirm[hidden] { display: none; }
    .pott-days-q { text-align: center; font-size: 12px; font-weight: 800; color: #fff; margin-bottom: 4px; }
    .pott-days-btn {
      height: 30px; border-radius: 7px; cursor: pointer;
      border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.9); font-size: 11px; font-weight: 700;
      transition: background-color 0.12s ease, border-color 0.12s ease;
    }
    .pott-days-btn:hover { background: rgba(255,255,255,0.08); }
    .pott-days-btn.pott-danger { color: #ff4d6d; border-color: rgba(255,77,109,0.5); }
    .pott-days-btn.pott-danger:hover { background: rgba(255,77,109,0.12); }
    .pott-days-btn.pott-ghost { border-color: transparent; background: transparent; color: rgba(255,255,255,0.5); }
    .pott-days-row {
      display: grid;
      grid-template-columns: 1.35fr 0.55fr 0.55fr 1.25fr;
      align-items: center;
      gap: 4px;
      padding: 5px 4px;
      font-size: 11px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .pott-days-row span:nth-child(n+2) { text-align: right; }
    .pott-days-cols { padding-top: 0; padding-bottom: 4px; font-size: 8px; letter-spacing: 1.2px; color: rgba(255,255,255,0.4); border-bottom: 1px solid var(--pt-line); }
    #pott-days-list {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.18) transparent;
    }
    #pott-days-list::-webkit-scrollbar { width: 4px; }
    #pott-days-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 4px; }
    #pott-days-list .pott-days-row { border-bottom: 1px solid rgba(255,255,255,0.04); }
    #pott-days-list .pott-days-row span:first-child { color: rgba(255,255,255,0.8); }
    .pott-days-empty { padding: 16px 6px; text-align: center; font-size: 10px; font-weight: 600; line-height: 1.4; color: rgba(255,255,255,0.4); }
    #pott-days-total { border-top: 1px solid var(--pt-line); padding-top: 7px; font-size: 12px; font-weight: 800; }
    #pott-days-total span:first-child { color: rgba(255,255,255,0.75); }
    #pott-bal-head .pott-label { color: rgba(255,255,255,0.55); }
    #pott-bal-actions { display: flex; gap: 4px; }
    .pott-icon-btn {
      width: 22px;
      height: 20px;
      padding: 0;
      border: none;
      border-radius: 5px;
      background: transparent;
      color: rgba(255,255,255,0.4);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 0;
      transition: color 0.15s ease, background 0.15s ease;
    }
    .pott-icon-btn:hover { color: rgba(255,255,255,0.9); background: rgba(255,255,255,0.06); }
    .pott-icon-btn svg { width: 13px; height: 13px; display: block; }
    #pott-bal-grid {
      display: grid;
      grid-template-columns: 1fr 1px 1fr;
      align-items: center;
      text-align: center;
    }
    #pott-bal-grid .pott-sep { height: 28px; background: var(--pt-line); }
    .pott-bal-lbl {
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 1.3px;
      color: rgba(255,255,255,0.4);
      margin-bottom: 2px;
    }
    .pott-bal-val {
      display: block;
      max-width: 100%;
      overflow: hidden;
      white-space: nowrap;
      font-size: 17px;
      font-weight: 800;
      line-height: 1.1;
      color: #fff;
      font-variant-numeric: tabular-nums;
    }
    #pott-bal-grid > div:not(.pott-sep) { min-width: 0; padding: 0 5px; }
    #pott-bal-total { white-space: nowrap; overflow: hidden; }
    #pott-bal-start { cursor: text; }
    #pott-bal-start-input {
      width: 90%;
      padding: 0;
      border: none;
      outline: none;
      border-radius: 4px;
      background: rgba(255,255,255,0.08);
      color: #fff;
      text-align: center;
      font-size: 15px;
      font-weight: 800;
    }
    #pott-bal-total {
      padding-top: 6px;
      border-top: 1px solid var(--pt-line);
      text-align: center;
      font-size: 13px;
      font-weight: 800;
      color: rgba(255,255,255,0.75);
      font-variant-numeric: tabular-nums;
    }
    #pott-bal-total .pott-c-win,
    #pott-bal-total .pott-c-loss { margin-left: 3px; }
    #pott-clock {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.8px;
      color: rgba(255,255,255,0.75);
      font-variant-numeric: tabular-nums;
    }
    .pott-live-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #3ddc84;
      box-shadow: 0 0 6px rgba(61,220,132,0.8);
      animation: pott-pulse 1.4s ease-in-out infinite;
    }
    @keyframes pott-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }
    @media (prefers-reduced-motion: reduce) {
      .pott-live-dot { animation: none; }
    }

    /* --- Зона изменения размера (правый нижний угол) - невидимая,
           о ней подсказывает только курсор --- */
    #pott-resize {
      position: absolute;
      right: 0;
      bottom: 0;
      width: 16px;
      height: 16px;
      cursor: nwse-resize;
      background: transparent;
      z-index: 5;
    }

    /* --- Заголовок: слово HUNTER - просто текст (размытие и лупа теперь в шапке сайта) --- */
    #pott-hunter { pointer-events: none; }

    /* --- Переключение экранов --- */
    .pott-view { display: flex; flex-direction: column; gap: 8px; }
    .pott-view[hidden] { display: none !important; }

    /* --- Экран размытия --- */
    .pott-tool .pott-label { color: rgba(255,255,255,0.6); }
    .pott-tool-btn {
      width: 46px;
      height: 32px;
      margin: 3px 0 1px;
      padding: 0;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.22);
      background: transparent;
      color: #e9e9e9;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 0;
      transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease, box-shadow 0.12s ease, transform 0.1s ease;
    }
    .pott-tool-btn:hover { background: rgba(255,255,255,0.06); }
    .pott-tool-btn:active { transform: scale(0.92); }
    .pott-tool-btn svg { width: 17px; height: 17px; display: block; }
    .pott-tool-btn.pott-on {
      color: #3ddc84;
      border-color: rgba(61,220,132,0.7);
      background: rgba(61,220,132,0.12);
      box-shadow: 0 0 12px rgba(61,220,132,0.3);
    }
    .pott-hint {
      font-size: 9px;
      font-weight: 600;
      color: rgba(255,255,255,0.38);
      text-align: center;
      line-height: 1.25;
    }
    #pott-blur-summary {
      border-radius: 10px;
      padding: 10px 12px;
      background: var(--pt-card-a);
      border: 1px solid var(--pt-line);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 14px;
    }
    /* ноль, подпись и кнопка - на одной горизонтальной линии, всё по центру */
    #pott-blur-count-wrap { display: flex; align-items: center; gap: 7px; }
    #pott-blur-count-wrap .pott-hint { text-align: left; }
    #pott-blur-count {
      font-size: 24px;
      font-weight: 800;
      line-height: 1;
      color: #fff;
      font-variant-numeric: tabular-nums;
    }
    #pott-blur-clear {
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid rgba(255,77,109,0.55);
      background: transparent;
      color: #ff4d6d;
      font-size: 10px;
      font-weight: 700;
      white-space: nowrap;
      flex-shrink: 0;
      cursor: pointer;
      transition: background 0.12s ease, transform 0.1s ease;
    }
    #pott-blur-clear:hover { background: rgba(255,77,109,0.14); }
    #pott-blur-clear:active { transform: scale(0.94); }

    /* --- Эффекты на странице (перенесено из Blur & Magnify Widget) --- */
    .pott-blur-target {
      filter: blur(7px) !important;
      transition: filter 0.15s ease;
    }
    .pott-blur-hover-candidate {
      outline: 2px dashed #3ddc84 !important;
      outline-offset: 2px !important;
    }
    .pott-magnify-target {
      transform: scale(3) !important;
      position: relative !important;
      z-index: 2147483000 !important;
      transition: transform 0.15s ease;
      pointer-events: none !important;
    }
    .pott-magnify-target * { pointer-events: none !important; }
    body.pott-blur-select-mode, body.pott-blur-select-mode * { cursor: crosshair !important; }
    body.pott-blur-draw-mode, body.pott-blur-draw-mode * {
      cursor: crosshair !important;
      user-select: none !important;
    }
    #pottb-draw-preview {
      position: fixed;
      z-index: 2147483647;
      border: 1.5px dashed #3ddc84;
      background: rgba(61,220,132,0.1);
      pointer-events: none;
      display: none;
    }

    /* --- Слово TEAM - просто текст --- */
    #pott-team { pointer-events: none; }

    /* --- Экран истории --- */
    #pott-today {
      border-radius: 10px;
      padding: 8px 6px 9px;
      background: var(--pt-card-a);
      border: 1px solid var(--pt-line);
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      text-align: center;
      gap: 2px;
    }
    #pott-today-title {
      grid-column: 1 / -1;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 1.6px;
      color: rgba(255,255,255,0.45);
      margin-bottom: 3px;
    }
    .pott-stat-val {
      font-size: 20px;
      font-weight: 800;
      line-height: 1.05;
      font-variant-numeric: tabular-nums;
    }
    .pott-stat-lbl {
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 1.2px;
      color: rgba(255,255,255,0.4);
    }
    .pott-c-win { color: #3ddc84; }
    .pott-c-loss { color: #ff4d6d; }
    .pott-c-rate { color: #fff; }

    #pott-history-list {
      max-height: 190px;
      overflow-y: auto;
      border-radius: 10px;
      background: var(--pt-card-a);
      border: 1px solid var(--pt-line);
      padding: 2px 8px 6px;
      scrollbar-width: thin;
      scrollbar-color: rgba(255,255,255,0.18) transparent;
    }
    #pott-history-list::-webkit-scrollbar { width: 4px; }
    #pott-history-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.18); border-radius: 4px; }
    .pott-day-head {
      position: sticky;
      top: 0;
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      padding: 7px 0 4px;
      background: var(--pt-card-a);
      border-bottom: 1px solid var(--pt-line);
      font-size: 10px;
      font-weight: 700;
    }
    .pott-day-name { color: rgba(255,255,255,0.8); }
    .pott-day-sum { display: flex; gap: 7px; font-variant-numeric: tabular-nums; }
    .pott-day-sum .pott-c-rate { color: rgba(255,255,255,0.5); }
    .pott-entry {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 8px;
      padding: 4px 0;
      font-size: 10px;
      font-weight: 600;
      border-bottom: 1px solid rgba(255,255,255,0.035);
    }
    .pott-entry:last-child { border-bottom: none; }
    .pott-entry-time { color: rgba(255,255,255,0.4); font-variant-numeric: tabular-nums; }
    .pott-entry-pair { color: rgba(255,255,255,0.85); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pott-entry-res { font-weight: 800; letter-spacing: 1px; font-size: 9px; }
    .pott-history-empty {
      padding: 18px 6px;
      text-align: center;
      font-size: 10px;
      font-weight: 600;
      line-height: 1.4;
      color: rgba(255,255,255,0.4);
    }
    #pott-history-clear {
      align-self: center;
      padding: 2px 6px;
      border: none;
      background: transparent;
      color: rgba(255,255,255,0.3);
      font-size: 9px;
      font-weight: 600;
      cursor: pointer;
      transition: color 0.15s ease;
    }
    #pott-history-clear:hover { color: #ff4d6d; }
    #pott-history-clear.pott-confirm { color: #ff4d6d; }

    #pott-pair-card[hidden] { display: none; }

    /* --- История: кнопка «Назад» и строка «Итог» как вход в историю --- */
    #pott-history-foot { display: flex; justify-content: space-between; align-items: center; }
    #pott-history-back {
      padding: 2px 6px;
      border: none;
      background: transparent;
      color: rgba(255,255,255,0.55);
      font-size: 9px;
      font-weight: 700;
      cursor: pointer;
    }
    #pott-history-back:hover { color: #fff; }

  `;
  document.documentElement.appendChild(style);

  // Пока сайт не загрузился полностью, виджет и кнопки в шапке невидимы (но уже работают
  // в фоне: собирают котировки, восстанавливают размытия). Правило снимается в revealWhenReady().
  const preloadStyle = document.createElement('style');
  preloadStyle.id = 'pott-preload';
  preloadStyle.textContent = '#pott-widget, #pott-mini, .pott-quick { visibility: hidden !important; }';
  document.documentElement.appendChild(preloadStyle);

  /* ================= РАЗМЕТКА ================= */
  const box = document.createElement('div');
  box.id = 'pott-widget';
  box.innerHTML = `
    <div id="pott-drag" title="Перетащить"></div>
    <div id="pott-head">
      <span id="pott-title"><span id="pott-hunter">HUNTER</span> <span id="pott-team">TEAM</span></span>
    </div>
    <div id="pott-divider"></div>

    <div class="pott-view" id="pott-view-tracker">
    <div class="pott-grid">
      <div class="pott-card pott-win">
        <div class="pott-label">WIN</div>
        <div class="pott-val" id="pott-win-val">0</div>
        <div class="pott-mini-btns">
          <button class="pott-btn" id="pott-win-plus" title="Добавить"><svg viewBox="0 0 10 10"><line x1="5" y1="1" x2="5" y2="9"></line><line x1="1" y1="5" x2="9" y2="5"></line></svg></button>
          <button class="pott-btn" id="pott-win-minus" title="Убавить"><svg viewBox="0 0 10 10"><line x1="1" y1="5" x2="9" y2="5"></line></svg></button>
        </div>
      </div>
      <div class="pott-card pott-loss">
        <div class="pott-label">LOSE</div>
        <div class="pott-val" id="pott-loss-val">0</div>
        <div class="pott-mini-btns">
          <button class="pott-btn" id="pott-loss-plus" title="Добавить"><svg viewBox="0 0 10 10"><line x1="5" y1="1" x2="5" y2="9"></line><line x1="1" y1="5" x2="9" y2="5"></line></svg></button>
          <button class="pott-btn" id="pott-loss-minus" title="Убавить"><svg viewBox="0 0 10 10"><line x1="1" y1="5" x2="9" y2="5"></line></svg></button>
        </div>
      </div>
    </div>

    </div>

    <!-- Служебные кнопки размытия/лупы: не показываются, ими управляют кнопки в шапке сайта -->
    <div class="pott-view" id="pott-view-blur" hidden>
      <div class="pott-grid">
        <div class="pott-card pott-tool">
          <div class="pott-label">РАЗМЫТИЕ</div>
          <button class="pott-tool-btn" id="pott-blur-select" title="Нажмите, затем кликните по элементу на странице - он размоется. Повторный клик по нему снимает размытие">
            <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"></circle><path d="M10 2.5 A7.5 7.5 0 0 1 10 17.5 Z" fill="currentColor"></path></svg>
          </button>
          <div class="pott-hint">клик по элементу</div>
        </div>
        <div class="pott-card pott-tool">
          <div class="pott-label">ЛУПА</div>
          <button class="pott-tool-btn" id="pott-blur-draw" title="Выделите прямоугольником место - оно увеличится в 3 раза. Если лупа уже включена, кнопка её выключает">
            <svg viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.8"></circle><line x1="12.6" y1="12.6" x2="17" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line></svg>
          </button>
          <div class="pott-hint">выделите область</div>
        </div>
      </div>
      <div id="pott-blur-summary">
        <div id="pott-blur-count-wrap">
          <span id="pott-blur-count">0</span>
          <span class="pott-hint">активных<br>областей</span>
        </div>
        <button id="pott-blur-clear" title="Снять всё размытие и увеличение">Сбросить всё</button>
      </div>
    </div>

    <div class="pott-view" id="pott-view-history" hidden>
      <div id="pott-days-head">
        <span class="pott-label">ИСТОРИЯ ПО ДНЯМ</span>
        <button class="pott-icon-btn" id="pott-days-reset" title="Сбросить статистику"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="2.5 4.5 13.5 4.5"></polyline><path d="M6 4.5V3h4v1.5"></path><path d="M4 4.5l.7 8.5h6.6l.7-8.5"></path><line x1="6.8" y1="7" x2="6.8" y2="11"></line><line x1="9.2" y1="7" x2="9.2" y2="11"></line></svg></button>
      </div>
      <div class="pott-days-row pott-days-cols"><span>ДАТА</span><span>W</span><span>L</span><span>ПРИБЫЛЬ</span></div>
      <div id="pott-days-list"></div>
      <div class="pott-days-row" id="pott-days-total" title="Вернуться"></div>
      <div id="pott-days-confirm" hidden>
        <div class="pott-days-q">Сбросить статистику?</div>
        <button class="pott-days-btn" data-reset="day">Текущий день</button>
        <button class="pott-days-btn pott-danger" data-reset="all">За всё время</button>
        <button class="pott-days-btn pott-ghost" data-reset="cancel">Отмена</button>
      </div>
    </div>

    <div id="pott-pair-card">
      <input id="pott-pair" maxlength="20" readonly tabindex="-1" />
      <div id="pott-clock"><span class="pott-live-dot"></span><span id="pott-clock-text">--:--:--</span><span id="pott-clock-tz"></span></div>
    </div>

    <div id="pott-balance-card">
      <div id="pott-bal-head">
        <span class="pott-label">БАЛАНС</span>
      </div>
      <div id="pott-bal-grid">
        <div>
          <div class="pott-bal-lbl">СТАРТ</div>
          <div class="pott-bal-val" id="pott-bal-start" title="Двойной клик - ввести стартовый баланс вручную">—</div>
        </div>
        <div class="pott-sep"></div>
        <div>
          <div class="pott-bal-lbl">СЕЙЧАС</div>
          <div class="pott-bal-val" id="pott-bal-now">—</div>
        </div>
      </div>
      <div id="pott-bal-total" title="История по дням">Итог: <span id="pott-bal-profit">—</span></div>
    </div>

    <div id="pott-resize"></div>
  `;
  document.documentElement.appendChild(box);

  const els = {
    pair: box.querySelector('#pott-pair'),
    win: box.querySelector('#pott-win-val'),
    loss: box.querySelector('#pott-loss-val'),
    clock: box.querySelector('#pott-clock-text'),
    tz: box.querySelector('#pott-clock-tz'),
  };

  function render() {
    if (document.activeElement !== els.pair) els.pair.value = state.pair;
    els.win.textContent = state.win;
    els.loss.textContent = state.loss;
  }
  render();

  function bump(el) {
    el.classList.add('pott-bump');
    setTimeout(() => el.classList.remove('pott-bump'), 150);
  }

  // "+" записывает сделку в историю, "−" убирает последнюю запись того же типа.
  box.querySelector('#pott-win-plus').onclick = () => { state.win++; addHistory('w'); bump(els.win); saveState(state); render(); };
  box.querySelector('#pott-win-minus').onclick = () => {
    if (state.win > 0) { state.win--; }
    saveState(state); render();
  };
  box.querySelector('#pott-loss-plus').onclick = () => { state.loss++; addHistory('l'); bump(els.loss); saveState(state); render(); };
  box.querySelector('#pott-loss-minus').onclick = () => {
    if (state.loss > 0) { state.loss--; }
    saveState(state); render();
  };

  // Пара всегда берётся с сайта (ручного ввода больше нет - в том числе сбрасываем
  // ручной режим, если он остался со старой версии).
  state.autoPair = true;

  /* ================= ИЗМЕНЕНИЕ РАЗМЕРА ================= */
  const MIN_SCALE = 0.65;
  const MAX_SCALE = 1.8;
  function applyScale() { box.style.transform = `scale(${state.scale})`; }
  applyScale();

  (function makeResizable() {
    const handle = box.querySelector('#pott-resize');
    let resizing = false, startX = 0, startY = 0, startScale = 1;
    handle.addEventListener('mousedown', (e) => {
      resizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startScale = state.scale;
      e.preventDefault();
      e.stopPropagation();
    });
    window.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const delta = ((e.clientX - startX) + (e.clientY - startY)) / 2;
      state.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, startScale + delta / 260));
      applyScale();
    });
    window.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing = false;
      saveState(state);
    });
  })();

  /* ================= ПОЗИЦИЯ (запоминается между перезагрузками) ================= */
  // Ставит виджет на сохранённое место (state.pos), не давая ему вылезти за край окна.
  // Сохранённое место при этом НЕ меняется: если окно временно меньше или открыт
  // высокий экран, виджет лишь сдвигается на время и потом возвращается туда, где был.
  // fromCurrent = true - взять текущее положение на экране (после перетаскивания).
  function clampPosition(fromCurrent) {
    // Спрятанный (свёрнутый) виджет имеет нулевой размер - пропускаем, иначе он «прыгнет» в угол.
    if (box.hidden || !box.isConnected) return state.pos;
    const rect = box.getBoundingClientRect();
    if (!rect.width || !rect.height) return state.pos;
    const base = fromCurrent === true || !state.pos ? { left: rect.left, top: rect.top } : state.pos;
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    const left = Math.round(Math.min(maxLeft, Math.max(0, base.left)));
    const top = Math.round(Math.min(maxTop, Math.max(0, base.top)));
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.right = 'auto';
    return { left, top };
  }
  function applySavedPosition() {
    if (!state.pos || typeof state.pos.left !== 'number' || typeof state.pos.top !== 'number') return;
    box.style.left = state.pos.left + 'px';
    box.style.top = state.pos.top + 'px';
    box.style.right = 'auto';
    requestAnimationFrame(clampPosition);
  }
  applySavedPosition();
  window.addEventListener('resize', () => { if (state.pos) clampPosition(); });

  /* ================= ПЕРЕТАСКИВАНИЕ (за шапку) ================= */
  (function makeDraggable() {
    const handle = box.querySelector('#pott-drag');
    let dragging = false, offX = 0, offY = 0;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      const rect = box.getBoundingClientRect();
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      box.style.left = (e.clientX - offX) + 'px';
      box.style.top = (e.clientY - offY) + 'px';
      box.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      state.pos = clampPosition(true);
      saveState(state);
    });
  })();

  /* ================= ЧАСЫ ================= */
  (function initClock() {
    let lastFound = null;
    function updateClock() {
      const found = detectTime();
      if (found) {
        lastFound = found;
        els.clock.textContent = found.time;
        els.tz.textContent = found.tz ? '(' + found.tz + ')' : '';
      } else if (!lastFound) {
        els.clock.textContent = '--:--:--';
      }
    }
    updateClock();
    setInterval(updateClock, POLL_MS);
  })();

  /* ================= АВТООПРЕДЕЛЕНИЕ ПАРЫ ================= */
  setInterval(() => {
    if (!state.autoPair) return;
    const found = detectPair();
    if (found && found !== state.pair) {
      state.pair = found;
      rememberPair(found);
      saveState(state);
      render();
    }
  }, POLL_MS);
  // В «Недавние» попадают только настоящие пары вида «AUD/CAD OTC».
  const isRealPair = (p) => /^[A-Z]{3}\/[A-Z]{3}(\s*OTC)?$/i.test(String(p || '').trim());
  function rememberPair(p) {
    if (!Array.isArray(state.recentPairs)) state.recentPairs = [];
    state.recentPairs = state.recentPairs.filter(isRealPair);
    if (!isRealPair(p)) return;
    const k = pairKey(p);
    state.recentPairs = [p.trim()].concat(state.recentPairs.filter((x) => pairKey(x) !== k)).slice(0, 12);
  }
  function pairKey(p) { return String(p || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  if (state.pair) rememberPair(state.pair);

  /* =====================================================================
     РАЗМЫТИЕ И ЛУПА (перенесено из "Pocket Option Blur & Magnify Widget" 3.70)
     Хранилище то же самое, поэтому уже сохранённые области подхватятся.
  ===================================================================== */
  const BLUR_KEY = 'po_blur_widget_state_v2';
  const REAPPLY_MS = 60;

  function gmGet(key) {
    try { if (typeof GM_getValue === 'function') return GM_getValue(key, null); } catch (e) {}
    return null;
  }
  function gmSet(key, value) {
    try { if (typeof GM_setValue === 'function') GM_setValue(key, value); } catch (e) {}
  }
  function lsGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function lsSet(key, value) { try { window.localStorage.setItem(key, value); } catch (e) {} }

  function loadBlurState() {
    const rawGm = gmGet(BLUR_KEY);
    const rawLs = lsGet(BLUR_KEY);
    let raw = rawGm || rawLs;
    try {
      const a = rawGm ? JSON.parse(rawGm) : null;
      const b = rawLs ? JSON.parse(rawLs) : null;
      if (a && b) raw = (a._t || 0) >= (b._t || 0) ? rawGm : rawLs;
    } catch (e) {}
    try {
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.paths)) parsed.paths = [];
        if (!Array.isArray(parsed.patches)) parsed.patches = [];
        if (!Array.isArray(parsed.magnify)) parsed.magnify = [];
        return parsed;
      }
    } catch (e) {}
    return { paths: [], patches: [], magnify: [] };
  }
  function saveBlurState() {
    blurState._t = Date.now();
    const json = JSON.stringify(blurState);
    gmSet(BLUR_KEY, json);
    lsSet(BLUR_KEY, json);
  }
  let blurState = CLIENT ? { paths: [], patches: [], magnify: [] } : loadBlurState();

  /* --- Построение устойчивого пути до элемента --- */
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return s.replace(/([^\w-])/g, '\\$1');
  }
  const STABLE_ATTRS = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'name', 'placeholder', 'aria-label', 'role', 'type'];
  const LOOKS_LIKE_INSTANCE_ID = /-?\d+$/;
  function bemClasses(node) {
    return (typeof node.className === 'string' ? node.className : '')
      .trim().split(/\s+/).filter(Boolean).filter((c) => /__|--/.test(c));
  }
  function withSiblingIndex(node, part) {
    const parent = node.parentElement;
    if (!parent) return part;
    const sameTag = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
    if (sameTag.length > 1) return part + ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
    return part;
  }
  function nodeSelectorPart(node) {
    const tag = node.tagName.toLowerCase();
    if (node.id && !LOOKS_LIKE_INSTANCE_ID.test(node.id)) return { part: '#' + cssEscape(node.id), strong: true };
    const bem = bemClasses(node);
    if (bem.length) {
      const part = tag + '.' + bem.slice(0, 2).map(cssEscape).join('.');
      return { part: withSiblingIndex(node, part), strong: true };
    }
    for (const attr of STABLE_ATTRS) {
      const val = node.getAttribute && node.getAttribute(attr);
      if (val) {
        const part = tag + '[' + attr + '="' + cssEscape(val) + '"]';
        return { part: withSiblingIndex(node, part), strong: true };
      }
    }
    if (node.id) return { part: '#' + cssEscape(node.id), strong: true };
    const cls = (typeof node.className === 'string' ? node.className : '')
      .trim().split(/\s+/).filter(Boolean)
      .filter((c) => !c.startsWith('pott-'))
      .slice(0, 3);
    let part = tag;
    if (cls.length) part += '.' + cls.map(cssEscape).join('.');
    return { part: withSiblingIndex(node, part), strong: false };
  }
  function getPath(el) {
    const parts = [];
    let node = el, depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 10) {
      const res = nodeSelectorPart(node);
      parts.unshift(res.part);
      if (res.strong) break;
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }
  function findByPath(path) { try { return document.querySelector(path); } catch (e) { return null; } }
  function findAllByPath(path) {
    try { return Array.prototype.slice.call(document.querySelectorAll(path)); } catch (e) { return []; }
  }

  /* --- Элементы управления --- */
  const drawPreview = document.createElement('div');
  drawPreview.id = 'pottb-draw-preview';
  document.documentElement.appendChild(drawPreview);

  const blurEls = {
    select: box.querySelector('#pott-blur-select'),
    draw: box.querySelector('#pott-blur-draw'),
    clear: box.querySelector('#pott-blur-clear'),
    count: box.querySelector('#pott-blur-count'),
  };

  let selectMode = false;
  let drawMode = false;
  let hoveredEl = null;

  function isInsideWidget(el) {
    return !!(el && el.closest && (el.closest('#pott-widget') || el.closest('#pottb-draw-preview') ||
      el.closest('#pott-mini') || el.closest('.pott-quick') || el.closest('#pott-settings')));
  }

  function updateBlurCount() {
    blurEls.count.textContent = blurState.paths.length + blurState.patches.length + blurState.magnify.length;
  }

  // Клики по виджету не должны "закрывать" открытые окна сайта (обработчики "клик снаружи").
  ['mousedown', 'click', 'pointerdown', 'touchstart'].forEach((type) => {
    box.addEventListener(type, (e) => { e.stopPropagation(); });
    drawPreview.addEventListener(type, (e) => { e.stopPropagation(); });
  });

  /* --- Применение сохранённого --- */
  function reapplyElementBlurs() {
    for (const path of blurState.paths) {
      const el = findByPath(path);
      if (el && !el.classList.contains('pott-blur-target')) el.classList.add('pott-blur-target');
    }
    for (const m of blurState.magnify) {
      const el = findByPath(m.path);
      if (el && !el.classList.contains('pott-magnify-target')) {
        el.classList.add('pott-magnify-target');
        el.style.transformOrigin = m.originX + '% ' + m.originY + '%';
      }
    }
  }

  const blurredEls = new Map();
  const lastMatchAt = new Map();
  const GRACE_MS = 700;
  const MAX_MATCH_DIST = 120;

  function sizeMatches(rect, patch) {
    if (rect.width <= 0 || rect.height <= 0) return false;
    const ratioW = rect.width / patch.w;
    const ratioH = rect.height / patch.h;
    return ratioW > 0.75 && ratioW < 1.35 && ratioH > 0.6 && ratioH < 1.6;
  }
  function positionScore(rect, patch) {
    const distDoc = Math.hypot(
      rect.left + window.scrollX + rect.width / 2 - (patch.docLeft + patch.w / 2),
      rect.top + window.scrollY + rect.height / 2 - (patch.docTop + patch.h / 2));
    const distVp = Math.hypot(
      rect.left + rect.width / 2 - (patch.vpLeft + patch.w / 2),
      rect.top + rect.height / 2 - (patch.vpTop + patch.h / 2));
    return Math.min(distDoc, distVp);
  }
  function findMatchedElement(patch, vw, vh) {
    if (patch.domPath) {
      let best = null, bestScore = Infinity;
      for (const el of findAllByPath(patch.domPath)) {
        if (!el.isConnected || isInsideWidget(el)) continue;
        const rect = el.getBoundingClientRect();
        if (!sizeMatches(rect, patch)) continue;
        const score = positionScore(rect, patch);
        if (score < bestScore) { bestScore = score; best = el; }
      }
      if (best && bestScore <= MAX_MATCH_DIST) return best;
    }
    const points = [
      { x: patch.docLeft - window.scrollX + patch.w / 2, y: patch.docTop - window.scrollY + patch.h / 2 },
      { x: patch.vpLeft + patch.w / 2, y: patch.vpTop + patch.h / 2 },
    ];
    for (const c of points) {
      if (c.x < 0 || c.y < 0 || c.x > vw || c.y > vh) continue;
      let el = document.elementFromPoint(c.x, c.y);
      while (el && isInsideWidget(el)) el = el.parentElement;
      if (!el || el === document.body || el === document.documentElement) continue;
      if (sizeMatches(el.getBoundingClientRect(), patch)) return el;
    }
    return null;
  }
  function refreshPatchTracking() {
    if (blurState.patches.length === 0) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const now = Date.now();
    const currentPath = window.location.pathname;
    for (const patch of blurState.patches) {
      const prevEl = blurredEls.get(patch.id) || null;
      if (patch.pathname && patch.pathname !== currentPath) {
        if (prevEl) { prevEl.classList.remove('pott-blur-target'); blurredEls.set(patch.id, null); }
        continue;
      }
      const matched = findMatchedElement(patch, vw, vh);
      if (matched) {
        lastMatchAt.set(patch.id, now);
        if (matched !== prevEl) {
          if (prevEl) prevEl.classList.remove('pott-blur-target');
          blurredEls.set(patch.id, matched);
        }
        if (!matched.classList.contains('pott-blur-target')) matched.classList.add('pott-blur-target');
        continue;
      }
      if (prevEl && now - (lastMatchAt.get(patch.id) || 0) > GRACE_MS) {
        prevEl.classList.remove('pott-blur-target');
        blurredEls.set(patch.id, null);
      }
    }
  }

  setInterval(reapplyElementBlurs, REAPPLY_MS);
  setInterval(refreshPatchTracking, REAPPLY_MS);
  reapplyElementBlurs();
  refreshPatchTracking();

  let burstUntil = 0, burstRunning = false;
  function burstTick(now) {
    reapplyElementBlurs();
    refreshPatchTracking();
    if (now < burstUntil) requestAnimationFrame(burstTick);
    else burstRunning = false;
  }
  function scheduleBurst() {
    burstUntil = performance.now() + 500;
    if (!burstRunning) { burstRunning = true; requestAnimationFrame(burstTick); }
  }
  new MutationObserver(scheduleBurst).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('mousedown', scheduleBurst, true);
  window.addEventListener('click', scheduleBurst, true);
  window.addEventListener('scroll', () => refreshPatchTracking(), true);
  window.addEventListener('resize', () => refreshPatchTracking());

  /* --- Режим "клик по элементу" (размытие) --- */
  function setSelectMode(on) {
    selectMode = on;
    if (on) setDrawMode(false);
    blurEls.select.classList.toggle('pott-on', on);
    document.body.classList.toggle('pott-blur-select-mode', on);
    if (!on && hoveredEl) {
      hoveredEl.classList.remove('pott-blur-hover-candidate');
      hoveredEl = null;
    }
  }
  blurEls.select.addEventListener('click', () => setSelectMode(!selectMode));

  window.addEventListener('mouseover', (e) => {
    if (!selectMode) return;
    const el = e.target;
    if (isInsideWidget(el)) return;
    if (hoveredEl && hoveredEl !== el) hoveredEl.classList.remove('pott-blur-hover-candidate');
    hoveredEl = el;
    hoveredEl.classList.add('pott-blur-hover-candidate');
  }, true);

  window.addEventListener('click', (e) => {
    if (!selectMode) return;
    const el = e.target;
    if (isInsideWidget(el)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    el.classList.remove('pott-blur-hover-candidate');

    const rect = el.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const docLeft = rect.left + window.scrollX;
    const docTop = rect.top + window.scrollY;
    const EPS = 24;
    const currentPathname = window.location.pathname;
    const existing = blurState.patches.find((p) =>
      (!p.pathname || p.pathname === currentPathname) &&
      Math.abs(p.docLeft - docLeft) < EPS && Math.abs(p.docTop - docTop) < EPS &&
      Math.abs(p.w - w) < EPS && Math.abs(p.h - h) < EPS);

    if (existing) {
      const prevEl = blurredEls.get(existing.id);
      if (prevEl) prevEl.classList.remove('pott-blur-target');
      blurredEls.delete(existing.id);
      blurState.patches = blurState.patches.filter((p) => p.id !== existing.id);
    } else {
      const patch = {
        id: 'p' + Date.now() + Math.random().toString(36).slice(2, 6),
        w, h, vpLeft: rect.left, vpTop: rect.top, docLeft, docTop,
        domPath: getPath(el),
        pathname: currentPathname,
      };
      blurState.patches.push(patch);
      el.classList.add('pott-blur-target');
      blurredEls.set(patch.id, el);
    }
    saveBlurState();
    updateBlurCount();
  }, true);

  /* --- Режим "лупа" --- */
  function updateDrawButtonVisual() {
    blurEls.draw.classList.toggle('pott-on', drawMode || blurState.magnify.length > 0);
  }
  function setDrawMode(on) {
    drawMode = on;
    if (on) setSelectMode(false);
    document.body.classList.toggle('pott-blur-draw-mode', on);
    updateDrawButtonVisual();
  }
  function clearAllMagnify() {
    document.querySelectorAll('.pott-magnify-target').forEach((el) => {
      el.classList.remove('pott-magnify-target');
      el.style.transformOrigin = '';
    });
    blurState.magnify = [];
    saveBlurState();
    updateBlurCount();
    updateDrawButtonVisual();
  }
  blurEls.draw.addEventListener('click', () => {
    if (drawMode) setDrawMode(false);
    else if (blurState.magnify.length > 0) clearAllMagnify();
    else setDrawMode(true);
  });

  let drawing = false, startX = 0, startY = 0;
  window.addEventListener('mousedown', (e) => {
    if (!drawMode || isInsideWidget(e.target)) return;
    drawing = true;
    startX = e.clientX;
    startY = e.clientY;
    Object.assign(drawPreview.style, { display: 'block', left: startX + 'px', top: startY + 'px', width: '0px', height: '0px' });
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true);
  window.addEventListener('mousemove', (e) => {
    if (!drawMode || !drawing) return;
    Object.assign(drawPreview.style, {
      left: Math.min(e.clientX, startX) + 'px',
      top: Math.min(e.clientY, startY) + 'px',
      width: Math.abs(e.clientX - startX) + 'px',
      height: Math.abs(e.clientY - startY) + 'px',
    });
    e.preventDefault();
    e.stopPropagation();
  }, true);
  window.addEventListener('mouseup', (e) => {
    if (!drawMode || !drawing) return;
    drawing = false;
    drawPreview.style.display = 'none';
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const cx = Math.min(e.clientX, startX) + Math.abs(e.clientX - startX) / 2;
    const cy = Math.min(e.clientY, startY) + Math.abs(e.clientY - startY) / 2;
    let target = document.elementFromPoint(cx, cy);
    while (target && isInsideWidget(target)) target = target.parentElement;
    if (!target || target === document.body || target === document.documentElement) { setDrawMode(false); return; }
    const path = getPath(target);
    if (!path) { setDrawMode(false); return; }

    if (target.classList.contains('pott-magnify-target')) {
      target.classList.remove('pott-magnify-target');
      target.style.transformOrigin = '';
      blurState.magnify = blurState.magnify.filter((m) => m.path !== path);
    } else {
      const rect = target.getBoundingClientRect();
      const originX = rect.width ? Math.min(100, Math.max(0, ((cx - rect.left) / rect.width) * 100)) : 50;
      const originY = rect.height ? Math.min(100, Math.max(0, ((cy - rect.top) / rect.height) * 100)) : 50;
      target.classList.add('pott-magnify-target');
      target.style.transformOrigin = originX + '% ' + originY + '%';
      blurState.magnify.push({ path, originX, originY });
    }
    saveBlurState();
    updateBlurCount();
    setDrawMode(false);
  }, true);

  // Esc выключает активный режим выбора.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (selectMode) setSelectMode(false);
    if (drawMode) { drawing = false; drawPreview.style.display = 'none'; setDrawMode(false); }
  });

  /* --- Сбросить всё --- */
  blurEls.clear.addEventListener('click', () => {
    document.querySelectorAll('.pott-blur-target').forEach((el) => el.classList.remove('pott-blur-target'));
    blurredEls.clear();
    document.querySelectorAll('.pott-magnify-target').forEach((el) => {
      el.classList.remove('pott-magnify-target');
      el.style.transformOrigin = '';
    });
    blurState.paths = [];
    blurState.patches = [];
    blurState.magnify = [];
    saveBlurState();
    updateBlurCount();
    updateDrawButtonVisual();
  });

  updateBlurCount();
  updateDrawButtonVisual();

  /* ================= ИСТОРИЯ СДЕЛОК (клик по TEAM) =================
     Каждый "+" у WIN/LOSE добавляет запись (время + пара).
     "−" убирает последнюю запись того же типа - это исправление ошибки. */
  const HISTORY_LIMIT = 3000;
  const HISTORY_DAYS = 60;
  if (!Array.isArray(state.history)) state.history = [];

  function pruneHistory() {
    const minT = Date.now() - HISTORY_DAYS * 86400000;
    state.history = state.history.filter((h) => h && h.t >= minT);
    if (state.history.length > HISTORY_LIMIT) state.history = state.history.slice(-HISTORY_LIMIT);
  }
  function addHistory(r) {
    state.history.push({ t: Date.now(), r, p: (state.pair || '').trim() });
    addDayResult(r);
    pruneHistory();
    if (state.view === 'history') renderDays();
  }
  // «−» у счётчика меняет только сессию. Из истории дня запись убирается, только если
  // она сделана меньше минуты назад - это исправление случайного «+».
  const UNDO_WINDOW_MS = 60 * 1000;
  function removeLastHistory(r) {
    for (let i = state.history.length - 1; i >= 0; i--) {
      if (state.history[i].r !== r) continue;
      if (Date.now() - state.history[i].t <= UNDO_WINDOW_MS) {
        removeDayResult(r, state.history[i].t);
        state.history.splice(i, 1);
        if (state.view === 'history') renderDays();
      }
      return;
    }
  }
  pruneHistory();

  // --- Итоги по дням: WIN, LOSE и прибыль/убыток за каждый день (хранятся без ограничения по сроку) ---
  function dayKey(t) {
    const d = new Date(t);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  if (!state.days || typeof state.days !== 'object') {
    // Первый запуск - переносим уже записанные WIN/LOSE.
    state.days = {};
    for (const h of state.history) {
      const d = state.days[dayKey(h.t)] || (state.days[dayKey(h.t)] = { w: 0, l: 0, p: 0 });
      if (h.r === 'w') d.w++; else d.l++;
    }
  }
  function dayRec(t) {
    const k = dayKey(t || Date.now());
    return state.days[k] || (state.days[k] = { w: 0, l: 0, p: 0 });
  }
  function addDayResult(r, t) { const d = dayRec(t); if (r === 'w') d.w++; else d.l++; }
  function removeDayResult(r, t) { const d = dayRec(t); if (r === 'w') d.w = Math.max(0, d.w - 1); else d.l = Math.max(0, d.l - 1); }
  function addDayPnl(v, t) {
    if (!isFinite(v) || !v) return;
    const d = dayRec(t);
    d.p = Math.round(((d.p || 0) + v) * 100) / 100;
    saveState(state);
    if (state.view === 'history') renderDays();
  }

  const daysEls = {
    list: box.querySelector('#pott-days-list'),
    total: box.querySelector('#pott-days-total'),
  };
  // Прокрутка списка не должна зумить график сайта.
  daysEls.list.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function dayLabel(k) {
    if (k === dayKey(Date.now())) return 'Сегодня';
    if (k === dayKey(Date.now() - 86400000)) return 'Вчера';
    const [y, m, d] = k.split('-');
    const wd = new Date(+y, +m - 1, +d).toLocaleDateString('ru-RU', { weekday: 'short' });
    return d + '.' + m + ' ' + wd;
  }
  function moneyCell(v) {
    const c = el('span', v > 0 ? 'pott-c-win' : v < 0 ? 'pott-c-loss' : '', (v > 0 ? '+' : v < 0 ? '−' : '') + fmtMoneyDays(Math.abs(v)));
    return c;
  }
  function fmtMoneyDays(v) { return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
  function renderDays() {
    const keys = Object.keys(state.days).filter((k) => { const d = state.days[k]; return d.w || d.l || d.p; }).sort().reverse();
    daysEls.list.textContent = '';
    let W = 0, L = 0, P = 0;
    if (!keys.length) daysEls.list.appendChild(el('div', 'pott-days-empty', 'Пока пусто. Здесь будут итоги каждого дня: WIN, LOSE и прибыль.'));
    for (const k of keys) {
      const d = state.days[k];
      W += d.w; L += d.l; P += d.p || 0;
      const row = el('div', 'pott-days-row');
      row.append(el('span', '', dayLabel(k)), el('span', 'pott-c-win', String(d.w)), el('span', 'pott-c-loss', String(d.l)), moneyCell(d.p || 0));
      daysEls.list.appendChild(row);
    }
    daysEls.total.textContent = '';
    daysEls.total.append(el('span', '', 'Итого'), el('span', 'pott-c-win', String(W)), el('span', 'pott-c-loss', String(L)), moneyCell(Math.round(P * 100) / 100));
  }
  // Смена дня в полночь - обновить подписи «Сегодня» / «Вчера».
  setInterval(() => { if (state.view === 'history') renderDays(); }, 60000);

  /* =====================================================================
     СИГНАЛ ПО ТЕКУЩЕЙ ПАРЕ (клик по TEAM)
     1) Котировки берутся из потока цен, который сайт получает по WebSocket.
     2) Из тиков строятся свечи выбранного размера, по ним считаются 5 индикаторов.
     3) Сигнал есть, только если минимум 4 из 5 индикаторов согласны.
     4) «Взять сигнал» фиксирует цену входа; в момент экспирации виджет сам
        сравнивает цену и записывает WIN / LOSE / возврат - отсюда реальный винрейт.
  ===================================================================== */

  // --- 1. Перехват котировок. Код ниже выполняется в "мире" страницы:
  //        подменяем чтение event.data у сообщений WebSocket, чтобы видеть
  //        все входящие данные, даже если сокет создан раньше виджета.
  function pottWsHook() {
    if (window.__pottWsHook) return;
    window.__pottWsHook = true;
    const desc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
    if (!desc || !desc.get) return;
    const origGet = desc.get;
    const seen = new WeakSet();
    const dec = new TextDecoder();

    function toSec(t) { return t > 1e12 ? t / 1000 : t; }
    function isNum(x) { return typeof x === 'number' && isFinite(x); }
    let assetsOut = [];
    let dealsOut = [];
    function walk(j, out, depth) {
      if (depth > 4 || j == null) return;
      if (Array.isArray(j)) {
        // Список активов с выплатами: [[id, "AUDCAD_otc", "AUD/CAD OTC", "currency", _, 92, ...], ...]
        if (j.length >= 1 && Array.isArray(j[0]) && isNum(j[0][0]) && typeof j[0][1] === 'string' && typeof j[0][2] === 'string' &&
            (j.length >= 3 || (j[0].length >= 6 && isNum(j[0][5]) && /^[A-Za-z#0-9_.\-]{3,}$/.test(j[0][1])))) {
          for (const r of j) {
            if (Array.isArray(r) && typeof r[1] === 'string' && typeof r[2] === 'string') {
              assetsOut.push([r[1], r[2], isNum(r[5]) ? r[5] : null, typeof r[3] === 'string' ? r[3] : '']);
            }
          }
          return;
        }
        if (j.length && Array.isArray(j[0]) && typeof j[0][0] === 'string' && isNum(j[0][1]) && isNum(j[0][2])) {
          for (const r of j) if (Array.isArray(r) && typeof r[0] === 'string' && isNum(r[1]) && isNum(r[2])) out.push([r[0], toSec(r[1]), r[2]]);
          return;
        }
        for (const x of j) if (x && typeof x === 'object') walk(x, out, depth + 1);
        return;
      }
      if (typeof j !== 'object') return;
      // Закрытая сделка: есть id, сумма, прибыль и признак закрытия (цена закрытия / isWin).
      if (j.id != null && isNum(j.amount) && isNum(j.profit) &&
          ((isNum(j.closePrice) && j.closePrice > 0) || typeof j.isWin === 'boolean' || j.closed === true)) {
        const ct = [j.closeTimestamp, j.closeTime, j.close_time, j.closedAt].find(isNum);
        dealsOut.push({ id: String(j.id), amount: j.amount, profit: j.profit, isWin: typeof j.isWin === 'boolean' ? j.isWin : null,
          closeTime: ct != null ? toSec(ct) : null });
        return;
      }
      const asset = typeof j.asset === 'string' ? j.asset : (typeof j.symbol === 'string' ? j.symbol : null);
      if (asset) {
        let got = false;
        if (Array.isArray(j.history)) {
          for (const r of j.history) if (Array.isArray(r) && isNum(r[0]) && isNum(r[1])) { out.push([asset, toSec(r[0]), r[1]]); got = true; }
        }
        if (!got && Array.isArray(j.data)) {
          for (const c of j.data) if (c && isNum(c.time) && isNum(c.close)) { out.push([asset, toSec(c.time), c.close]); got = true; }
        }
        if (!got && Array.isArray(j.candles)) {
          for (const c of j.candles) if (Array.isArray(c) && isNum(c[0]) && isNum(c[2])) out.push([asset, toSec(c[0]), c[2]]);
        }
        return;
      }
      for (const k in j) if (j[k] && typeof j[k] === 'object') walk(j[k], out, depth + 1);
    }
    function handleText(text) {
      if (typeof text !== 'string' || text.length > 3e6) return;
      if (text.indexOf('asset') < 0 && text.indexOf('[["') < 0 && text.indexOf('symbol') < 0 && text.indexOf('_otc') < 0 && text.indexOf('profit') < 0) return;
      const i = text.search(/[\[{]/);
      if (i < 0) return;
      let j;
      try { j = JSON.parse(text.slice(i)); } catch (e) { return; }
      const out = [];
      assetsOut = [];
      dealsOut = [];
      walk(j, out, 0);
      if (dealsOut.length) window.postMessage({ __pottDeals: dealsOut }, '*');
      if (out.length) window.postMessage({ __pottTicks: out }, '*');
      if (assetsOut.length) window.postMessage({ __pottAssets: assetsOut }, '*');
    }
    Object.defineProperty(MessageEvent.prototype, 'data', {
      configurable: true,
      enumerable: desc.enumerable,
      get: function () {
        const d = origGet.call(this);
        try {
          if (!seen.has(this) && this.target instanceof WebSocket) {
            seen.add(this);
            if (typeof d === 'string') handleText(d);
            else if (d instanceof ArrayBuffer) handleText(dec.decode(d));
            else if (typeof Blob !== 'undefined' && d instanceof Blob) d.text().then(handleText, () => {});
          }
        } catch (e) {}
        return d;
      },
    });
  }
  try { pottWsHook(); } catch (e) {}
  try {
    // На случай, если расширение запускает скрипт в изолированной среде -
    // дублируем перехватчик прямо в страницу.
    const s = document.createElement('script');
    s.textContent = '(' + pottWsHook.toString() + ')();';
    (document.head || document.documentElement).appendChild(s);
    s.remove();
  } catch (e) {}

  // --- 2. Хранилище тиков по парам ---
  const ticks = new Map(); // ключ пары -> [[t, price], ...] по возрастанию времени
  const MAX_TICKS = 15000;
  let lastTickAt = 0;
  function assetKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !Array.isArray(e.data.__pottTicks)) return;
    const touched = new Set();
    for (const [asset, t, p] of e.data.__pottTicks) {
      const k = assetKey(asset);
      let arr = ticks.get(k);
      if (!arr) { arr = []; ticks.set(k, arr); }
      if (!arr.length || t > arr[arr.length - 1][0]) arr.push([t, p]);
      else { arr.push([t, p]); touched.add(k); }
    }
    for (const k of touched) {
      const arr = ticks.get(k).sort((a, b) => a[0] - b[0]);
      const clean = [];
      for (const x of arr) if (!clean.length || x[0] > clean[clean.length - 1][0]) clean.push(x);
      ticks.set(k, clean);
    }
    for (const [k, arr] of ticks) if (arr.length > MAX_TICKS) ticks.set(k, arr.slice(-MAX_TICKS));
    lastTickAt = Date.now();
  });
  function currentTicks() { return ticks.get(assetKey(state.pair)) || []; }

  // OTC-пары с текущей выплатой. Источники: поток данных сайта (updateAssets) или
  // меню выбора актива на сайте. Последний список хранится, чтобы после перезагрузки
  // он был сразу.
  const otcAssets = new Map(); // ключ пары -> { name, payout }. Список пар и проверка процентов убраны
  delete state.otcCache; delete state.otcGone;
  let otcUpdatedAt = 0;
  // Процент выплаты по текущей паре прямо с сайта (рядом с названием пары или в блоке выплаты).
  function sitePayout() {
    if (findSiteSearch()) return null; // открыт список активов - там другие проценты
    const pick = (t) => { const m = String(t || '').match(/\+?\s*(\d{2,3})\s*%/); const v = m ? +m[1] : NaN; return v >= 10 && v <= 100 ? v : null; };
    const opener = findPairOpener();
    if (opener) {
      let el = opener;
      for (let i = 0; i < 4 && el && el !== document.body; i++, el = el.parentElement) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length > 70) break;
        const v = pick(t);
        if (v != null) return v;
      }
    }
    // Панель ставки: «Выплата $1.92  +92%».
    for (const el of document.querySelectorAll('div, span')) {
      if (el.childElementCount || ownWidget(el)) continue;
      const t = (el.textContent || '').trim();
      if (!/^\+\d{2,3}\s*%$/.test(t) || !siteVisible(el)) continue;
      let p = el.parentElement;
      for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
        if (/выплат|payout|доходн/i.test(p.textContent || '') && (p.textContent || '').length < 120) return pick(t);
      }
    }
    for (const el of document.querySelectorAll('[class*="payout"], [class*="profit-percent"], [class*="percent"]')) {
      if (ownWidget(el) || !siteVisible(el)) continue;
      const t = (el.textContent || '').trim();
      if (t.length <= 12 && /%/.test(t)) { const v = pick(t); if (v != null) return v; }
    }
    return null;
  }
  function otcName(symbol, name) {
    const n = String(name || symbol || '').trim();
    return /otc/i.test(n) ? n.replace(/\s*otc$/i, ' OTC') : n + ' OTC';
  }
  let otcSaveTimer = 0;
  // Пары, которых нет в списке сайта (закрыты): скрываем на 12 часов или пока сайт снова их не покажет.
  const GONE_MS = 12 * 60 * 60 * 1000;
  if (!state.otcGone || typeof state.otcGone !== 'object') state.otcGone = {};
  function isGone(name) { const t = state.otcGone[assetKey(name)]; return !!t && Date.now() - t < GONE_MS; }
  function markGone(name) {
    state.otcGone[assetKey(name)] = Date.now();
    otcAssets.delete(assetKey(name));
    saveState(state);
  }
  // Пара снова есть в меню сайта - возвращаем её.
  function unmarkGone(rows) {
    let ch = false;
    for (const [name] of rows) if (state.otcGone[assetKey(name)]) { delete state.otcGone[assetKey(name)]; ch = true; }
    if (ch) saveState(state);
  }
  function storeOtc(rows, replace) {
    if (replace) otcAssets.clear();
    for (const [name, payout] of rows) otcAssets.set(assetKey(name), { name, payout });
    otcUpdatedAt = Date.now();
    clearTimeout(otcSaveTimer);
    otcSaveTimer = setTimeout(() => {
      state.otcCache = { t: otcUpdatedAt, list: Array.from(otcAssets.values()).map((a) => [a.name, a.payout]) };
      saveState(state);
    }, 1000);
    try { if (!pairsPop.hidden) renderPairs(); } catch (e) {} // список пар объявлен ниже
  }

  /* ================= ПЕРЕКЛЮЧЕНИЕ ЭКРАНОВ («Итог» - история) ================= */
  const views = {
    tracker: box.querySelector('#pott-view-tracker'),
    history: box.querySelector('#pott-view-history'),
  };
  const pairCard = box.querySelector('#pott-pair-card');
  const balCardEl = box.querySelector('#pott-balance-card');
  function applyView() {
    if (!views[state.view]) state.view = 'tracker';
    if (state.view === 'history') {
      // Обратная сторона того же размера: сначала меряем лицевую сторону и фиксируем высоту.
      if (!box.style.height && !box.hidden) {
        views.tracker.hidden = false; views.history.hidden = true; pairCard.hidden = false; balCardEl.hidden = !!state.balanceHidden;
        box.style.height = box.offsetHeight + 'px';
      }
    } else {
      box.style.height = '';
    }
    for (const [name, node] of Object.entries(views)) node.hidden = name !== state.view;
    pairCard.hidden = state.view !== 'tracker';
    balCardEl.hidden = state.view !== 'tracker' || !!state.balanceHidden;
    if (state.view === 'history') renderDays();
    const dc = box.querySelector('#pott-days-confirm');
    if (dc) dc.hidden = true;
    if (state.pos) requestAnimationFrame(clampPosition);
  }
  function toggleView(name) {
    state.view = state.view === name ? 'tracker' : name;
    saveState(state);
    applyView();
  }
  // Переворот виджета, как карточки: половина оборота - смена стороны - вторая половина.
  let flipping = false;
  function flipTo(name) {
    if (flipping) return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !box.animate) { toggleView(name); return; }
    flipping = true;
    const s = state.scale || 1;
    const tf = (deg) => 'perspective(900px) scale(' + s + ') rotateY(' + deg + 'deg)';
    const a = box.animate([{ transform: tf(0) }, { transform: tf(90) }], { duration: 170, easing: 'ease-in' });
    a.onfinish = () => {
      toggleView(name);
      const b = box.animate([{ transform: tf(-90) }, { transform: tf(0) }], { duration: 170, easing: 'ease-out' });
      b.onfinish = () => { flipping = false; };
    };
  }
  box.querySelector('#pott-bal-total').addEventListener('click', () => flipTo('history'));
  // «Итого» на обратной стороне возвращает виджет обратно.
  box.querySelector('#pott-days-total').addEventListener('click', () => flipTo('history'));
  // Сброс статистики: текущий день или за всё время (счётчики WIN/LOSE и сессию не трогает).
  const daysConfirm = box.querySelector('#pott-days-confirm');
  box.querySelector('#pott-days-reset').addEventListener('click', () => { daysConfirm.hidden = false; });
  daysConfirm.addEventListener('click', (e) => {
    const b = e.target.closest('[data-reset]');
    if (!b) return;
    const what = b.dataset.reset;
    if (what === 'day') {
      const k = dayKey(Date.now());
      delete state.days[k];
      state.history = state.history.filter((h) => dayKey(h.t) !== k);
    } else if (what === 'all') {
      state.days = {};
      state.history = [];
    }
    daysConfirm.hidden = true;
    if (what !== 'cancel') { saveState(state); renderDays(); }
  });
  applyView();

  /* ================= ВЫБОР ПАРЫ =================
     Клик по названию пары открывает список: недавние пары + популярные OTC и поиск.
     Выбранная пара переключается на самом сайте: виджет открывает выбор актива
     Pocket Option, вводит название в поиск и нажимает нужный пункт. Название в виджете
     потом обновляется само, по тому, что стало на сайте. */
  const pairsPop = document.createElement('div');
  pairsPop.id = 'pott-pairs';
  pairsPop.hidden = true;
  pairsPop.innerHTML = '<div id="pott-pairs-list"></div><div id="pott-pairs-status"></div>';
  document.documentElement.appendChild(pairsPop);
  pairsPop.addEventListener('keydown', (e) => { if (e.key === 'Escape') togglePairs(false); });
  ['mousedown', 'click', 'pointerdown', 'touchstart', 'wheel', 'keydown', 'keyup', 'keypress'].forEach((type) => {
    pairsPop.addEventListener(type, (e) => e.stopPropagation());
  });
  const pairsList = pairsPop.querySelector('#pott-pairs-list');
  const pairsStatus = pairsPop.querySelector('#pott-pairs-status');

  // Флаги валют в кружочках, как в списке активов на платформе.
  const CUR_FLAG = {"USD":"us","EUR":"eu","GBP":"gb","JPY":"jp","AUD":"au","CAD":"ca","CHF":"ch","NZD":"nz","CNY":"cn","CNH":"cn","HKD":"hk","SGD":"sg","NOK":"no","SEK":"se","DKK":"dk","PLN":"pl","HUF":"hu","CZK":"cz","TRY":"tr","RUB":"ru","UAH":"ua","ZAR":"za","MXN":"mx","BRL":"br","ARS":"ar","CLP":"cl","COP":"co","INR":"in","IDR":"id","MYR":"my","PHP":"ph","THB":"th","VND":"vn","KRW":"kr","PKR":"pk","BDT":"bd","AED":"ae","SAR":"sa","QAR":"qa","OMR":"om","BHD":"bh","KWD":"kw","JOD":"jo","LBP":"lb","EGP":"eg","MAD":"ma","TND":"tn","DZD":"dz","NGN":"ng","KES":"ke","YER":"ye","IRR":"ir","ILS":"il","KZT":"kz","GEL":"ge","RON":"ro","BGN":"bg","ISK":"is","TWD":"tw","PEN":"pe","UZS":"uz","AZN":"az","BYN":"by","LKR":"lk","NPR":"np","GHS":"gh"};
  const FLAG_SVG = {"us":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#bd3d44\" d=\"M0 0h512v512H0\"/><path stroke=\"#fff\" stroke-width=\"40\" d=\"M0 58h512M0 137h512M0 216h512M0 295h512M0 374h512M0 453h512\"/><path fill=\"#192f5d\" d=\"M0 0h390v275H0z\"/><marker id=\"a\" markerHeight=\"30\" markerWidth=\"30\"><path fill=\"#fff\" d=\"m15 0 9.3 28.6L0 11h30L5.7 28.6\"/></marker><path fill=\"none\" marker-mid=\"url(#a)\" d=\"m0 0 18 11h65 65 65 65 66L51 39h65 65 65 65L18 66h65 65 65 65 66L51 94h65 65 65 65L18 121h65 65 65 65 66L51 149h65 65 65 65L18 177h65 65 65 65 66L51 205h65 65 65 65L18 232h65 65 65 65 66z\"/></svg>","eu":"<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><defs><g id=\"d\"><g id=\"b\"><path id=\"a\" d=\"m0-1-.3 1 .5.1z\"/><use xlink:href=\"#a\" transform=\"scale(-1 1)\"/></g><g id=\"c\"><use xlink:href=\"#b\" transform=\"rotate(72)\"/><use xlink:href=\"#b\" transform=\"rotate(144)\"/></g><use xlink:href=\"#c\" transform=\"scale(-1 1)\"/></g></defs><path fill=\"#039\" d=\"M0 0h512v512H0z\"/><g fill=\"#fc0\" transform=\"translate(256 258.4)scale(25.28395)\"><use xlink:href=\"#d\" width=\"100%\" height=\"100%\" y=\"-6\"/><use xlink:href=\"#d\" width=\"100%\" height=\"100%\" y=\"6\"/><g id=\"e\"><use xlink:href=\"#d\" width=\"100%\" height=\"100%\" x=\"-6\"/><use xlink:href=\"#d\" width=\"100%\" height=\"100%\" transform=\"rotate(-144 -2.3 -2.1)\"/><use xlink:href=\"#d\" width=\"100%\" height=\"100%\" transform=\"rotate(144 -2.1 -2.3)\"/><use xlink:href=\"#d\" width=\"100%\" height=\"100%\" transform=\"rotate(72 -4.7 -2)\"/><use xlink:href=\"#d\" width=\"100%\" height=\"100%\" transform=\"rotate(72 -5 .5)\"/></g><use xlink:href=\"#e\" width=\"100%\" height=\"100%\" transform=\"scale(-1 1)\"/></g></svg>","gb":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#012169\" d=\"M0 0h512v512H0z\"/><path fill=\"#FFF\" d=\"M512 0v64L322 256l190 187v69h-67L254 324 68 512H0v-68l186-187L0 74V0h62l192 188L440 0z\"/><path fill=\"#C8102E\" d=\"m184 324 11 34L42 512H0v-3zm124-12 54 8 150 147v45zM512 0 320 196l-4-44L466 0zM0 1l193 189-59-8L0 49z\"/><path fill=\"#FFF\" d=\"M176 0v512h160V0zM0 176v160h512V176z\"/><path fill=\"#C8102E\" d=\"M0 208v96h512v-96zM208 0v512h96V0z\"/></svg>","jp":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><defs><clipPath id=\"a\"><path fill-opacity=\".7\" d=\"M177.2 0h708.6v708.7H177.2z\"/></clipPath></defs><g fill-rule=\"evenodd\" stroke-width=\"1pt\" clip-path=\"url(#a)\" transform=\"translate(-128)scale(.72249)\"><path fill=\"#fff\" d=\"M0 0h1063v708.7H0z\"/><circle cx=\"523.1\" cy=\"344.1\" r=\"194.9\" fill=\"#bc002d\" transform=\"translate(-59.7 -34.5)scale(1.1302)\"/></g></svg>","au":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#00008B\" d=\"M0 0h512v512H0z\"/><path fill=\"#fff\" d=\"M256 0v32l-95 96 95 93.5V256h-33.5L127 162l-93 94H0v-34l93-93.5L0 37V0h31l96 94 93-94z\"/><path fill=\"red\" d=\"m92 162 5.5 17L21 256H0v-1.5zm62-6 27 4 75 73.5V256zM256 0l-96 98-2-22 75-76zM0 .5 96.5 95 67 91 0 24.5z\"/><path fill=\"#fff\" d=\"M88 0v256h80V0zM0 88v80h256V88z\"/><path fill=\"red\" d=\"M0 104v48h256v-48zM104 0v256h48V0z\"/><path fill=\"#fff\" d=\"m202 402.8-45.8 5.4 4.6 45.9-32.8-32.4-33 32.2 4.9-45.9-45.8-5.8L93 377.4 69 338l43.6 15 15.8-43.4 15.5 43.5 43.7-14.7-24.3 39.2 38.8 25.1Zm222.7 8-20.5 2.6 2.2 20.5-14.8-14.4-14.7 14.5 2-20.5-20.5-2.4 17.3-11.2-10.9-17.5 19.6 6.5 6.9-19.5 7.1 19.4 19.5-6.7-10.7 17.6zM415 293.6l2.7-13-9.8-9 13.2-1.5 5.5-12.1 5.5 12.1 13.2 1.5-9.8 9 2.7 13-11.6-6.6zm-84.1-60-20.3 2.2 1.8 20.3-14.4-14.5-14.8 14.1 2.4-20.3-20.2-2.7 17.3-10.8-10.5-17.5 19.3 6.8 7.2-19.1 6.7 19.3 19.4-6.3-10.9 17.3zm175.8-32.8-20.9 2.7 2.3 20.9-15.1-14.7-15 14.8 2.1-21-20.9-2.4 17.7-11.5-11.1-17.9 20 6.7 7-19.8 7.2 19.8 19.9-6.9-11 18zm-82.1-83.5-20.7 2.3 1.9 20.8-14.7-14.8L376 140l2.4-20.7-20.7-2.8 17.7-11-10.7-17.9 19.7 6.9 7.3-19.5 6.8 19.7 19.8-6.5-11.1 17.6z\"/></svg>","ca":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#fff\" d=\"M81.1 0h362.3v512H81.1z\"/><path fill=\"#d52b1e\" d=\"M-100 0H81.1v512H-100zm543.4 0h181.1v512H443.4zM135.3 247.4l-14 4.8 65.4 57.5c5 14.8-1.7 19.1-6 26.9l71-9-1.8 71.5 14.8-.5-3.3-70.9 71.2 8.4c-4.4-9.3-8.3-14.2-4.3-29l65.4-54.5-11.4-4.1c-9.4-7.3 4-34.8 6-52.2 0 0-38.1 13.1-40.6 6.2l-9.9-18.5-34.6 38c-3.8 1-5.4-.6-6.3-3.8l16-79.7-25.4 14.3q-3.3 1.3-5.6-2.4l-24.5-49-25.2 50.9q-3 2.7-5.4.8l-24.2-13.6 14.5 79.2c-1.1 3-3.9 4-7.1 2.3l-33.3-37.8c-4.3 7-7.3 18.4-13 21-5.7 2.3-25-4.9-37.9-7.7 4.4 15.9 18.2 42.3 9.5 51z\"/></svg>","ch":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><g fill-rule=\"evenodd\" stroke-width=\"1pt\"><path fill=\"red\" d=\"M0 0h512v512H0z\"/><g fill=\"#fff\"><path d=\"M96 208h320v96H96z\"/><path d=\"M208 96h96v320h-96z\"/></g></g></svg>","nz":"<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><defs><g id=\"b\"><g id=\"a\"><path d=\"M0-.3v.5l1-.5z\"/><path d=\"M.2.3 0-.1l1-.2z\"/></g><use xlink:href=\"#a\" transform=\"scale(-1 1)\"/><use xlink:href=\"#a\" transform=\"rotate(72 0 0)\"/><use xlink:href=\"#a\" transform=\"rotate(-72 0 0)\"/><use xlink:href=\"#a\" transform=\"scale(-1 1)rotate(72)\"/></g></defs><path fill=\"#00247d\" fill-rule=\"evenodd\" d=\"M0 0h512v512H0z\"/><g transform=\"translate(-148.7 90.5)scale(.60566)\"><use xlink:href=\"#b\" width=\"100%\" height=\"100%\" fill=\"#fff\" transform=\"translate(900 120)scale(45.4)\"/><use xlink:href=\"#b\" width=\"100%\" height=\"100%\" fill=\"#cc142b\" transform=\"matrix(30 0 0 30 900 120)\"/></g><g transform=\"rotate(82 418.7 105.1)scale(.60566)\"><use xlink:href=\"#b\" width=\"100%\" height=\"100%\" fill=\"#fff\" transform=\"rotate(-82 519 -457.7)scale(40.4)\"/><use xlink:href=\"#b\" width=\"100%\" height=\"100%\" fill=\"#cc142b\" transform=\"rotate(-82 519 -457.7)scale(25)\"/></g><g transform=\"rotate(82 418.7 105.1)scale(.60566)\"><use xlink:href=\"#b\" width=\"100%\" height=\"100%\" fill=\"#fff\" transform=\"rotate(-82 668.6 -327.7)scale(45.4)\"/><use xlink:href=\"#b\" width=\"100%\" height=\"100%\" fill=\"#cc142b\" transform=\"rotate(-82 668.6 -327.7)scale(30)\"/></g><g transform=\"translate(-148.7 90.5)scale(.60566)\"><use xlink:href=\"#b\" width=\"100%\" height=\"100%\" fill=\"#fff\" transform=\"translate(900 480)scale(50.4)\"/><use xlink:href=\"#b\" width=\"100%\" height=\"100%\" fill=\"#cc142b\" transform=\"matrix(35 0 0 35 900 480)\"/></g><path fill=\"#012169\" d=\"M0 0h256v256H0z\"/><path fill=\"#fff\" d=\"M256 0v32l-95 96 95 93.5V256h-33.5L127 162l-93 94H0v-34l93-93.5L0 37V0h31l96 94 93-94z\"/><path fill=\"#c8102e\" d=\"m92 162 5.5 17L21 256H0v-1.5zm62-6 27 4 75 73.5V256zM256 0l-96 98-2-22 75-76zM0 .5 96.5 95 67 91 0 24.5z\"/><path fill=\"#fff\" d=\"M88 0v256h80V0zM0 88v80h256V88z\"/><path fill=\"#c8102e\" d=\"M0 104v48h256v-48zM104 0v256h48V0z\"/></svg>","cn":"<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><defs><path id=\"a\" fill=\"#ff0\" d=\"M1-.3-.7.8 0-1 .6.8-1-.3z\"/></defs><path fill=\"#ee1c25\" d=\"M0 0h512v512H0z\"/><use xlink:href=\"#a\" width=\"30\" height=\"20\" transform=\"translate(128 128)scale(76.8)\"/><use xlink:href=\"#a\" width=\"30\" height=\"20\" transform=\"rotate(-121 142.6 -47)scale(25.5827)\"/><use xlink:href=\"#a\" width=\"30\" height=\"20\" transform=\"rotate(-98.1 198 -82)scale(25.6)\"/><use xlink:href=\"#a\" width=\"30\" height=\"20\" transform=\"rotate(-74 272.4 -114)scale(25.6137)\"/><use xlink:href=\"#a\" width=\"30\" height=\"20\" transform=\"matrix(16 -19.968 19.968 16 256 230.4)\"/></svg>","hk":"<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><path fill=\"#EC1B2E\" d=\"M0 0h512v512H0\"/><path id=\"a\" fill=\"#fff\" d=\"M282.3 119.2C203 114 166.6 218 241.6 256.4 215.6 234 221 201 231.5 184l1.9 1c-13.8 23.6-11.2 52.8 11 71-12.6-12.2-9.4-39 12.2-48.8s23.6-39.3 16.4-49.1q-14.7-25.6 9.3-39zM243.9 180l-4.7 7.4-1.8-8.6-8.6-2.3 7.8-4.3-.6-9 6.5 6.2 8.3-3.3-3.7 8 5.6 6.9z\"/><use xlink:href=\"#a\" transform=\"rotate(72 248.5 259.5)\"/><use xlink:href=\"#a\" transform=\"rotate(144 248.5 259.5)\"/><use xlink:href=\"#a\" transform=\"rotate(216 248.5 259.5)\"/><use xlink:href=\"#a\" transform=\"rotate(288 248.5 259.5)\"/></svg>","sg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><defs><clipPath id=\"a\"><path fill-opacity=\".7\" d=\"M27.7 0h708.6v708.7H27.7z\"/></clipPath></defs><g fill-rule=\"evenodd\" clip-path=\"url(#a)\" transform=\"translate(-20)scale(.72249)\"><path fill=\"#fff\" d=\"M0 0h1063v708.7H0z\"/><path fill=\"#df0000\" d=\"M0 0h1063v354.3H0z\"/><path fill=\"#fff\" d=\"M245.2 59.4a124.6 124.6 0 0 0 1.1 243.9 126.9 126.9 0 1 1-1.1-243.9\"/><path fill=\"#fff\" d=\"m202 162.4-18.9-13.8 23.5-.2 7.2-22.3 7.5 22.3h23.4l-18.8 14 7.2 22.3L214 171l-19 13.8zm26 76.9-19-13.8 23.5-.2 7.3-22.3 7.4 22.2h23.5l-19 14 7.3 22.3-19-13.6-19 13.8zm86.3-.6-19-13.8 23.4-.2 7.3-22.3 7.4 22.3H357l-18.9 14 7.3 22.3-19.1-13.7-19 13.8zm25.7-76.2-19-13.8 23.5-.2 7.2-22.3 7.5 22.2h23.4l-18.8 14 7.2 22.3-19.1-13.6-19 13.8zM271.7 112l-19-13.8 23.5-.2 7.3-22.3 7.4 22.3h23.5l-19 14 7.3 22.2-19-13.6-19 13.8z\"/></g></svg>","no":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#ed2939\" d=\"M0 0h512v512H0z\"/><path fill=\"#fff\" d=\"M128 0h128v512H128z\"/><path fill=\"#fff\" d=\"M0 192h512v128H0z\"/><path fill=\"#002664\" d=\"M160 0h64v512h-64z\"/><path fill=\"#002664\" d=\"M0 224h512v64H0z\"/></svg>","se":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#005293\" d=\"M0 0h512v512H0z\"/><path fill=\"#fecb00\" d=\"M134 0v204.8H0v102.4h134V512h102.4V307.2H512V204.8H236.4V0z\"/></svg>","dk":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#c8102e\" d=\"M0 0h512.1v512H0z\"/><path fill=\"#fff\" d=\"M144 0h73.1v512H144z\"/><path fill=\"#fff\" d=\"M0 219.4h512.1v73.2H0z\"/></svg>","pl":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><g fill-rule=\"evenodd\"><path fill=\"#fff\" d=\"M512 512H0V0h512z\"/><path fill=\"#dc143c\" d=\"M512 512H0V256h512z\"/></g></svg>","hu":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><g fill-rule=\"evenodd\"><path fill=\"#fff\" d=\"M512 512H0V0h512z\"/><path fill=\"#388d00\" d=\"M512 512H0V341.3h512z\"/><path fill=\"#d43516\" d=\"M512 170.8H0V.1h512z\"/></g></svg>","cz":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#fff\" d=\"M0 0h512v256H0z\"/><path fill=\"#d7141a\" d=\"M0 256h512v256H0z\"/><path fill=\"#11457e\" d=\"M300 256 0 56v400z\"/></svg>","tr":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><g fill-rule=\"evenodd\"><path fill=\"#e30a17\" d=\"M0 0h512v512H0z\"/><path fill=\"#fff\" d=\"M348.8 264c0 70.6-58.3 127.9-130.1 127.9s-130.1-57.3-130.1-128 58.2-127.8 130-127.8S348.9 193.3 348.9 264z\"/><path fill=\"#e30a17\" d=\"M355.3 264c0 56.5-46.6 102.3-104.1 102.3s-104-45.8-104-102.3 46.5-102.3 104-102.3 104 45.8 104 102.3z\"/><path fill=\"#fff\" d=\"m374.1 204.2-1 47.3-44.2 12 43.5 15.5-1 43.3 28.3-33.8 42.9 14.8-24.8-36.3 30.2-36.1-46.4 12.8z\"/></g></svg>","ru":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#fff\" d=\"M0 0h512v170.7H0z\"/><path fill=\"#0039a6\" d=\"M0 170.7h512v170.6H0z\"/><path fill=\"#d52b1e\" d=\"M0 341.3h512V512H0z\"/></svg>","ua":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><g fill-rule=\"evenodd\" stroke-width=\"1pt\"><path fill=\"gold\" d=\"M0 0h512v512H0z\"/><path fill=\"#0057b8\" d=\"M0 0h512v256H0z\"/></g></svg>","za":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><defs><clipPath id=\"a\"><path fill-opacity=\".7\" d=\"M70.1 0h499.6v499.6H70.1z\"/></clipPath></defs><g clip-path=\"url(#a)\" transform=\"translate(-71.9)scale(1.0248)\"><g fill-rule=\"evenodd\" stroke-width=\"1pt\"><path fill=\"#000001\" d=\"M0 397.9v-296l220.4 147.9z\"/><path fill=\"#000c8a\" d=\"m150.4 499.7 247.4-166.5h351.6v166.5z\"/><path fill=\"#e1392d\" d=\"M134.5 0h615v166.6H397.7S137.8-1.6 134.5 0\"/><path fill=\"#ffb915\" d=\"M0 62.5v39.3l220.4 148L0 397.8v39.4l277.6-187.4z\"/><path fill=\"#007847\" d=\"M0 62.5V0h92.6l294 199h362.8v101.7H386.6l-294 198.9H0v-62.4l277.6-187.4z\"/><path fill=\"#fff\" d=\"M92.6 0h57.8l247.4 166.6h351.6V199H386.6zm0 499.7h57.8l247.4-166.5h351.6v-32.4H386.6z\"/></g></g></svg>","mx":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#006847\" d=\"M0 0h171v512H0z\"/><path fill=\"#fff\" d=\"M171 0h170v512H171z\"/><path fill=\"#ce1126\" d=\"M341 0h171v512H341z\"/><circle cx=\"256\" cy=\"256\" r=\"60\" fill=\"#8c5a2b\"/><circle cx=\"256\" cy=\"256\" r=\"34\" fill=\"#4a7c2a\"/></svg>","br":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#229e45\" d=\"M0 0h512v512H0z\"/><path fill=\"#f8e509\" d=\"M256 60l220 196-220 196L36 256z\"/><circle cx=\"256\" cy=\"256\" r=\"110\" fill=\"#2b49a3\"/><path fill=\"#fff\" d=\"M150 230q106-30 212 30v24q-106-60-212-30z\"/></svg>","ar":"<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><path fill=\"#74acdf\" d=\"M0 0h512v512H0z\"/><path fill=\"#fff\" d=\"M0 170.7h512v170.7H0z\"/><g id=\"c\" transform=\"translate(-153.6)scale(1.024)\"><path id=\"a\" fill=\"#f6b40e\" stroke=\"#85340a\" stroke-width=\"1.1\" d=\"m396.8 251.3 28.5 62s.5 1.2 1.3.9c.8-.4.3-1.6.3-1.6l-23.7-64m-.7 24.2c-.4 9.4 5.4 14.6 4.7 23s3.8 13.2 5 16.5c1 3.3-1.2 5.2-.3 5.7 1 .5 3-2.1 2.4-6.8s-4.2-6-3.4-16.3-4.2-12.7-3-22\"/><use xlink:href=\"#a\" width=\"100%\" height=\"100%\" transform=\"rotate(22.5 400 250)\"/><use xlink:href=\"#a\" width=\"100%\" height=\"100%\" transform=\"rotate(45 400 250)\"/><use xlink:href=\"#a\" width=\"100%\" height=\"100%\" transform=\"rotate(67.5 400 250)\"/><path id=\"b\" fill=\"#85340a\" d=\"M404.3 274.4c.5 9 5.6 13 4.6 21.3 2.2-6.5-3.1-11.6-2.8-21.2m-7.7-23.8 19.5 42.6-16.3-43.9\"/><use xlink:href=\"#b\" width=\"100%\" height=\"100%\" transform=\"rotate(22.5 400 250)\"/><use xlink:href=\"#b\" width=\"100%\" height=\"100%\" transform=\"rotate(45 400 250)\"/><use xlink:href=\"#b\" width=\"100%\" height=\"100%\" transform=\"rotate(67.5 400 250)\"/></g><use xlink:href=\"#c\" width=\"100%\" height=\"100%\" transform=\"rotate(90 256 256)\"/><use xlink:href=\"#c\" width=\"100%\" height=\"100%\" transform=\"rotate(180 256 256)\"/><use xlink:href=\"#c\" width=\"100%\" height=\"100%\" transform=\"rotate(-90 256 256)\"/><circle cx=\"256\" cy=\"256\" r=\"28.4\" fill=\"#f6b40e\" stroke=\"#85340a\" stroke-width=\"1.5\"/><path id=\"h\" fill=\"#843511\" stroke-width=\"1\" d=\"M265.7 250q-3.1 0-4.9 2.5c2.2 2 7 2.2 10.3-.2a8 8 0 0 0-5.4-2.4zm0 .4c1.9 0 3.6.8 3.9 1.7-2.2 2.4-5.7 2.2-7.9.4q1.6-2.2 4-2.1\"/><use xlink:href=\"#d\" width=\"100%\" height=\"100%\" transform=\"matrix(-1 0 0 1 512.3 0)\"/><use xlink:href=\"#e\" width=\"100%\" height=\"100%\" transform=\"matrix(-1 0 0 1 512.3 0)\"/><use xlink:href=\"#f\" width=\"100%\" height=\"100%\" transform=\"translate(19.3)\"/><use xlink:href=\"#g\" width=\"100%\" height=\"100%\" transform=\"matrix(-1 0 0 1 512.3 0)\"/><path fill=\"#85340a\" d=\"M251.6 260a2 2 0 1 0 2 3q1.4.8 2.4.6h.3c.5 0 1.6 0 2.3-.6q.6.8 1.6.8a2 2 0 0 0 .4-3.9q.8.3.9 1.3a1.3 1.3 0 0 1-2.7 0 3 3 0 0 1-2.7 1.8 3 3 0 0 1-2.7-1.8q-.1 1.2-1.3 1.3a1.3 1.3 0 0 1-.4-2.6zm2.2 5.8c-2.2 0-3 2-5 3.3l3.5-2.2c1.5-.9 2.8.2 3.7.2s2.2-1.1 3.7-.2q2 1.4 3.5 2.2c-2-1.4-2.8-3.3-5-3.3a6 6 0 0 0-2.2.6q-1.6-.6-2.2-.6\"/><path fill=\"#85340a\" d=\"M253 268.3q-1.2 0-3.6.8c4-1 4.8.4 6.6.4s2.6-1.3 6.6-.4c-4.4-1.4-5.3-.5-6.6-.5-.9 0-1.5-.3-3-.3\"/><path fill=\"#85340a\" d=\"M249.6 269h-.8c4.6.5 2.4 3.1 7.2 3.1s2.6-2.6 7.2-3c-4.8-.5-3.3 2.4-7.2 2.4-3.7 0-2.6-2.5-6.4-2.5\"/><path fill=\"#85340a\" d=\"M260 276.1a4 4 0 0 0-8 0 4 4 0 0 1 8 0\"/><path id=\"e\" fill=\"#85340a\" stroke-width=\"1\" d=\"M238.3 249.9c5-4.4 11.4-5 14.9-1.8a9 9 0 0 1 1.6 3.7q.7 3.8-2.3 8 .5 0 1 .4 2.6-5.1 1.7-10l-.7-2.5c-4.8-4-11.4-4.4-16.2 2.2\"/><path id=\"d\" fill=\"#85340a\" stroke-width=\"1\" d=\"M246.2 248.6c2.8 0 3.5.6 4.8 1.7s2 .9 2.2 1.1 0 .9-.4.7q-.7-.3-2.7-1.8c-1.3-1-2.6-1-4-1-3.8 0-6 3.2-6.5 3s2.2-3.7 6.6-3.7\"/><use xlink:href=\"#h\" width=\"100%\" height=\"100%\" transform=\"translate(-19.6)\"/><circle id=\"f\" cx=\"246.3\" cy=\"252.1\" r=\"2\" fill=\"#85340a\" stroke-width=\"1\"/><path id=\"g\" fill=\"#85340a\" stroke-width=\"1\" d=\"M241 253.4c3.7 2.8 7.4 2.6 9.6 1.3s2.2-1.8 1.7-1.8c-.4 0-.9.5-2.6 1.4s-4.4.8-8.8-1z\"/></svg>","cl":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><defs><clipPath id=\"a\"><path fill-opacity=\".7\" d=\"M0 0h708.7v708.7H0z\"/></clipPath></defs><g fill-rule=\"evenodd\" clip-path=\"url(#a)\" transform=\"scale(.722)\"><path fill=\"#fff\" d=\"M354.3 0H1063v354.3H354.3z\"/><path fill=\"#0039a6\" d=\"M0 0h354.3v354.3H0z\"/><path fill=\"#fff\" d=\"m232.3 265.3-55-41.1-54.5 41.5 20.3-67.5-54.5-41.7 67.4-.6 21-67.3 21.3 67.2h67.5L211.4 198z\"/><path fill=\"#d52b1e\" d=\"M0 354.3h1063v354.4H0z\"/></g></svg>","co":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><g fill-rule=\"evenodd\" stroke-width=\"1pt\"><path fill=\"#ffe800\" d=\"M0 0h512v512H0z\"/><path fill=\"#00148e\" d=\"M0 256h512v256H0z\"/><path fill=\"#da0010\" d=\"M0 384h512v128H0z\"/></g></svg>","in":"<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><path fill=\"#f93\" d=\"M0 0h512v170.7H0z\"/><path fill=\"#fff\" d=\"M0 170.7h512v170.6H0z\"/><path fill=\"#128807\" d=\"M0 341.3h512V512H0z\"/><g transform=\"translate(256 256)scale(3.41333)\"><circle r=\"20\" fill=\"#008\"/><circle r=\"17.5\" fill=\"#fff\"/><circle r=\"3.5\" fill=\"#008\"/><g id=\"d\"><g id=\"c\"><g id=\"b\"><g id=\"a\" fill=\"#008\"><circle r=\".9\" transform=\"rotate(7.5 -8.8 133.5)\"/><path d=\"M0 17.5.6 7 0 2l-.6 5z\"/></g><use xlink:href=\"#a\" width=\"100%\" height=\"100%\" transform=\"rotate(15)\"/></g><use xlink:href=\"#b\" width=\"100%\" height=\"100%\" transform=\"rotate(30)\"/></g><use xlink:href=\"#c\" width=\"100%\" height=\"100%\" transform=\"rotate(60)\"/></g><use xlink:href=\"#d\" width=\"100%\" height=\"100%\" transform=\"rotate(120)\"/><use xlink:href=\"#d\" width=\"100%\" height=\"100%\" transform=\"rotate(-120)\"/></g></svg>","id":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#e70011\" d=\"M0 0h512v256H0Z\"/><path fill=\"#fff\" d=\"M0 256h512v256H0Z\"/></svg>","my":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#C00\" d=\"M0 0h512v36.6H0z\"/><path fill=\"#fff\" d=\"M0 36.6h512V73H0z\"/><path fill=\"#C00\" d=\"M0 73.1h512v36.6H0z\"/><path fill=\"#fff\" d=\"M0 109.7h512v36.6H0z\"/><path fill=\"#C00\" d=\"M0 146.3h512v36.6H0z\"/><path fill=\"#fff\" d=\"M0 182.9h512v36.5H0z\"/><path fill=\"#C00\" d=\"M0 219.4h512V256H0z\"/><path fill=\"#fff\" d=\"M0 256h512v36.6H0z\"/><path fill=\"#C00\" d=\"M0 292.6h512V329H0z\"/><path fill=\"#fff\" d=\"M0 329.1h512v36.6H0z\"/><path fill=\"#C00\" d=\"M0 365.7h512v36.6H0z\"/><path fill=\"#fff\" d=\"M0 402.3h512v36.6H0z\"/><path fill=\"#C00\" d=\"M0 438.9h512v36.5H0z\"/><path fill=\"#fff\" d=\"M0 475.4h512V512H0z\"/><path fill=\"#006\" d=\"M0 0h256v292.6H0z\"/><path fill=\"#FC0\" d=\"m166 93 4.8 32.5 18.4-27.2-10 31.3 28.5-16.6-22.5 24 32.8-2.6-30.7 11.9L218 158l-32.8-2.5 22.5 24-28.4-16.7 9.8 31.5-18.4-27.3-4.8 32.5-4.7-32.5-18.4 27.2 9.9-31.4-28.4 16.7 22.4-24-32.8 2.5 30.7-11.8-30.6-11.9 32.8 2.6-22.5-24 28.4 16.6-10-31.4 18.5 27.3 4.8-32.6Zm-26.7 1.3a57 57 0 0 0-73 24.9 57 57 0 0 0 45.5 83.8 57 57 0 0 0 27.5-4.7 64 64 0 1 1 0-104\"/></svg>","ph":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#0038a8\" d=\"M0 0h512v256H0z\"/><path fill=\"#ce1126\" d=\"M0 256h512v256H0z\"/><path fill=\"#fff\" d=\"M443.4 256 0 512V0\"/><path fill=\"#fcd116\" d=\"m25.2 44.4 15.4 13.3 17.9-9.8-8 18.7 15 14L45 78.9l-8.6 18.4-4.7-19.8-20.2-2.6L29 64.4zM372.1 229l.4 20.3 19.3 6.7-19.3 6.7-.4 20.3-12.3-16.2-19.5 6L352 256l-11.7-16.7 19.5 5.9zM36.5 414.7l8.6 18.4 20.3-1.7-14.8 14 7.9 18.7-17.9-9.8-15.4 13.3 3.9-20-17.5-10.5 20.2-2.6zM158.9 148l-6.6 6.6 3.2 50.3-3.3.3-6-45.9-5.5 5.4 8.2 41a51 51 0 0 0-18.4 7.7l-23.3-34.8h-7.7l28.2 36.8-2.5 2.1-33.3-38h-9.4v9.5l38 33.3-2.2 2.5-36.8-28.2v7.7l34.8 23.3a51 51 0 0 0-7.6 18.4l-41-8.2-5.5 5.5 46 6-.4 3.4-50.3-3.3-6.7 6.6 6.7 6.6 50.3-3.2.3 3.3-45.9 6 5.4 5.5 41-8.2a51 51 0 0 0 7.7 18.4l-34.8 23.3v7.7l36.8-28.2 2.1 2.5-38 33.3v9.4H92l33.3-38 2.5 2.2-28.2 36.8h7.7l23.3-34.8a51 51 0 0 0 18.4 7.6l-8.2 41 5.5 5.5 6-46 3.3.4-3.2 50.3 6.6 6.7 6.6-6.7-3.2-50.3 3.3-.3 6 45.9 5.5-5.4-8.2-41a51 51 0 0 0 18.4-7.7l23.3 34.8h7.7L190 296.6l2.5-2.1 33.3 38h9.4V323l-38-33.3 2.2-2.5 36.8 28.2v-7.7l-34.8-23.3A51 51 0 0 0 209 266l41 8.2 5.5-5.5-46-6 .4-3.3 50.3 3.2 6.7-6.6-6.7-6.6-50.3 3.3q0-1.8-.3-3.4l45.9-6-5.4-5.5-41 8.2a51 51 0 0 0-7.7-18.4l34.8-23.3v-7.7l-36.8 28.2-2.1-2.5 38-33.3v-9.4h-9.5l-33.3 38-2.5-2.2 28.2-36.8h-7.7l-23.3 34.8a51 51 0 0 0-18.4-7.6l8.2-41-5.5-5.5-6 46-3.3-.4 3.2-50.3z\"/></svg>","th":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><g fill-rule=\"evenodd\"><path fill=\"#f4f5f8\" d=\"M0 0h512v512H0z\"/><path fill=\"#2d2a4a\" d=\"M0 173.4h512V344H0z\"/><path fill=\"#a51931\" d=\"M0 0h512v88H0zm0 426.7h512V512H0z\"/></g></svg>","vn":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><defs><clipPath id=\"a\"><path fill-opacity=\".7\" d=\"M177.2 0h708.6v708.7H177.2z\"/></clipPath></defs><g fill-rule=\"evenodd\" clip-path=\"url(#a)\" transform=\"translate(-128)scale(.72249)\"><path fill=\"#da251d\" d=\"M0 0h1063v708.7H0z\"/><path fill=\"#ff0\" d=\"m661 527.5-124-92.6-123.3 93.5 45.9-152-123.2-93.8 152.4-1.3L536 129.8 584.3 281l152.4.2-122.5 94.7z\"/></g></svg>","kr":"<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><path fill=\"#fff\" fill-rule=\"evenodd\" d=\"M0 0h512v512H0Z\"/><g fill-rule=\"evenodd\" transform=\"rotate(-56.3 367.2 -111.2)scale(9.375)\"><g id=\"b\"><path id=\"a\" fill=\"#000001\" d=\"M-6-26H6v2H-6Zm0 3H6v2H-6Zm0 3H6v2H-6Z\"/><use xlink:href=\"#a\" width=\"100%\" height=\"100%\" y=\"44\"/></g><path stroke=\"#fff\" d=\"M0 17v10\"/><path fill=\"#cd2e3a\" d=\"M0-12a12 12 0 0 1 0 24Z\"/><path fill=\"#0047a0\" d=\"M0-12a12 12 0 0 0 0 24A6 6 0 0 0 0 0Z\"/><circle cy=\"-6\" r=\"6\" fill=\"#cd2e3a\"/></g><g fill-rule=\"evenodd\" transform=\"rotate(-123.7 196.5 59.5)scale(9.375)\"><use xlink:href=\"#b\" width=\"100%\" height=\"100%\"/><path stroke=\"#fff\" d=\"M0-23.5v3M0 17v3.5m0 3v3\"/></g></svg>","pk":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><defs><clipPath id=\"a\"><path fill-opacity=\".7\" d=\"M0 0h512v512H0z\"/></clipPath></defs><g fill-rule=\"evenodd\" stroke-width=\"1pt\" clip-path=\"url(#a)\"><path fill=\"#0c590b\" d=\"M-95 0h768v512H-95z\"/><path fill=\"#fff\" d=\"M-95 0H97.5v512H-95z\"/><g fill=\"#fff\"><path d=\"m403.7 225.4-31.2-6.6-16.4 27.3-3.4-31.6-31-7.2 29-13-2.7-31.7 21.4 23.6 29.3-12.4-15.9 27.6 21 24z\"/><path d=\"M415.4 306a121 121 0 0 1-161.3 59.4 122 122 0 0 1-59.5-162.1A119 119 0 0 1 266 139a156 156 0 0 0-11.8 10.9A112.3 112.3 0 0 0 415.5 306z\"/></g></g></svg>","bd":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#006a4e\" d=\"M0 0h512v512H0z\"/><circle cx=\"230\" cy=\"256\" r=\"170.7\" fill=\"#f42a41\"/></svg>","ae":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#00732f\" d=\"M0 0h512v170.7H0z\"/><path fill=\"#fff\" d=\"M0 170.7h512v170.6H0z\"/><path fill=\"#000001\" d=\"M0 341.3h512V512H0z\"/><path fill=\"red\" d=\"M0 0h180v512H0z\"/></svg>","sa":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#165d31\" d=\"M0 0h512v512H0z\"/><path fill=\"#fff\" d=\"M120 200h272v18H120zM110 320h260l30-14v26H110z\"/></svg>","qa":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#8d1b3d\" d=\"M0 0h512v512H0z\"/><path fill=\"#fff\" d=\"M0 0v512h113l104.2-28.4L113 455l104.2-28.4L113 398.2l104.2-28.4L113 341.3 217.2 313 113 284.4 217.2 256 113 227.6 217.2 199 113 170.7l104.2-28.5L113 113.8l104.2-28.5L113 57l104.2-28.4L113 0z\"/></svg>","om":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#fff\" d=\"M0 0h512v171H0z\"/><path fill=\"#db161b\" d=\"M0 171h512v170H0z\"/><path fill=\"#008000\" d=\"M0 341h512v171H0z\"/><path fill=\"#db161b\" d=\"M0 0h192v512H0z\"/><path fill=\"#fff\" d=\"M70 50h52v14H70zM96 40v70\" stroke=\"#fff\" stroke-width=\"12\"/></svg>","bh":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#fff\" d=\"M0 0h512v512H0\"/><path fill=\"#ce1126\" d=\"M512 0H102.4l83.4 51.2-83.4 51.2 83.4 51.2-83.4 51.2 83.4 51.2-83.4 51.2 83.4 51.2-83.4 51.2 83.4 51.2-83.4 51.2H512\"/></svg>","kw":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><defs><clipPath id=\"a\"><path fill-opacity=\".7\" d=\"M0 0h496v496H0z\"/></clipPath></defs><g fill-rule=\"evenodd\" stroke-width=\"1pt\" clip-path=\"url(#a)\" transform=\"scale(1.0321)\"><path fill=\"#fff\" d=\"M0 165.3h992.1v165.4H0z\"/><path fill=\"#f31830\" d=\"M0 330.7h992.1v165.4H0z\"/><path fill=\"#00d941\" d=\"M0 0h992.1v165.4H0z\"/><path fill=\"#000001\" d=\"M0 0v496l247.5-165.3.5-165.5z\"/></g></svg>","jo":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><defs><clipPath id=\"a\"><path fill-opacity=\".7\" d=\"M113.6 0H607v493.5H113.6z\"/></clipPath></defs><g clip-path=\"url(#a)\" transform=\"translate(-117.8)scale(1.0375)\"><g fill-rule=\"evenodd\" stroke-width=\"1pt\"><path fill=\"#000001\" d=\"M0 0h987v164.5H0z\"/><path fill=\"#fff\" d=\"M0 164.5h987V329H0z\"/><path fill=\"#090\" d=\"M0 329h987v164.5H0z\"/><path fill=\"red\" d=\"m0 493.5 493.5-246.8L0 0z\"/><path fill=\"#fff\" d=\"m164.8 244 22 10.6h-24.5l5.5 24-15.3-19.3-15.3 19.2 5.5-23.9H118l22.1-10.7-15.3-19.1 22.1 10.6 5.5-23.9 5.5 24 22-10.7z\"/></g></g></svg>","lb":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><defs><clipPath id=\"a\"><path fill-opacity=\".7\" d=\"M124 0h496v496H124z\"/></clipPath></defs><g clip-path=\"url(#a)\" transform=\"translate(-128)scale(1.0321)\"><g fill-rule=\"evenodd\" stroke-width=\"1pt\"><path fill=\"#EE161F\" d=\"M0 372h744v124H0zM0 0h744v124H0z\"/><path fill=\"#fff\" d=\"M0 124h744v248H0z\"/></g><path fill=\"#00A850\" d=\"M368.3 125.9c-7.6 15.1-12.7 15.1-25.3 25.2-5 5-12.6 7.5-2.5 12.6-10 5-15.1 7.5-20.2 17.6l2.6 2.5s9.5-4.7 10-2.5c1.7 2-12.6 9.7-14.4 11s-10.8 6.6-10.8 6.6c-12.6 10.1-20.2 7.6-27.7 22.7l25.2-2.5c5 17.6-12.6 20.1-25.2 27.7l-20.2 12.6c5 17.6 20.2 7.5 32.8 2.5l2.5 2.5v5L270 282s-29.8 17-30.3 17.6c-.2 1 0 5 0 5 10.1 2.6 25.2 5.1 35.3 0 12.6-5 15.2-10 30.3-10a97 97 0 0 1-50.5 20.2v10c15.2 0 25.3 0 37.9-2.5l32.8-10c7.5 0 15.1 7.5 12.6 15-7.6 27.7-37.8 22.7-48 45.4l40.4-15.1c10.1-5 20.2-10.1 32.8-7.6 15.1 5 15.1 15.1 35.3 20.1l-5-12.5c5 2.5 10 2.5 15.1 5 12.6 5 15.1 10 30.3 7.5-12.6-15-15.2-12.5-25.2-22.6-10.1-15.1-15.2-37.8 0-40.3l17.6 5c17.7 2.6 17.7-2.5 42.9 7.6 15.1 5 20.2 12.6 37.8 7.5-7.5-17.6-35.3-30.2-53-35.2 20.2-12.6 15.2 5 43-2.5v-5c-20.2-15.2-27.8-27.8-55.6-27.8l43-5v-5S447 235.7 446 235.3a6 6 0 0 1 4.1-4.4c8 5.2 32.3 4.6 33.7 4.5-.7-6.2-12.2-11.3-22.3-16.3 0 0-43.2-26.7-43.4-29 .8-6.8 17.7 1 35.8 6.3-5-10-15.1-15.1-25.2-17.6l15.1-2.5c-10-22.7-35.3-20.2-50.4-30.3-10.1-7.5-10.1-12.6-25.2-20.1z\"/><path fill=\"#fff\" fill-rule=\"evenodd\" stroke=\"#fff\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3.1\" d=\"M341 293.6c1.9-6 4.3-11.3-6.9-16.4s5.6 20.5 7 16.4zm13.3-12c-2.3.3-3.4 8.6 1 10.8 5.1.8 1-10.7-1-10.8m13.1-.9c-2.3.7-2.4 12.4 5.8 10.3 8.3-2 0-11.2-5.8-10.2zm15.3-29.8c1.8-2.8-.1-14.5-7.2-9.6s5 10.4 7.2 9.6m-15.5-9.7c2.2-.8 2.4-8-3.8-6-6.2 1.8 2.2 7.5 3.8 6m-14 2.9s-4.3-6-7.7-4.8c-4.2 4 8 4.9 7.7 4.8m-48 19.1c1.8.2 15.5-2.2 20.2-7.5 4.8-5.3-24.3 2.2-24.3 2.3s2.7 4.7 4 5.2zm136.7-33.8c.7-1.3-7.3-7-12-4.7-1.2 4.2 12 5.5 12 4.7M415 215.8c1.5-2.1-3.5-11-13.3-6s10.3 9.5 13.3 6m-31.1-5.2s2.4-8 8.4-6.4c6.6 5.1-8.1 6.7-8.4 6.4m-5.8-6c-1-2.2-7.1-.9-14.2 3.8-7.1 4.6 16.3 1.3 14.2-3.8m18-21.4s6.4-2.9 8.3 0c2.6 4.2-8.3 0-8.2 0zm-5.2-2.8c-1.3-2.5-8.3-2.8-8.1 1-1.2 2.8 9 2.3 8-1zm-16.7 0c-.7-1.5-10.6 0-13.6 6 4.8 2.3 15.8-2.2 13.6-6m-21.3 6.1s-13 8-13.9 13.9c.4 5 16.3-9.2 16.3-9.2s1.4-5.6-2.4-4.7m-14.5-7.3c.4-1.6 6.5-5.4 7-5 .5 1.6-5 6-7 5m4.2 30.6c.3-2.3-15.6-2.1-9.6 5.1 5 6.1 10.7-4 9.6-5zM328 220.3c-.8-1.6-2-5.9-4.2-6.3-1.7 0-11.3 2-12 3.5-.4 1.3 4 9.2 5.4 9.4 1.7.6 10.5-5.8 10.8-6.6m85.6 53.4c.5-1.7 16.7-7.3 22.3-2 6.6 9-22.7 4.8-22.3 2m44.6 10.6c3.5-6-11-13.2-17-6.3 2 8.2 14.1 11.2 17 6.3\"/></g></svg>","eg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#ce1126\" d=\"M0 0h512v171H0z\"/><path fill=\"#fff\" d=\"M0 171h512v170H0z\"/><path d=\"M0 341h512v171H0z\"/><circle cx=\"256\" cy=\"256\" r=\"50\" fill=\"#c09300\"/></svg>","ma":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#c1272d\" d=\"M512 0H0v512h512z\"/><path fill=\"none\" stroke=\"#006233\" stroke-width=\"12.5\" d=\"m256 191.4-38 116.8 99.4-72.2H194.6l99.3 72.2z\"/></svg>","tn":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#e70013\" d=\"M0 0h512v512H0z\"/><path fill=\"#fff\" d=\"M256 135a1 1 0 0 0-1 240 1 1 0 0 0 0-241zm72 174a90 90 0 1 1 0-107 72 72 0 1 0 0 107m-4.7-21.7-37.4-12.1-23.1 31.8v-39.3l-37.3-12.2 37.3-12.2v-39.4l23.1 31.9 37.4-12.1-23.1 31.8z\"/></svg>","dz":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#fff\" d=\"M256 0h256v512H256z\"/><path fill=\"#006233\" d=\"M0 0h256v512H0z\"/><path fill=\"#d21034\" d=\"M367 192a128 128 0 1 0 0 128 102.4 102.4 0 1 1 0-128m4.2 64L256 218.4l71.7 98.2V195.4L256 293.6z\"/></svg>","ng":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><g fill-rule=\"evenodd\" stroke-width=\"1pt\"><path fill=\"#fff\" d=\"M0 0h512v512H0z\"/><path fill=\"#008753\" d=\"M341.3 0H512v512H341.3zM0 0h170.7v512H0z\"/></g></svg>","ke":"<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><defs><path id=\"a\" stroke-miterlimit=\"10\" d=\"m-28.6 47.5 1.8 1 46.7-81c2.7-.6 4.2-3.2 5.7-5.8 1-1.8 5-8.7 6.7-17.7a58 58 0 0 0-11.9 14.7c-1.5 2.6-3 5.2-2.3 7.9z\"/></defs><path fill=\"#fff\" d=\"M0 0h512v512H0z\"/><path fill=\"#000001\" d=\"M0 0h512v153.6H0z\"/><path fill=\"#060\" d=\"M0 358.4h512V512H0z\"/><g id=\"b\" transform=\"matrix(3.2 0 0 3.2 255.8 256)\"><use xlink:href=\"#a\" width=\"100%\" height=\"100%\" stroke=\"#000\"/><use xlink:href=\"#a\" width=\"100%\" height=\"100%\" fill=\"#fff\"/></g><use xlink:href=\"#b\" width=\"100%\" height=\"100%\" transform=\"matrix(-1 0 0 1 511.7 0)\"/><path fill=\"#b00\" d=\"M255.8 102.4c-19.2 0-51.2 51.2-60.8 76.8H0v153.6h195c9.7 25.6 41.7 76.8 60.9 76.8s51.2-51.2 60.8-76.8H512V179.2H316.6c-9.6-25.6-41.6-76.8-60.8-76.8\"/><path id=\"c\" d=\"M316.6 332.8a220 220 0 0 0 16-76.8 220 220 0 0 0-16-76.8 220 220 0 0 0-16 76.8 220 220 0 0 0 16 76.8\"/><use xlink:href=\"#c\" width=\"100%\" height=\"100%\" transform=\"matrix(-1 0 0 1 511.7 0)\"/><g fill=\"#fff\" transform=\"matrix(3.2 0 0 3.2 255.8 256)\"><ellipse rx=\"4\" ry=\"6\"/><path id=\"d\" d=\"M1 5.8s4 8 4 21-4 21-4 21z\"/><use xlink:href=\"#d\" width=\"100%\" height=\"100%\" transform=\"scale(-1)\"/><use xlink:href=\"#d\" width=\"100%\" height=\"100%\" transform=\"scale(-1 1)\"/><use xlink:href=\"#d\" width=\"100%\" height=\"100%\" transform=\"scale(1 -1)\"/></g></svg>","ye":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><g fill-rule=\"evenodd\" stroke-width=\"1pt\"><path fill=\"#fff\" d=\"M0 0h512v504.3H0z\"/><path fill=\"#f10600\" d=\"M0 0h512v167.9H0z\"/><path fill=\"#000001\" d=\"M0 344.1h512V512H0z\"/></g></svg>","ir":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#239f40\" d=\"M0 0h512v171H0z\"/><path fill=\"#fff\" d=\"M0 171h512v170H0z\"/><path fill=\"#da0000\" d=\"M0 341h512v171H0z\"/><circle cx=\"256\" cy=\"256\" r=\"48\" fill=\"none\" stroke=\"#da0000\" stroke-width=\"18\"/><path fill=\"#da0000\" d=\"M248 196h16v120h-16z\"/></svg>","il":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><defs><clipPath id=\"a\"><path fill-opacity=\".7\" d=\"M0 0h512v512H0z\"/></clipPath></defs><g fill-rule=\"evenodd\" clip-path=\"url(#a)\"><path fill=\"#fff\" d=\"M619.4 512H-112V0h731.4z\"/><path fill=\"#0038b8\" d=\"M619.4 115.2H-112V48h731.4zm0 350.5H-112v-67.2h731.4zm-483-275 110.1 191.6L359 191.6z\"/><path fill=\"#fff\" d=\"m225.8 317.8 20.9 35.5 21.4-35.3z\"/><path fill=\"#0038b8\" d=\"M136 320.6 246.2 129l112.4 190.8z\"/><path fill=\"#fff\" d=\"m225.8 191.6 20.9-35.5 21.4 35.4zM182 271.1l-21.7 36 41-.1-19.3-36zm-21.3-66.5 41.2.3-19.8 36.3zm151.2 67 20.9 35.5-41.7-.5zm20.5-67-41.2.3 19.8 36.3zm-114.3 0L189.7 256l28.8 50.3 52.8 1.2 32-51.5-29.6-52z\"/></g></svg>","kz":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#00afca\" d=\"M0 0h512v512H0z\"/><circle cx=\"256\" cy=\"230\" r=\"80\" fill=\"#fec50c\"/><path fill=\"#fec50c\" d=\"M176 340h160q-80 40-160 0zM40 60h26v390H40z\"/></svg>","ge":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#fff\" d=\"M0 0h512v512H0z\"/><path fill=\"red\" d=\"M205 0h102v512H205z\"/><path fill=\"red\" d=\"M0 205h512v102H0z\"/><path fill=\"red\" fill-rule=\"evenodd\" d=\"M114.1 397.9c1.1-18 4.3-33.4 4.3-33.4s-10.6 1-15.9 1-15.9-1-15.9-1 3.2 15.3 4.3 33.4c-18-1.1-33.4-4.3-33.4-4.3s1 8 1 15.9-1 15.9-1 15.9 15.3-3.2 33.4-4.3c-1.1 18-4.3 33.4-4.3 33.4s8-1 15.9-1 15.9 1 15.9 1-3.2-15.3-4.3-33.4c18 1.1 33.4 4.3 33.4 4.3s-1-10.6-1-15.9 1-15.9 1-15.9-15.3 3.2-33.4 4.3m307-307c1.1-18 4.3-33.4 4.3-33.4s-10.6 1-15.9 1-15.9-1-15.9-1 3.2 15.4 4.3 33.4c-18-1.1-33.4-4.3-33.4-4.3s1 8 1 15.9-1 15.9-1 15.9 15.3-3.2 33.4-4.3c-1.1 18-4.3 33.4-4.3 33.4s8-1 15.9-1 15.9 1 15.9 1-3.2-15.3-4.3-33.4c18 1.1 33.4 4.3 33.4 4.3s-1-10.6-1-15.9c0-5.2 1-15.9 1-15.9s-15.4 3.2-33.4 4.3m-307 0c1.1-18 4.3-33.4 4.3-33.4s-10.6 1-15.9 1-15.9-1-15.9-1 3.2 15.4 4.3 33.4c-18-1.1-33.4-4.3-33.4-4.3s1 8 1 15.9-1 15.9-1 15.9 15.3-3.2 33.4-4.3c-1.1 18-4.3 33.4-4.3 33.4s8-1 15.9-1 15.9 1 15.9 1-3.2-15.3-4.3-33.4c18 1.1 33.4 4.3 33.4 4.3s-1-10.6-1-15.9c0-5.2 1-15.9 1-15.9s-15.3 3.2-33.4 4.3m307 307c1.1-18 4.3-33.4 4.3-33.4s-10.6 1-15.9 1-15.9-1-15.9-1 3.2 15.3 4.3 33.4c-18-1.1-33.4-4.3-33.4-4.3s1 8 1 15.9-1 15.9-1 15.9 15.3-3.2 33.4-4.3c-1.1 18-4.3 33.4-4.3 33.4s8-1 15.9-1 15.9 1 15.9 1-3.2-15.3-4.3-33.4c18 1.1 33.4 4.3 33.4 4.3s-1-10.6-1-15.9 1-15.9 1-15.9-15.4 3.2-33.4 4.3\"/></svg>","ro":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><g fill-rule=\"evenodd\" stroke-width=\"1pt\"><path fill=\"#00319c\" d=\"M0 0h170.7v512H0z\"/><path fill=\"#ffde00\" d=\"M170.7 0h170.6v512H170.7z\"/><path fill=\"#de2110\" d=\"M341.3 0H512v512H341.3z\"/></g></svg>","bg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#fff\" d=\"M0 0h512v170.7H0z\"/><path fill=\"#00966e\" d=\"M0 170.7h512v170.6H0z\"/><path fill=\"#d62612\" d=\"M0 341.3h512V512H0z\"/></svg>","is":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><defs><clipPath id=\"a\"><path fill-opacity=\".7\" d=\"M85.4 0h486v486h-486z\"/></clipPath></defs><g fill-rule=\"evenodd\" stroke-width=\"0\" clip-path=\"url(#a)\" transform=\"translate(-90)scale(1.0535)\"><path fill=\"#003897\" d=\"M0 0h675v486H0z\"/><path fill=\"#fff\" d=\"M0 189h189V0h108v189h378v108H297v189H189V297H0z\"/><path fill=\"#d72828\" d=\"M0 216h216V0h54v216h405v54H270v216h-54V270H0z\"/></g></svg>","tw":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><clipPath id=\"a\"><path d=\"M0 0h512v512H0z\"/></clipPath><g clip-path=\"url(#a)\"><path fill=\"red\" d=\"M0 0h768v512H0z\"/><path fill=\"#000095\" d=\"M0 0h384v256H0z\"/><g fill=\"#fff\"><path d=\"m164.3 135.4-2.7 10.2 10.1 2.7-2-7.4zm50 5.5-2 7.4 10.1-2.7-2.7-10.2zm-44.6-25.8-5.4 5.5 2 7.4z\"/><path d=\"m166.3 128-2 7.4 5.4 5.5z\"/><path d=\"m164.3 120.6-7.4 7.4 7.4 7.4 2-7.4zm14.8 29.7 5.5 5.4 7.4-2zm20.3 5.4 10.2 2.7 2.7-10.1-7.4 2z\"/><path d=\"m204.9 150.3 7.4-2 2-7.4zm-33.2-2 2.7 10.1 10.2-2.7-5.5-5.4zm20.3 5.4 7.4 2 5.5-5.4z\"/><path d=\"m184.6 155.7 7.4 7.4 7.4-7.4-7.4-2zm-12.9-48-10.1 2.7 2.7 10.2 5.4-5.5zm-2 33.2 2 7.4 7.4 2zm48-12.9 2-7.4-5.4-5.5z\"/><path d=\"m179.1 105.7-7.4 2-2 7.4zm35.2 9.4-2-7.4-7.4-2zm5.4 20.3 7.4-7.4-7.4-7.4-2 7.4z\"/><path d=\"m214.3 115.1-9.4-9.4-12.9-3.4-12.9 3.4-9.4 9.4-3.4 12.9 3.4 12.9 9.4 9.4 12.9 3.4 12.9-3.4 9.4-9.4 3.4-12.9z\"/><path d=\"m214.3 140.9 5.4-5.5-2-7.4zm5.4-20.3 2.7-10.2-10.1-2.7 2 7.4zm-7.4-12.9-2.7-10.1-10.2 2.7 5.5 5.4zm-27.7-7.4-10.2-2.7-2.7 10.1 7.4-2z\"/><path d=\"m192 102.3-7.4-2-5.5 5.4z\"/><path d=\"m199.4 100.3-7.4-7.4-7.4 7.4 7.4 2z\"/><path d=\"m204.9 105.7-5.5-5.4-7.4 2zm-20.3 50-10.2 2.7 4.7 17.6 12.9-12.9zm-5.5 20.3 12.9 48 12.9-48-12.9-12.9zm-7.4-27.7-10.1-2.7-4.7 17.5 17.5-4.7z\"/><path d=\"m156.9 163.1-12.9 48 35.1-35.1-4.7-17.6zM144 140.9 108.9 176l48-12.9 4.7-17.5z\"/><path d=\"m164.3 135.4-7.4-7.4-12.9 12.9 17.6 4.7zm0-14.8-2.7-10.2-17.6 4.7 12.9 12.9z\"/><path d=\"M144 115.1 96 128l48 12.9 12.9-12.9zm96 25.8-17.6 4.7 4.7 17.5 48 12.9z\"/><path d=\"m212.3 148.3-2.7 10.1 17.5 4.7-4.7-17.5zm-12.9 7.4-7.4 7.4 12.9 12.9 4.7-17.6zm20.3-20.3 2.7 10.2 17.6-4.7-12.9-12.9zM204.9 176l35.1 35.1-12.9-48-17.5-4.7zm7.4-68.3 10.1 2.7 4.7-17.5-17.5 4.7zm27.7 7.4L275.1 80l-48 12.9-4.7 17.5zm-12.9-22.2 12.9-48L204.9 80l4.7 17.6zm12.9 48 48-12.9-48-12.9-12.9 12.9z\"/><path d=\"m219.7 120.6 7.4 7.4 12.9-12.9-17.6-4.7zM179.1 80 144 44.9l12.9 48 17.5 4.7zm-7.4 27.7 2.7-10.1-17.5-4.7 4.7 17.5z\"/><path d=\"m156.9 92.9-48-12.9 35.1 35.1 17.6-4.7zm42.5 7.4 10.2-2.7-4.7-17.6L192 92.9z\"/><path d=\"M204.9 80 192 32l-12.9 48L192 92.9z\"/><path d=\"m184.6 100.3 7.4-7.4L179.1 80l-4.7 17.6z\"/></g><circle cx=\"192\" cy=\"128\" r=\"54.4\" fill=\"#000095\"/><circle cx=\"192\" cy=\"128\" r=\"48\" fill=\"#fff\"/></g></svg>","pe":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#D91023\" d=\"M0 0h512v512H0z\"/><path fill=\"#fff\" d=\"M170.7 0h170.6v512H170.7z\"/></svg>","uz":"<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><path fill=\"#1eb53a\" d=\"M0 341.3h512V512H0z\"/><path fill=\"#0099b5\" d=\"M0 0h512v170.7H0z\"/><path fill=\"#ce1126\" d=\"M0 163.8h512v184.4H0z\"/><path fill=\"#fff\" d=\"M0 174h512v164H0z\"/><circle cx=\"143.4\" cy=\"81.9\" r=\"61.4\" fill=\"#fff\"/><circle cx=\"163.8\" cy=\"81.9\" r=\"61.4\" fill=\"#0099b5\"/><g fill=\"#fff\" transform=\"translate(278.5 131)scale(2.048)\"><g id=\"e\"><g id=\"d\"><g id=\"c\"><g id=\"b\"><path id=\"a\" d=\"M0-6-1.9-.3 1 .7\"/><use xlink:href=\"#a\" width=\"100%\" height=\"100%\" transform=\"scale(-1 1)\"/></g><use xlink:href=\"#b\" width=\"100%\" height=\"100%\" transform=\"rotate(72)\"/></g><use xlink:href=\"#b\" width=\"100%\" height=\"100%\" transform=\"rotate(-72)\"/><use xlink:href=\"#c\" width=\"100%\" height=\"100%\" transform=\"rotate(144)\"/></g><use xlink:href=\"#d\" width=\"100%\" height=\"100%\" y=\"-24\"/><use xlink:href=\"#d\" width=\"100%\" height=\"100%\" y=\"-48\"/></g><use xlink:href=\"#e\" width=\"100%\" height=\"100%\" x=\"24\"/><use xlink:href=\"#e\" width=\"100%\" height=\"100%\" x=\"48\"/><use xlink:href=\"#d\" width=\"100%\" height=\"100%\" x=\"-48\"/><use xlink:href=\"#d\" width=\"100%\" height=\"100%\" x=\"-24\"/><use xlink:href=\"#d\" width=\"100%\" height=\"100%\" x=\"-24\" y=\"-24\"/></g></svg>","az":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#3f9c35\" d=\"M0 0h512v512H0z\"/><path fill=\"#ed2939\" d=\"M0 0h512v341.3H0z\"/><path fill=\"#00b9e4\" d=\"M0 0h512v170.7H0z\"/><circle cx=\"238.8\" cy=\"256\" r=\"76.8\" fill=\"#fff\"/><circle cx=\"255.9\" cy=\"256\" r=\"64\" fill=\"#ed2939\"/><path fill=\"#fff\" d=\"m324.2 213.3 8.1 23 22-10.5-10.4 22 23 8.2-23 8.2 10.4 22-22-10.5-8.1 23-8.2-23-22 10.5 10.5-22-23-8.2 23-8.2-10.5-22 22 10.5z\"/></svg>","by":"<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" xml:space=\"preserve\" viewBox=\"0 0 512 512\"><defs><clipPath id=\"a\"><path d=\"M0 0h200v608h8v284l-8 8H0Z\"/></clipPath></defs><path fill=\"#ce1720\" d=\"M0 0h512v512H0Z\"/><g fill=\"#fff\" clip-path=\"url(#a)\" transform=\"matrix(.5625 0 0 .56889 5 0)\"><g id=\"c\"><path id=\"b\" d=\"M36 0v14h-9v14H16v16H8v13H-8V24H8V6H-8V0Zm26 77v15h-8v12h-8V92h-8V77h-8V57h8V42h8V30h8v12h8v15h8v20Zm-17-1h10V58H45ZM19 183h8v-18h-8zm54 0h8v-18h-8ZM-8 305H6v13h6v16h9v15h12v-15h9v-16h8v-13H38v-15h21v10h13v17h11v19h-8v14h-7v13h-6v14h-9v12h-7v11h-9v14H24v-15h-9v-14H8v-9H-8v-23H8v-20H-8Z\"/><use xlink:href=\"#b\" transform=\"matrix(-1 0 0 1 200 0)\"/><path d=\"M96 0v32h8V0h32v14h-8v14h-12v16h-8v13H92V44h-8V28H72V14h-8V0Zm-2 274v-11h-6v-13h-7v-14h-8v-14h-8v-10h-9v-14H44v14h-9v10h-7v14h-8v14h-6v13H8v17H-8v-44H8v-20H-8v-33H8v14h10v14h10v-14h10v-14h8v-18h-8v-14H28v-14H18v14H8v14H-8v-41H8v-19H-8V77H8v13h8v16h11v13h9v15h7v12h14v-12h7v-15h9v-13h11V90h8V77h16v13h8v16h11v13h9v15h7v12h14v-12h7v-15h9v-13h11V90h8V77h16v28h-16v19h16v41h-16v-14h-10v-14h-10v14h-10v14h-8v18h8v14h10v14h10v-14h10v-14h16v33h-16v20h16v44h-16v-17h-6v-13h-6v-14h-8v-14h-7v-10h-9v-14h-12v14h-9v10h-8v14h-8v14h-7v13h-6v11zm2-167v27h8v-27zm-4 58v-14H82v-14H72v14H62v14h-8v18h8v14h10v14h10v-14h10v-14h16v14h10v14h10v-14h10v-14h8v-18h-8v-14h-10v-14h-10v14h-10v14zm4 46v27h8v-27z\"/></g><use xlink:href=\"#c\" transform=\"matrix(1 0 0 -1 0 900)\"/><path d=\"M-8 408H8v14h7v8h8v14h7v12h-7v14h-8v8H8v14H-8Zm216 0v84h-16v-14h-7v-8h-8v-14h-7v-12h7v-14h8v-8h7v-14ZM62 459h8v-18h-8zm76 0v-18h-8v18zm-42-59h8v-18h-8zm0 100v18h8v-18Zm-50-75h14v-11h10v-10h5v-10h6v-14h8v-14h4v-13h14v13h4v14h8v14h6v10h5v10h10v11h14v50h-14v11h-10v10h-5v10h-6v14h-8v14h-4v13H93v-13h-4v-14h-8v-14h-6v-10h-5v-10H60v-11H46Zm50 9v-15h-8v-10h-8v25h8v9h5v14h-5v9h-8v25h8v-10h8v-15h8v15h8v10h8v-25h-8v-9h-5v-14h5v-9h8v-25h-8v10h-8v15z\"/></g><path fill=\"#007c30\" d=\"M117.3 341.3h395V512h-395z\"/></svg>","lk":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#ffb700\" d=\"M0 0h512v512H0z\"/><path fill=\"#005f56\" d=\"M32 32h80v448H32z\"/><path fill=\"#ff5b00\" d=\"M128 32h80v448h-80z\"/><path fill=\"#8d2029\" d=\"M224 32h256v448H224z\"/><circle cx=\"352\" cy=\"256\" r=\"60\" fill=\"#ffb700\"/></svg>","np":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><defs><clipPath id=\"b\"><path fill-opacity=\".7\" d=\"M0-16h512v512H0z\"/></clipPath><clipPath id=\"a\"><path fill-opacity=\".7\" d=\"M0 0h512v512H0z\"/></clipPath></defs><g clip-path=\"url(#a)\"><g clip-path=\"url(#b)\" transform=\"translate(0 16)\"><g fill-rule=\"evenodd\"><path fill=\"#ce0000\" stroke=\"#000063\" stroke-width=\"13\" d=\"M6.5 489.5h378.8L137.4 238.1l257.3.3L6.6-9.5v499z\"/><path fill=\"#fff\" d=\"m180.7 355.8-27 9 21.2 19.8-28.5-1.8 11.7 26.2-25.5-12.3.5 28.6-18.8-20.9-10.7 26.6-9.2-26.3-20.3 20.6 1.8-27.7L49 409l12.6-25-29.3.6 21.5-18.3-27.3-10.5 27-9L32.2 327l28.4 1.8L49 302.6l25.6 12.3-.5-28.6 18.8 20.9 10.7-26.6 9.1 26.3 20.4-20.6-1.9 27.7 27-11.4-12.7 25 29.4-.6-21.5 18.3zm-32.4-184.7-11.3 8.4 5.6 4.6a94 94 0 0 0 30.7-36c1.8 21.3-17.7 69-68.7 69.5a70.6 70.6 0 0 1-71.5-70.3c10 18.2 16.2 27 32 36.5l4.7-4.4-10.6-8.9 13.7-3.6-7.4-12.4 14.4 1-1.8-14.4 12.6 7.4 4-13.5 9 10.8 8.5-10.3 4.6 14 11.8-8.2-1.5 14.3 14.2-1.7-6.7 13.2z\"/></g></g></g></svg>","gh":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 512 512\"><path fill=\"#006b3f\" d=\"M0 0h512v512H0z\"/><path fill=\"#fcd116\" d=\"M0 0h512v341.3H0z\"/><path fill=\"#ce1126\" d=\"M0 0h512v170.7H0z\"/><path fill=\"#000001\" d=\"m256 170.7 55.5 170.6L166.3 236h179.4L200.6 341.3z\"/></svg>"};
  let flagSeq = 0;
  function flagEl(cur) {
    const d = document.createElement('span');
    d.className = 'pott-flag';
    const svg = FLAG_SVG[CUR_FLAG[cur]];
    if (svg) {
      // У каждой копии флага свои id, чтобы одинаковые флаги в списке не мешали друг другу.
      const n = 'pf' + (++flagSeq) + '_';
      d.innerHTML = svg.replace(/id="([^"]+)"/g, 'id="' + n + '$1"').replace(/url\(#/g, 'url(#' + n).replace(/href="#/g, 'href="#' + n);
    } else {
      d.textContent = cur;
    }
    return d;
  }
  function pairFlags(name) {
    const m = String(name).match(/([A-Z]{3})\/([A-Z]{3})/i);
    const w = document.createElement('span');
    w.className = 'pott-pairs-flags';
    if (m) w.append(flagEl(m[1].toUpperCase()), flagEl(m[2].toUpperCase()));
    return w;
  }
  function renderPairs() {
    const cur = pairKey(state.pair);
    // Только валютные OTC-пары вида «AUD/CAD OTC» (акции и крипта не показываются).
    const items = Array.from(otcAssets.values())
      .filter((a) => /^[A-Z]{3}\/[A-Z]{3}\s*OTC$/i.test(a.name.trim()) && !isGone(a.name))
      .sort((a, b) => (b.payout == null ? -1 : b.payout) - (a.payout == null ? -1 : a.payout) || a.name.localeCompare(b.name));
    pairsList.textContent = '';
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'pott-pairs-empty';
      e.textContent = loadingOtc ? 'Загружаю пары с сайта…' : 'Валютные OTC-пары пока не получены';
      pairsList.appendChild(e);
      return;
    }
    for (const a of items) {
      const b = document.createElement('button');
      b.className = 'pott-pairs-item' + (pairKey(a.name) === cur ? ' pott-on' : '');
      const n = document.createElement('span');
      n.className = 'pott-pairs-name';
      n.textContent = a.name;
      const pay = document.createElement('span');
      pay.className = 'pott-pairs-pay ' + (a.payout == null ? 'pott-lo' : a.payout >= 85 ? 'pott-hi' : a.payout >= 70 ? 'pott-mid' : 'pott-lo');
      pay.textContent = a.payout == null ? '—' : a.payout + '%';
      b.append(pairFlags(a.name), n, pay);
      b.addEventListener('click', () => choosePair(a.name));
      pairsList.appendChild(b);
    }
  }
  window.addEventListener('keydown', (e) => { if (e.isTrusted && e.key === 'Escape' && !pairsPop.hidden) togglePairs(false); });

  function placePairs() {
    if (pairsPop.hidden) return;
    const r = els.pair.getBoundingClientRect();
    const w = pairsPop.offsetWidth || 232;
    let left = Math.round(r.left + r.width / 2 - w / 2);
    left = Math.min(window.innerWidth - w - 8, Math.max(8, left));
    let top = Math.round(r.bottom + 6);
    const h = pairsPop.offsetHeight || 320;
    if (top + h > window.innerHeight - 8) top = Math.max(8, Math.round(r.top - 6 - h)); // не влезает вниз - открываем вверх
    pairsPop.style.left = left + 'px';
    pairsPop.style.top = top + 'px';
  }
  function togglePairs(force) {
    const open = typeof force === 'boolean' ? force : pairsPop.hidden;
    pairsPop.hidden = !open;
    els.pair.classList.toggle('pott-open', open);
    if (open) {
      pairsStatus.textContent = '';
      pairsStatus.className = '';
      renderPairs();
      placePairs();
      // Меню пар на сайте виджет открывает сам, только если списка ещё нет совсем.
      // Проценты обновляются из потока данных сайта и по текущей паре - без открытия меню.
      if (!otcAssets.size) loadOtcFromSite();
    } else if (drawerOpener && !switching) {
      const op = drawerOpener;
      drawerOpener = null;
      closeSiteDrawer(op);
    }
  }
  let drawerOpener = null; // кнопка, которой виджет сам открыл меню пар на сайте

  // --- Чтение OTC-пар с процентами из меню выбора актива на сайте ---
  let loadingOtc = false;
  function scrapeSiteOtc() {
    const rows = [], seen = new Set();
    for (const el of document.querySelectorAll('li, a, [class*="item"], [class*="link"]')) {
      if (ownWidget(el) || !siteVisible(el)) continue;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 50) continue;
      const m = t.match(/^(.{2,30}?\bOTC)\b\s*\+?(\d{1,3})\s*%/i);
      if (!m) continue;
      const k = assetKey(m[1]);
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push([m[1].replace(/\s*otc$/i, ' OTC'), +m[2]]);
    }
    return rows;
  }
  async function loadOtcFromSite() {
    if (loadingOtc || switching) return;
    loadingOtc = true;
    renderPairs();
    let opened = null;
    try {
      let rows = scrapeSiteOtc();
      if (rows.length < 3) {
        opened = findPairOpener();
        if (opened) {
          realClick(opened);
          await waitFor(() => scrapeSiteOtc().length >= 3, 2000);
          await sleep(300);
          rows = scrapeSiteOtc();
        }
      }
      if (rows.length) { unmarkGone(rows); storeOtc(rows, true); }
    } finally {
      if (opened && findSiteSearch()) {
        realClick(opened);
      }
      loadingOtc = false;
      if (!pairsPop.hidden) renderPairs();
    }
  }

  // --- Переключение пары на сайте ---
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  async function waitFor(fn, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(80);
    }
    return null;
  }
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => {
      const E = t.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      const o = Object.assign({}, base, { buttons: /down/.test(t) ? 1 : 0 });
      if (t.startsWith('pointer')) Object.assign(o, { pointerId: 1, pointerType: 'mouse', isPrimary: true });
      el.dispatchEvent(new E(t, o));
    });
  }
  // «Касание пальцем» - для мобильной версии сайта (m.pocketoption.com).
  function realTap(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    try {
      const t = new Touch({ identifier: Date.now(), target: el, clientX: x, clientY: y, pageX: x + window.scrollX, pageY: y + window.scrollY });
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t] }));
      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t] }));
    } catch (e) {}
    const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    if (window.PointerEvent) {
      el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, base, { pointerId: 2, pointerType: 'touch', isPrimary: true, buttons: 1 })));
      el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, base, { pointerId: 2, pointerType: 'touch', isPrimary: true, buttons: 0 })));
    }
    el.dispatchEvent(new MouseEvent('click', base));
  }
  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
  }
  function siteVisible(el) {
    if (ownWidget(el)) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.05;
  }
  function findPairOpener() {
    for (const sel of PAIR_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (!siteVisible(el)) continue;
        if (/[A-Za-z]{3}/.test(el.textContent || '')) return el.closest('a, button, [role="button"]') || el;
      }
    }
    return null;
  }
  function findSiteSearch() {
    const inputs = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])');
    for (const i of inputs) {
      if (!siteVisible(i)) continue;
      const hint = ((i.placeholder || '') + ' ' + (i.name || '') + ' ' + (i.className || '')).toLowerCase();
      if (/search|поиск|find|asset|актив/.test(hint)) return i;
    }
    return null;
  }
  // Пункт списка на сайте: текст совпадает с парой (проценты выплаты в конце не мешают).
  function findSiteItem(target) {
    const k = pairKey(target);
    let best = null, bestLen = Infinity;
    for (const el of document.querySelectorAll('a, li, button, div, span')) {
      const t = (el.textContent || '').trim();
      if (!t || t.length > 40) continue;
      const tk = pairKey(t).replace(/\d+$/, '');
      if (tk !== k || !siteVisible(el)) continue;
      if (t.length < bestLen) { best = el; bestLen = t.length; }
    }
    return best ? (best.closest('a, li, button, [role="button"], [class*="item"], [class*="link"]') || best) : null;
  }
  // Закрыть панель выбора актива на сайте: очистить поиск, Esc, повторное нажатие
  // на кнопку пары, и в крайнем случае - клик в пустое место.
  async function closeSiteDrawer(opener) {
    const open = () => !!findSiteSearch();
    if (!open()) return;
    const search = findSiteSearch();
    try { setNativeValue(search, ''); } catch (e) {}
    const esc = { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape', keyCode: 27, which: 27 };
    search.dispatchEvent(new KeyboardEvent('keydown', esc));
    document.dispatchEvent(new KeyboardEvent('keydown', esc));
    if (search.blur) search.blur();
    await sleep(200);
    if (open()) {
      const btn = opener && opener.isConnected ? opener : findPairOpener();
      if (btn) { realClick(btn); await sleep(250); }
    }
    if (open()) {
      const y = Math.round(window.innerHeight * 0.6), x = Math.round(window.innerWidth * 0.6);
      let t = document.elementFromPoint(x, y) || document.body;
      if (ownWidget(t)) t = document.body;
      const o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((n) => {
        const E = n.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
        t.dispatchEvent(new E(n, o));
      });
      await sleep(200);
    }
  }
  let switching = false;
  async function choosePair(target) {
    if (switching) return;
    if (pairKey(target) === pairKey(state.pair)) { togglePairs(false); return; }
    switching = true;
    const wasSelect = selectMode, wasDraw = drawMode;
    setSelectMode(false); setDrawMode(false);
    pairsStatus.className = '';
    pairsStatus.textContent = 'Переключаю на ' + target + '…';
    let openedBy = drawerOpener; // меню сайта мог открыть сам виджет вместе со списком
    drawerOpener = null;
    const drawerWasOpen = !!findSiteSearch() && !openedBy;
    try {
      let item = findSiteItem(target);
      if (!item) {
        const opener = findPairOpener();
        if (!opener) throw new Error('Не нашёл на сайте кнопку выбора пары');
        realClick(opener);
        openedBy = opener;
        const search = await waitFor(findSiteSearch, 1500);
        if (search) {
          search.focus();
          setNativeValue(search, target.replace(/\s*OTC$/i, ''));
        }
        item = await waitFor(() => findSiteItem(target), 2500);
      }
      if (!item) {
        markGone(target);
        renderPairs();
        const e = new Error('Пары ' + target + ' сейчас нет на сайте - убрал её из списка');
        e.gone = true;
        throw e;
      }
      realClick(item);
      const ok = await waitFor(() => pairKey(detectPair()) === pairKey(target), 2500);
      if (!ok) throw new Error('Сайт не переключил пару');
      state.pair = detectPair() || target;
      saveState(state);
      render();
      togglePairs(false); // список закрываем сразу
      // В полной версии сайта панель выбора актива сама не закрывается - закрываем.
      if (!drawerWasOpen) await closeSiteDrawer(openedBy);
      // Сверяем процент на сайте с тем, что был в списке (уже в фоне).
      // Если упал - снова показываем список с предупреждением.
      const listed = (otcAssets.get(assetKey(target)) || {}).payout;
      waitFor(sitePayout, 1500).then((real) => {
        if (real == null || pairKey(state.pair) !== pairKey(target)) return;
        storeOtc([[target, real]], false);
        if (listed != null && real < listed) {
          togglePairs(true);
          pairsStatus.className = 'pott-err';
          pairsStatus.textContent = target + ': процент упал, было ' + listed + '%, сейчас ' + real + '%';
        }
      });
    } catch (err) {
      // Если это виджет открыл выбор актива на сайте - закрываем его обратно.
      if (!drawerWasOpen) await closeSiteDrawer(openedBy);
      pairsStatus.className = 'pott-err';
      pairsStatus.textContent = err.gone ? err.message : err.message + '. Выберите пару на сайте - виджет подхватит её сам.';
    } finally {
      switching = false;
      if (wasSelect) setSelectMode(true);
      if (wasDraw) setDrawMode(true);
    }
  }

  /* ================= ТЕМЫ И ПРОЗРАЧНОСТЬ (окошко под шестерёнкой) =================
     Цвета виджета считаются из одного акцентного цвета темы, поэтому добавить новую
     тему - это одна строка в THEMES. Прозрачность - плавный ползунок 0-90%. */
  const THEMES = [
    { id: 'graphite', name: 'Графит',            a: '#3a3a40' },
    { id: 'purple',   name: 'Фиолетовый',        a: '#a970ff' },
    { id: 'midnight', name: 'Полночь',           a: '#5b9cff' },
    { id: 'ocean',    name: 'Океан',             a: '#2ec5c5' },
    { id: 'emerald',  name: 'Изумруд',           a: '#10b981' },
    { id: 'lime',     name: 'Лайм',              a: '#a3e635' },
    { id: 'gold',     name: 'Золото',            a: '#e6b84a' },
    { id: 'sunset',   name: 'Закат',             a: '#fb923c' },
    { id: 'mocha',    name: 'Мокко (Pantone 2025)', a: '#a47864' },
    { id: 'ruby',     name: 'Рубин',             a: '#f43f5e' },
    { id: 'fuchsia',  name: 'Фуксия',            a: '#e879f9' },
    { id: 'ice',      name: 'Лёд',               a: '#7dd3fc' },
  ];
  function themeVars(t) {
    if (t.id === 'graphite') {
      return {
        '--pt-bg': '#0e0e10', '--pt-card': '#151517', '--pt-line': 'rgba(255,255,255,0.07)',
        '--pt-edge': 'rgba(255,255,255,0.08)', '--pt-title': '#f2f2f2',
        '--pt-divider': 'rgba(255,255,255,0.35)', '--pt-glow': '0 0 0 transparent',
      };
    }
    const a = t.a, mix = (pct, other) => 'color-mix(in srgb, ' + a + ' ' + pct + '%, ' + other + ')';
    return {
      '--pt-bg': mix(9, '#0b0b0e'),
      '--pt-card': mix(13, '#111115'),
      '--pt-line': mix(18, 'transparent'),
      '--pt-edge': mix(32, 'transparent'),
      '--pt-title': mix(12, '#ffffff'),
      '--pt-divider': mix(85, 'transparent'),
      '--pt-glow': '0 0 20px ' + mix(25, 'transparent'),
    };
  }

  // Прозрачность: число 0-90 (%). Со старых версий переносим 50% / 75%.
  if (typeof state.transp !== 'number') {
    state.transp = state.alpha === '75' ? 75 : state.alpha === '50' ? 50 : 0;
  }

  const settings = document.createElement('div');
  settings.id = 'pott-settings';
  settings.hidden = true;
  settings.innerHTML = `
    <div class="pott-set-head"><span>ЦВЕТ</span><span id="pott-set-name"></span></div>
    <div id="pott-set-colors"></div>
    <div class="pott-set-sep"></div>
    <div class="pott-set-head"><span>ПРОЗРАЧНОСТЬ</span><span id="pott-set-alpha-val"></span></div>
    <input type="range" id="pott-set-alpha" min="0" max="90" step="5">
    <div class="pott-set-scale"><span>0%</span><span>90%</span></div>
    <div class="pott-set-sep pott-mg-part"></div>
    <div class="pott-set-head pott-mg-part"><span>ДОГОН</span><label class="pott-switch" title="Включить / выключить"><input type="checkbox" id="pott-mg-on"><i></i></label></div>
    <div id="pott-mg-body" class="pott-mg-part">
      <div class="pott-mg-row"><span>Начальная ставка</span><input id="pott-mg-base" inputmode="decimal" autocomplete="off"></div>
      <div class="pott-mg-row"><span>Ставок в серии</span><input id="pott-mg-steps" inputmode="numeric" autocomplete="off"></div>
      <div class="pott-mg-row"><span>Множитель</span><input id="pott-mg-k" inputmode="decimal" autocomplete="off" title="Во сколько раз увеличивать ставку после проигрыша"></div>
      <label class="pott-mg-check" title="WIN - серия закончилась выигрышем, LOSE - вся серия в минус"><input type="checkbox" id="pott-mg-count"> Отмечать WIN / LOSE за серию</label>
      <div id="pott-mg-status"></div>
    </div>`;
  if (CLIENT) settings.querySelectorAll('.pott-mg-part').forEach((el) => { el.style.display = 'none'; });
  document.documentElement.appendChild(settings);
  // Нажатия клавиш внутри окошка не уходят на сайт (чтобы не срабатывали его горячие клавиши),
  // поэтому Esc здесь обрабатываем сами.
  settings.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleSettings(false); });
  ['mousedown', 'click', 'pointerdown', 'touchstart', 'wheel', 'keydown', 'keyup', 'keypress'].forEach((type) => {
    settings.addEventListener(type, (e) => e.stopPropagation());
  });
  const setColors = settings.querySelector('#pott-set-colors');
  const setName = settings.querySelector('#pott-set-name');
  const setAlpha = settings.querySelector('#pott-set-alpha');
  const setAlphaVal = settings.querySelector('#pott-set-alpha-val');
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.className = 'pott-sw';
    b.dataset.theme = t.id;
    b.title = t.name;
    b.style.background = t.id === 'graphite'
      ? 'linear-gradient(135deg, #4a4a52, #0e0e10)'
      : 'linear-gradient(135deg, ' + t.a + ' 0%, ' + t.a + ' 45%, color-mix(in srgb, ' + t.a + ' 25%, #0b0b0e) 100%)';
    b.addEventListener('click', () => { state.theme = t.id; saveState(state); applyTheme(); });
    setColors.appendChild(b);
  }
  setAlpha.addEventListener('input', () => { state.transp = +setAlpha.value; applyTheme(); });
  setAlpha.addEventListener('change', () => saveState(state));

  function applyTheme() {
    let t = THEMES.find((x) => x.id === state.theme);
    if (!t) { t = THEMES[0]; state.theme = t.id; }
    const vars = themeVars(t);
    for (const k in vars) box.style.setProperty(k, vars[k]);
    const tr = Math.min(90, Math.max(0, Math.round(state.transp || 0)));
    state.transp = tr;
    box.style.setProperty('--pt-alpha', String(1 - tr / 100));
    if (tr > 0) box.setAttribute('data-alpha', tr); else box.removeAttribute('data-alpha');
    setColors.querySelectorAll('.pott-sw').forEach((b) => b.classList.toggle('pott-on', b.dataset.theme === t.id));
    setName.textContent = t.name;
    setAlpha.value = tr;
    setAlphaVal.textContent = tr + '%';
  }
  applyTheme();

  // Окошко открывается под шестерёнкой (кнопка шестерёнки создаётся ниже, в блоке шапки).
  let gearEl = null;
  function settingsOpen() { return !settings.hidden; }
  function placeSettings() {
    if (settings.hidden || !gearEl) return;
    const g = gearEl.getBoundingClientRect();
    const w = settings.offsetWidth || 232;
    const left = Math.min(window.innerWidth - w - 8, Math.max(8, Math.round(g.right - w)));
    settings.style.left = left + 'px';
    settings.style.top = Math.round(g.bottom + 8) + 'px';
  }
  function toggleSettings(force) {
    settings.hidden = typeof force === 'boolean' ? !force : !settings.hidden;
    placeSettings();
  }
  // Закрывается кликом мимо окошка и клавишей Esc.
  window.addEventListener('mousedown', (e) => {
    if (settings.hidden || !e.isTrusted) return;
    if (settings.contains(e.target) || (gearEl && gearEl.contains(e.target))) return;
    toggleSettings(false);
  }, true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !settings.hidden) toggleSettings(false); });

  // Настройки (цвет и прозрачность) открываются шестерёнкой в шапке сайта.
  // Клик по паре - список пар (см. «ВЫБОР ПАРЫ» ниже).

  /* ================= БАЛАНС СЕССИИ =================
     Старт запоминается при первом найденном балансе (или по кнопке сброса),
     "Сейчас" читается с сайта каждую секунду, итог = сейчас − старт. */
  const BALANCE_SELECTORS = [
    '.balance-info-block__balance',
    '.balance-info-block__value',
    '.js-balance-demo',
    '.js-balance-real-USD',
    '[class*="js-balance"]',
    '[class*="balance-info"] [class*="balance"]',
    '[class*="balance__value"]',
    '[class*="balance-value"]',
  ];
  const MONEY_REGEX = /([$€₽£₴₸])?\s*(\d[\d\s ,.]*\d|\d)\s*([$€₽£₴₸])?/;

  function parseMoney(text) {
    if (!text) return null;
    const m = text.replace(/ /g, ' ').match(MONEY_REGEX);
    if (!m) return null;
    let num = m[2].replace(/\s/g, '');
    if (num.includes(',') && num.includes('.')) num = num.replace(/,/g, '');
    else if (num.includes(',')) num = /,\d{1,2}$/.test(num) ? num.replace(',', '.') : num.replace(/,/g, '');
    const value = parseFloat(num);
    if (!isFinite(value)) return null;
    return { value, cur: m[1] || m[3] || '$' };
  }
  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function detectBalance() {
    for (const sel of BALANCE_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (ownWidget(el) || !isVisible(el)) continue;
        const t = (el.textContent || '').trim();
        if (!t || t.length > 30) continue;
        const res = parseMoney(t);
        if (res) return res;
      }
    }
    return null;
  }
  function fmtMoney(v) {
    return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  const balEls = {
    card: box.querySelector('#pott-balance-card'),
    start: box.querySelector('#pott-bal-start'),
    now: box.querySelector('#pott-bal-now'),
    profit: box.querySelector('#pott-bal-profit'),
    total: box.querySelector('#pott-bal-total'),
  };
  if (!state.balance || typeof state.balance !== 'object') state.balance = { start: null, cur: '$' };
  let balanceNow = null;

  /* --- Плавная смена чисел ---
     Вместо скачка число «докручивается» до нового значения: рост - 0,9 с,
     списание при ставке - 0,5 с, с замедлением в конце. Во время прокрутки
     показываются целые, в конце - точное значение с копейками. */
  function makeTween(render) {
    let shown = null, from = 0, target = null, t0 = 0, dur = 0, raf = 0;
    function frame(now) {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      shown = from + (target - from) * e;
      render(p < 1 ? Math.round(shown) : target, target);
      if (p < 1) raf = requestAnimationFrame(frame);
      else { shown = target; raf = 0; }
    }
    return function set(v) {
      if (v == null) { cancelAnimationFrame(raf); raf = 0; shown = null; target = null; render(null, null); return; }
      if (shown == null || document.hidden) { cancelAnimationFrame(raf); raf = 0; shown = target = v; render(v, v); return; }
      if (v === target) return;
      from = shown;
      target = v;
      t0 = performance.now();
      dur = v > from ? 900 : 500;
      if (!raf) raf = requestAnimationFrame(frame);
    };
  }
  function signedMoney(v) {
    return (v > 0 ? '+' : v < 0 ? '−' : '') + fmtMoney(Math.abs(v));
  }
  function signClass(v) {
    return v > 0 ? 'pott-c-win' : v < 0 ? 'pott-c-loss' : '';
  }
  // Подписчики на изменение баланса (плашка «Текущая сессия» в шапке).
  const balanceSubs = [];
  // Большие суммы не должны залезать на соседнюю колонку: уменьшаем шрифт, пока текст не влезет.
  function fitText(el, maxPx, minPx) {
    if (!el || !el.isConnected) return;
    let fs = maxPx;
    el.style.fontSize = fs + 'px';
    if (!el.clientWidth) return; // виджет скрыт - подгоним, когда покажется
    while (el.scrollWidth > el.clientWidth + 0.5 && fs > minPx) {
      fs -= 0.5;
      el.style.fontSize = fs + 'px';
    }
  }
  function fitBalance() {
    // Обе колонки - одним размером (по более длинному числу), чтобы смотрелось ровно.
    fitText(balEls.start, 17, 9);
    fitText(balEls.now, 17, 9);
    const fs = Math.min(parseFloat(balEls.start.style.fontSize) || 17, parseFloat(balEls.now.style.fontSize) || 17);
    balEls.start.style.fontSize = fs + 'px';
    balEls.now.style.fontSize = fs + 'px';
    fitText(balEls.total, 13, 8);
  }
  const tweenNow = makeTween((v) => { balEls.now.textContent = v == null ? '—' : fmtMoney(v); fitBalance(); });
  const tweenProfit = makeTween((v, target) => {
    if (v == null) { balEls.profit.textContent = '—'; balEls.profit.className = ''; return; }
    balEls.profit.textContent = signedMoney(v);
    balEls.profit.className = signClass(v === 0 ? target : v);
  });
  function currentDiff() {
    const b = state.balance || {};
    if (typeof b.start !== 'number' || balanceNow == null) return null;
    return Math.round((balanceNow - b.start) * 100) / 100;
  }
  function renderBalance() {
    const b = state.balance;
    if (!balEls.start.querySelector('input')) {
      balEls.start.textContent = typeof b.start === 'number' ? fmtMoney(b.start) : '—';
      fitBalance();
    }
    tweenNow(balanceNow != null ? balanceNow : null);
    tweenProfit(currentDiff());
    fitBalance();
    balanceSubs.forEach((fn) => fn());
  }

  function updateBalance() {
    const found = detectBalance();
    if (found) {
      balanceNow = found.value;
      if (typeof state.balance.start !== 'number') {
        state.balance.start = found.value;
        state.balance.cur = found.cur;
        saveState(state);
      } else if (state.balance.cur !== found.cur) {
        state.balance.cur = found.cur;
        saveState(state);
      }
    }
    renderBalance();
  }
  updateBalance();
  // Баланс проверяется 4 раза в секунду, чтобы изменение подхватывалось сразу.
  setInterval(updateBalance, 250);

  // Сброс сессии - в два нажатия, чтобы не обнулить случайно.

  // Ручной ввод стартового баланса (двойной клик по значению).
  balEls.start.addEventListener('dblclick', () => {
    if (balEls.start.querySelector('input')) return;
    const input = document.createElement('input');
    input.id = 'pott-bal-start-input';
    input.inputMode = 'decimal';
    input.value = typeof state.balance.start === 'number' ? String(state.balance.start) : '';
    balEls.start.textContent = '';
    balEls.start.appendChild(input);
    input.focus();
    input.select();
    const finish = (commit) => {
      if (commit) {
        const res = parseMoney(input.value);
        if (res) { state.balance.start = res.value; saveState(state); }
      }
      input.remove();
      renderBalance();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  });

  // Скрыть / показать блок «Баланс» - нажатием на часовой пояс возле часов.
  function applyBalanceVisibility() {
    balEls.card.hidden = !!state.balanceHidden || pairCard.hidden;
    els.tz.title = state.balanceHidden ? 'Показать баланс' : 'Скрыть баланс';
    if (state.pos) requestAnimationFrame(clampPosition);
  }
  els.tz.addEventListener('click', () => {
    state.balanceHidden = !state.balanceHidden;
    saveState(state);
    applyBalanceVisibility();
  });
  box._balReady = true;
  applyBalanceVisibility();

  /* ================= СВОРАЧИВАНИЕ =================
     Свёрнутый виджет - квадратная иконка-прицел слева от блока баланса сайта,
     той же высоты и с тем же фоном, рамкой и скруглением, что у баланса. */
  const mini = document.createElement('button');
  mini.id = 'pott-mini';
  mini.title = 'Итог сессии. Нажмите, чтобы развернуть виджет';
  mini.innerHTML = '<span id="pott-mini-label">Текущая сессия</span>' +
    '<span id="pott-mini-row"><span id="pott-mini-val">0</span>' +
    '<span id="pott-mini-reset" role="button" title="Новая сессия: старт = текущий баланс, WIN и LOSE с нуля (нажмите дважды)">' +
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"></path><polyline points="13.5 2 13.5 5 10.5 5"></polyline></svg>' +
    '</span></span>';
  const miniVal = mini.querySelector('#pott-mini-val');
  const miniLabel = mini.querySelector('#pott-mini-label');
  document.documentElement.appendChild(mini);

  // Быстрые кнопки слева от «Текущая сессия»: размытие и лупа (работают и при свёрнутом виджете).
  function makeQuick(id, title, svg) {
    const b = document.createElement('button');
    b.id = id;
    b.className = 'pott-quick';
    b.title = title;
    b.innerHTML = svg;
    document.documentElement.appendChild(b);
    return b;
  }
  // Двойная кнопка: слева пиктограмма размытия, справа число размытых областей (нажатие - сброс).
  const quickBlur = document.createElement('div');
  quickBlur.id = 'pott-q-blurbox';
  quickBlur.className = 'pott-quick pott-quick-split';
  quickBlur.innerHTML =
    '<button class="pott-q-part" id="pott-q-blur" title="Размытие: нажмите, затем кликните по элементу на странице">' +
      '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"></circle><path d="M10 2.5 A7.5 7.5 0 0 1 10 17.5 Z" fill="currentColor"></path></svg>' +
    '</button><span class="pott-q-sep"></span>' +
    '<button class="pott-q-part" id="pott-q-count" title="Сбросить всё размытие и увеличение">0</button>';
  document.documentElement.appendChild(quickBlur);
  const quickBlurIcon = quickBlur.querySelector('#pott-q-blur');
  const quickDisc = document.createElement('div');
  quickDisc.id = 'pott-q-disc';
  quickDisc.className = 'pott-quick pott-disc';
  quickDisc.setAttribute('aria-hidden', 'true');
  quickDisc.innerHTML = '<span class="pott-disc-i">⚠️</span><span class="pott-disc-t">Не является<br>финансовой рекомендацией</span>';
  document.documentElement.appendChild(quickDisc);
  const quickCount = quickBlur.querySelector('#pott-q-count');
  const quickGear = makeQuick('pott-q-gear', 'Настройки: цвет и прозрачность виджета',
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>');
  const quickMag = makeQuick('pott-q-mag', 'Лупа: выделите область - она увеличится. Если лупа включена - выключает её',
    '<svg viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.8"></circle><line x1="12.6" y1="12.6" x2="17" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"></line></svg>');
  if (CLIENT) { quickBlur.remove(); quickMag.remove(); quickDisc.remove(); }
  // Надпись ставим вплотную слева от кнопки размытия, той же высоты; если места нет (узкое окно) — прячем
  function placeDisc(blurLeft, size, topPx, radius, bg, borderW, borderC) {
    if (CLIENT) return;
    quickDisc.style.display = 'flex';
    Object.assign(quickDisc.style, {
      height: size + 'px', top: topPx, borderRadius: radius || '6px',
      fontSize: Math.max(11, Math.min(16, Math.round(size * 0.33))) + 'px',
    });
    if (bg) quickDisc.style.background = bg;
    if (borderW) quickDisc.style.borderWidth = borderW;
    if (borderC) quickDisc.style.setProperty('--pott-q-border', borderC);
    const w = quickDisc.offsetWidth;
    const left = blurLeft - 8 - w;
    if (left < 160) { quickDisc.style.display = 'none'; return; }
    quickDisc.style.left = left + 'px';
  }
  function syncQuick() {
    quickBlurIcon.classList.toggle('pott-on', blurEls.select.classList.contains('pott-on'));
    const n = parseInt(blurEls.count.textContent, 10) || 0;
    quickCount.textContent = n;
    quickCount.classList.toggle('pott-zero', n === 0);
    quickMag.classList.toggle('pott-on', blurEls.draw.classList.contains('pott-on'));
    quickGear.classList.toggle('pott-on', settingsOpen());
  }
  [mini, quickBlur, quickMag, quickGear].forEach((el) => {
    ['mousedown', 'click', 'pointerdown', 'touchstart'].forEach((type) => {
      el.addEventListener(type, (e) => e.stopPropagation());
    });
  });

  // Ищем «плашку» баланса в шапке сайта: сам элемент с суммой и его родитель
  // подходящего размера (как «QT Real USD 8,944»).
  // Ищем саму «плашку» баланса (как «QT Real 8,944»): ближайший к сумме родитель,
  // у которого есть своя рамка или фон, - чтобы совпасть с ней по размеру один в один.
  function hasOwnBox(node) {
    const cs = getComputedStyle(node);
    const bg = cs.backgroundColor;
    return parseFloat(cs.borderTopWidth) > 0 || (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent');
  }
  function findBalancePill() {
    for (const sel of BALANCE_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (ownWidget(el) || !isVisible(el) || !parseMoney((el.textContent || '').trim().slice(0, 30))) continue;
        let node = el, fallback = null;
        for (let i = 0; node && i < 6; i++, node = node.parentElement) {
          const r = node.getBoundingClientRect();
          if (r.height > 80 || r.width > 360) break;
          if (r.height >= 26 && r.top < 200) {
            if (hasOwnBox(node)) return { pill: node, valueEl: el };
            if (!fallback) fallback = node;
          }
        }
        if (fallback) return { pill: fallback, valueEl: el };
      }
    }
    return null;
  }
  // Подпись внутри плашки баланса (например «QT Real»): первый элемент с текстом,
  // который не является самой суммой.
  function findPillLabel(pill, valueEl) {
    for (const el of pill.querySelectorAll('*')) {
      if (el === valueEl || el.contains(valueEl) || valueEl.contains(el)) continue;
      const own = Array.prototype.some.call(el.childNodes, (n) => n.nodeType === 3 && n.textContent.trim());
      if (!own || !isVisible(el)) continue;
      if (/\d/.test(el.textContent)) continue;
      return el;
    }
    return null;
  }
  // Фон под подписью: берём фон самой подписи баланса (им она и перекрывает линию рамки),
  // иначе - фон шапки сайта позади плашки.
  function labelBackground(labelEl, pill) {
    const solid = (c) => c && c !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(c);
    for (let n = labelEl; n && n !== pill; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (solid(c)) return c;
    }
    for (let n = pill.parentElement; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (solid(c)) return c;
    }
    return '#1d2031';
  }
  const tweenMini = makeTween((v, target) => {
    if (v == null) { miniVal.textContent = '0'; miniVal.className = ''; return; }
    miniVal.textContent = signedMoney(v);
    miniVal.className = signClass(v === 0 ? target : v);
  });
  function updateMiniValue() {
    const d = currentDiff();
    tweenMini(d == null ? null : d);
  }
  balanceSubs.push(updateMiniValue);
  function placeMini() {
    updateMiniValue();
    syncQuick();
    placeSettings();
    const found = findBalancePill();
    if (found) {
      const { pill, valueEl } = found;
      const r = pill.getBoundingClientRect();
      const cs = getComputedStyle(pill);
      // Кнопки всегда стоят ровно рядом с балансом сайта и двигаются вместе с ним
      // (при прокрутке позиция пересчитывается каждый кадр - см. обработчик scroll ниже).
      const topPx = Math.round(r.top) + 'px';
      // Постоянная ширина 130px - плашка не «дёргается» ни от своей суммы, ни от ширины баланса сайта.
      // Большая сумма не расширяет плашку - вместо этого уменьшается шрифт (см. ниже).
      const miniW = 130;
      Object.assign(mini.style, {
        width: miniW + 'px',
        height: Math.round(r.height) + 'px',
        left: (Math.round(r.left - 8 - r.height) - 8 - miniW) + 'px',
        top: topPx,
        borderRadius: cs.borderTopLeftRadius && cs.borderTopLeftRadius !== '0px' ? cs.borderTopLeftRadius : '6px',
      });
      const bg = cs.backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') mini.style.background = bg;
      mini.style.borderWidth = cs.borderTopWidth;
      if (parseFloat(cs.borderTopWidth) > 0) mini.style.borderColor = cs.borderTopColor;
      // Квадратные кнопки размытия и лупы: та же высота, фон, рамка и скругление.
      const size = Math.round(r.height);
      const gearLeft = Math.round(r.left - 8 - size);
      const miniLeft = gearLeft - 8 - miniW;
      const magLeft = miniLeft - (size + 8);
      const blurW = size + Math.round(size * 0.85);
      [[quickGear, gearLeft, size], [quickMag, magLeft, size], [quickBlur, magLeft - 8 - blurW, blurW]].forEach(([b, left, w]) => {
        Object.assign(b.style, {
          width: w + 'px',
          height: size + 'px',
          left: left + 'px',
          top: topPx,
          borderRadius: mini.style.borderRadius,
          borderWidth: cs.borderTopWidth,
        });
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') b.style.background = bg;
        if (parseFloat(cs.borderTopWidth) > 0) b.style.setProperty('--pott-q-border', cs.borderTopColor);
      });
      placeDisc(magLeft - 8 - blurW, size, topPx, mini.style.borderRadius,
        bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' ? bg : '', cs.borderTopWidth,
        parseFloat(cs.borderTopWidth) > 0 ? cs.borderTopColor : '');
      // Подпись - точь-в-точь как «QT Real USD» у баланса: тот же шрифт, размер, цвет,
      // та же высота (на линии рамки) и тот же фон, который перекрывает линию.
      // Сумма - того же размера и на той же высоте, что сумма баланса.
      const labelEl = findPillLabel(pill, valueEl);
      const bt = parseFloat(cs.borderTopWidth) || 0;
      const vr = valueEl.getBoundingClientRect();
      const vcs = getComputedStyle(valueEl);
      if (labelEl) {
        const lr = labelEl.getBoundingClientRect();
        const lcs = getComputedStyle(labelEl);
        Object.assign(miniLabel.style, {
          top: Math.round(lr.top - r.top - bt) + 'px',
          color: lcs.color,
          fontFamily: lcs.fontFamily,
          fontSize: lcs.fontSize,
          fontWeight: lcs.fontWeight,
          fontStyle: lcs.fontStyle,
          letterSpacing: lcs.letterSpacing,
          textTransform: lcs.textTransform,
          lineHeight: Math.round(lr.height) + 'px',
        });
        const lp = parseFloat(lcs.paddingLeft) || 0;
        miniLabel.style.padding = lp > 0 ? '0 ' + lcs.paddingLeft : '0 4px';
        miniLabel.style.background = labelBackground(labelEl, pill);
      } else {
        miniLabel.style.top = Math.round(-parseFloat(miniLabel.style.lineHeight || 13) / 2) + 'px';
        miniLabel.style.background = labelBackground(null, pill);
      }
      miniVal.style.lineHeight = Math.round(vr.height) + 'px';
      mini.style.paddingTop = Math.max(0, Math.round(vr.top - r.top - bt)) + 'px';
      // Сумма - по центру между левым краем плашки и значком ⟳ (значок: 15px + 7px от края).
      mini.style.paddingLeft = '4px';
      mini.style.paddingRight = (4 + 15 + 7) + 'px';
      mini.style.gap = '0px';
      mini.style.justifyContent = 'flex-start';
      // Если сумма не помещается между краем и ⟳ - уменьшаем её шрифт.
      let fs = parseFloat(vcs.fontSize) || 17;
      miniVal.style.fontSize = fs + 'px';
      while (miniVal.scrollWidth + 4 + (4 + 15 + 7) + 6 > mini.clientWidth && fs > 7) { fs -= 0.5; miniVal.style.fontSize = fs + 'px'; }
    } else {
      const x = state.pos ? state.pos.left : window.innerWidth - 120;
      const y = state.pos ? state.pos.top : 12;
      Object.assign(mini.style, { width: '100px', height: '44px', left: x + 'px', top: y + 'px' });
      Object.assign(quickMag.style, { width: '44px', height: '44px', left: (x - 52) + 'px', top: y + 'px' });
      Object.assign(quickGear.style, { width: '44px', height: '44px', left: (x + 108) + 'px', top: y + 'px' });
      Object.assign(quickBlur.style, { width: '81px', height: '44px', left: (x - 52 - 89) + 'px', top: y + 'px' });
      placeDisc(x - 52 - 89, 44, y + 'px');
    }
  }
  function applyMinimized() {
    box.hidden = !!state.minimized;
    mini.title = state.minimized ? 'Итог сессии. Нажмите, чтобы открыть виджет' : 'Итог сессии. Нажмите, чтобы свернуть виджет';
    placeMini();
    if (!state.minimized && state.pos) requestAnimationFrame(clampPosition);
  }
  // ⟳ в плашке - сброс сессии (старт = текущий баланс). Срабатывает со второго нажатия.
  const miniReset = mini.querySelector('#pott-mini-reset');
  let miniResetTimer = 0;
  miniReset.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!miniReset.classList.contains('pott-confirm')) {
      miniReset.classList.add('pott-confirm');
      miniReset.title = 'Нажмите ещё раз, чтобы начать новую сессию';
      clearTimeout(miniResetTimer);
      miniResetTimer = setTimeout(() => {
        miniReset.classList.remove('pott-confirm');
        miniReset.title = 'Новая сессия: старт = текущий баланс, WIN/LOSE с нуля (нажмите дважды)';
      }, 3000);
      return;
    }
    clearTimeout(miniResetTimer);
    miniReset.classList.remove('pott-confirm');
    miniReset.title = 'Новая сессия: старт = текущий баланс, WIN/LOSE с нуля (нажмите дважды)';
    state.balance.start = balanceNow != null ? balanceNow : null;
    // Новая сессия - счётчики WIN/LOSE с нуля (история по дням остаётся).
    state.win = 0;
    state.loss = 0;
    saveState(state);
    render();
    renderBalance();
  });
  // Плашка «Текущая сессия» видна всегда; нажатие сворачивает / разворачивает виджет.
  mini.addEventListener('click', () => {
    state.minimized = !state.minimized;
    saveState(state);
    applyMinimized();
  });
  quickBlurIcon.addEventListener('click', () => { blurEls.select.click(); syncQuick(); });
  quickCount.addEventListener('click', () => { blurEls.clear.click(); syncQuick(); });
  gearEl = quickGear;
  quickGear.addEventListener('click', () => { toggleSettings(); syncQuick(); });
  quickMag.addEventListener('click', () => { blurEls.draw.click(); syncQuick(); });
  setInterval(placeMini, 1000);
  setInterval(syncQuick, 250); // подсветка кнопок сразу гаснет, когда режим размытия/лупы закончился
  window.addEventListener('resize', placeMini);
  // Прокрутка страницы или любого блока сайта - сразу двигаем кнопки вслед за балансом.
  let scrollRaf = 0;
  window.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; placeMini(); placePairs(); });
  }, { capture: true, passive: true });
  applyMinimized();

  /* ================= ДОГОН (настройка в шестерёнке) =================
     После проигрыша виджет сам вписывает в поле «Сумма» на сайте увеличенную ставку,
     после выигрыша или после последней ставки серии - возвращает начальную.
     Ставки делаете вы сами: виджет меняет только сумму.
     Результат сделки определяется:
       1) по данным сайта о закрытых сделках (поток WebSocket), а если их нет -
       2) по балансу: ставка списалась -> через время экспирации деньги вернулись
          с прибылью (WIN), вернулась та же сумма (возврат) или не вернулось ничего (LOSE). */
  if (!state.mg || typeof state.mg !== 'object') state.mg = {};
  const mg = state.mg;
  if (typeof mg.on !== 'boolean' || CLIENT) mg.on = false;
  // Множитель - одно число (по умолчанию 2). Со старой версии переносим «Своё».
  if (!(mg.k > 1)) mg.k = mg.mult === 'custom' && mg.custom > 1 ? mg.custom : 2;
  delete mg.mult; delete mg.custom;
  if (!(mg.steps >= 2 && mg.steps <= 10)) mg.steps = 4;
  if (typeof mg.countWL !== 'boolean') mg.countWL = true;
  if (!(mg.step >= 0)) mg.step = 0;
  if (!(mg.lost >= 0)) mg.lost = 0;

  const mgEls = {
    on: settings.querySelector('#pott-mg-on'),
    body: settings.querySelector('#pott-mg-body'),
    base: settings.querySelector('#pott-mg-base'),
    steps: settings.querySelector('#pott-mg-steps'),
    k: settings.querySelector('#pott-mg-k'),
    count: settings.querySelector('#pott-mg-count'),
    status: settings.querySelector('#pott-mg-status'),
  };

  // --- Поле «Сумма» и поле «Время» на сайте ---
  function nearText(el, depth) {
    let t = '', n = el;
    for (let i = 0; n && i < depth; i++, n = n.parentElement) t += ' ' + (n.getAttribute && (n.getAttribute('class') || '')) + ' ' + (n.textContent || '').slice(0, 80);
    return t;
  }
  // Сумма ставки на Pocket Option - это не поле ввода, а блок с текстом:
  // <div class="value__val">16</div> внутри блока «Сумма». Ищем сначала его, потом -
  // любое поле/блок с числом рядом с надписью «Сумма».
  const AMOUNT_LABEL = /^(сумма|сумма сделки|amount|investment|инвестиция|инвестиции)$/i;
  function amountText(el) { return el.tagName === 'INPUT' ? el.value : (el.textContent || ''); }
  function isAmountEl(el) {
    if (!el || ownWidget(el) || !siteVisible(el)) return false;
    if (el.tagName === 'INPUT' && /^(range|checkbox|radio|hidden)$/i.test(el.type)) return false;
    const t = amountText(el).trim();
    return t.length < 20 && !/\d{1,2}:\d{2}/.test(t) && !!parseMoney(t);
  }
  function nearAmountLabel(el) {
    let n = el.parentElement;
    for (let up = 0; n && up < 4; up++, n = n.parentElement) {
      for (const l of n.querySelectorAll('div, span, label, p')) {
        if (!l.children.length && AMOUNT_LABEL.test((l.textContent || '').trim())) return true;
      }
    }
    return false;
  }
  function findAmountEl() {
    for (const el of document.querySelectorAll('.block--bet-amount .value__val, .value__val')) {
      const inner = el.querySelector && el.querySelector('input');
      if (inner && isAmountEl(inner)) return inner;
      if (isAmountEl(el) && (el.closest('.block--bet-amount') || nearAmountLabel(el))) return el;
    }
    for (const l of document.querySelectorAll('div, span, label, p, h4, h5, h6')) {
      if (l.children.length || ownWidget(l)) continue;
      if (!AMOUNT_LABEL.test((l.textContent || '').trim()) || !siteVisible(l)) continue;
      let n = l.parentElement;
      for (let up = 0; n && up < 4; up++, n = n.parentElement) {
        const inp = Array.prototype.find.call(n.querySelectorAll('input'), isAmountEl);
        if (inp) return inp;
        const leaf = Array.prototype.find.call(n.querySelectorAll('div, span'), (x) => !x.children.length && x !== l && isAmountEl(x));
        if (leaf) return leaf;
      }
    }
    return null;
  }
  function findExpirySeconds() {
    for (const i of document.querySelectorAll('input, div, span')) {
      if (ownWidget(i)) continue;
      const v = i.tagName === 'INPUT' ? i.value : (i.children.length ? '' : i.textContent);
      const m = String(v || '').trim().match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
      if (!m || !siteVisible(i)) continue;
      const sec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
      if (sec > 0 && sec <= 4 * 3600) return sec;
    }
    return 60;
  }
  function readSiteAmount() {
    const el = findAmountEl();
    const m = el && parseMoney(amountText(el));
    return m ? m.value : null;
  }
  function siteAmountIs(v) {
    const el = findAmountEl();
    const m = el && parseMoney(amountText(el));
    return !!m && Math.abs(m.value - v) < 0.005;
  }
  function pressEnter(el) {
    const o = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
    el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keypress', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
  }
  // Вписать текст в поле ввода так, как будто его напечатали.
  function typeInto(inp, txt) {
    inp.focus();
    if (inp.isContentEditable) {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, txt);
    } else {
      inp.select && inp.select();
      document.execCommand('insertText', false, txt);
      if (inp.value !== txt) setNativeValue(inp, txt);
    }
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    pressEnter(inp);
  }
  // --- Калькулятор суммы на сайте ---
  const KEY_CHARS = '0123456789.';
  function leafText(el) { return el.children.length ? null : (el.textContent || '').trim(); }
  function clickableIn(el, root) {
    const c = el.closest('button, [role="button"], [class*="btn"], [class*="key"], [class*="item"]');
    return c && root.contains(c) && c !== root ? c : el;
  }
  // Ищем блок, где есть все кнопки 0-9 и точка (это и есть цифровая клавиатура калькулятора).
  function findKeypad() {
    for (const seven of document.querySelectorAll('div, span, button, a')) {
      if (leafText(seven) !== '7' || ownWidget(seven) || !siteVisible(seven)) continue;
      let root = seven.parentElement;
      for (let up = 0; root && up < 4; up++, root = root.parentElement) {
        const keys = {};
        for (const x of root.querySelectorAll('div, span, button, a')) {
          const t = leafText(x);
          if (t && t.length === 1 && KEY_CHARS.includes(t) && !keys[t] && siteVisible(x)) keys[t] = clickableIn(x, root);
        }
        if (Object.keys(keys).length < KEY_CHARS.length) continue;
        // ⌫ - кнопка без текста (обычно с иконкой) рядом с цифрами.
        const keyParent = keys['0'].parentElement;
        let back = null;
        for (const c of root.querySelectorAll('button, [role="button"], [class*="btn"], [class*="key"], div, span')) {
          if (!siteVisible(c) || Object.values(keys).includes(c)) continue;
          const t = (c.textContent || '').trim();
          const cls = String(c.className || '');
          const looksBack = /back|del|remove|erase|clear|bksp/i.test(cls) || t === '⌫' || t === '←';
          if ((t === '' && c.querySelector('svg, i, img') && c.parentElement === keyParent) || (looksBack && t.length <= 1)) { back = c; break; }
        }
        return { keys, back, root };
      }
    }
    return null;
  }
  function findCalcToggle() {
    for (const el of document.querySelectorAll('div, span, button, a')) {
      if (ownWidget(el) || !siteVisible(el)) continue;
      if (/^(калькулятор|calculator)$/i.test(leafText(el) || '')) return el.closest('button, [role="button"], [class*="head"], [class*="title"]') || el;
    }
    return null;
  }
  // Кнопки «*» и «÷» калькулятора и число-множитель рядом с ними (на сайте обычно 2).
  function findMulDiv() {
    // Мобильная версия Pocket Option: «*» и «÷» - картинки внутри .multiply__btn,
    // множитель - в .multiply__col, дисплей «$1» - в .start-block.
    const btns = Array.prototype.filter.call(document.querySelectorAll('.multiply__btn'), (b) => !ownWidget(b) && siteVisible(b));
    if (btns.length >= 2) {
      const src = (b) => { const svg = b.querySelector('svg, img'); return svg ? (svg.getAttribute('data-src') || svg.getAttribute('src') || '') : ''; };
      const mulB = btns.find((b) => /umnoz|multipl|mult/i.test(src(b))) || btns[0];
      const divB = btns.find((b) => b !== mulB && /delen|divid|div/i.test(src(b))) || btns.find((b) => b !== mulB);
      const block = mulB.closest('.multiply');
      let factor = null;
      const col = block && block.querySelector('.multiply__col');
      if (col) {
        const inp = col.querySelector('input');
        const t = inp ? inp.value : col.textContent;
        const m = String(t || '').trim().match(/\d+([.,]\d+)?/);
        if (m) factor = parseFloat(m[0].replace(',', '.'));
      }
      const root = mulB.closest('.amount-block') || mulB.closest('.trading-panel-modal__column') || mulB.closest('.trading-panel-modal__in') || block || mulB.parentElement;
      return { mul: mulB, div: divB, factor: factor || 2, display: null, root };
    }
    // Полная версия / другое оформление: «*» и «÷» текстом.
    let mul = null, div = null;
    for (const x of document.querySelectorAll('div, span, button, a')) {
      if (ownWidget(x) || !siteVisible(x)) continue;
      const t = leafText(x);
      if (!t) continue;
      if (!mul && /^[*×✕xX]$/.test(t)) mul = x;
      if (!div && /^[÷/]$/.test(t)) div = x;
      if (mul && div) break;
    }
    if (!mul || !div) return null;
    // Общий родитель «*» и «÷» - верхняя строка калькулятора; в ней же дисплей «$1» и множитель «2».
    let row = mul.parentElement, factor = null, display = null;
    for (let up = 0; row && up < 4; up++, row = row.parentElement) {
      if (!row.contains(div)) continue;
      const leaves = Array.prototype.filter.call(row.querySelectorAll('div, span, input'), (y) => siteVisible(y) && (y.tagName === 'INPUT' || !y.children.length));
      const singleDigits = leaves.filter((y) => /^\d$/.test((y.tagName === 'INPUT' ? y.value : y.textContent || '').trim())).length;
      if (singleDigits >= 6) break; // дошли до цифровой клавиатуры - выше не поднимаемся
      for (const y of leaves) {
        const t = (y.tagName === 'INPUT' ? y.value : y.textContent || '').trim();
        if (/^[$€₽]/.test(t)) { if (!display) display = y; continue; }
        if (!factor && /^\d+([.,]\d+)?$/.test(t) && y !== mul && y !== div) factor = parseFloat(t.replace(',', '.'));
      }
      if (factor && display) break;
    }
    let root = mul.parentElement;
    for (let up = 0; up < 4 && root.parentElement && root.parentElement !== document.body; up++) root = root.parentElement;
    return { mul: clickableIn(mul, root), div: clickableIn(div, root), factor: factor || 2, display, root };
  }
  function calcDisplayIs(popup, v) {
    for (const y of popup.querySelectorAll('div, span')) {
      if (y.children.length) continue;
      const t = (y.textContent || '').trim();
      if (/^[$€₽]/.test(t)) { const m = parseMoney(t); return !!m && Math.abs(m.value - v) < 0.005; }
    }
    return false;
  }
  // Из cur получить v нажатиями «*» / «÷» (если v = cur × F^n). Возвращает 'ok', 'skip' или 'fail'.
  async function mulDivTo(md, cur, v) {
    const F = md.factor;
    if (!(F > 1)) return 'skip';
    const n = Math.round(Math.log(v / cur) / Math.log(F));
    if (!n || Math.abs(cur * Math.pow(F, n) - v) > Math.max(0.01, v * 0.002) || Math.abs(n) > 10) return 'skip';
    const btn = n > 0 ? md.mul : md.div;
    const snap = () => (md.root.textContent || '') + '|' + (findAmountEl() ? amountText(findAmountEl()) : '');
    // Каким способом нажимать - определяем по первому нажатию.
    const before = snap();
    const p1 = mg.tapMode ? realTap : realClick, p2 = mg.tapMode ? realClick : realTap;
    p1(btn);
    await sleep(150);
    let press = p1;
    if (snap() === before) { p2(btn); await sleep(150); if (snap() === before) return 'fail'; press = p2; }
    for (let i = 1; i < Math.abs(n); i++) { press(btn); await sleep(150); }
    const ok = await waitFor(() => siteAmountIs(v) || calcDisplayIs(md.root, v), 600);
    return ok ? 'ok' : 'fail';
  }
  async function closeCalc(amountEl, pad) {
    const isOpen = () => pad.root.isConnected && siteVisible(pad.root);
    const esc = { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape', keyCode: 27, which: 27 };
    document.dispatchEvent(new KeyboardEvent('keydown', esc));
    await sleep(150);
    if (isOpen()) {
      // Клик мимо калькулятора (в пустое место страницы).
      const o = { bubbles: true, cancelable: true, view: window, clientX: 2, clientY: Math.round(window.innerHeight / 2) };
      let target = document.elementFromPoint(2, Math.round(window.innerHeight / 2)) || document.body;
      if (ownWidget(target)) target = document.body;
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => {
        const E = t.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
        target.dispatchEvent(new E(t, o));
      });
      await sleep(150);
    }
    if (isOpen()) { realClick(amountEl); await sleep(150); }
  }
  let writingAmount = false;
  async function writeSiteAmount(v) {
    const el = findAmountEl();
    if (!el) return 'Не нашёл на сайте сумму ставки';
    const txt = String(Math.round(v * 100) / 100);
    if (siteAmountIs(v)) return null;
    writingAmount = true;
    const active = document.activeElement;
    try {
      if (el.tagName === 'INPUT') {
        setNativeValue(el, txt);
        el.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(200);
        if (!siteAmountIs(v)) { typeInto(el, txt); el.blur(); }
      } else if (el.isContentEditable) {
        typeInto(el, txt);
        el.blur();
      } else {
        // Блок с текстом: нажимаем на него - сайт открывает калькулятор суммы
        // (цифры 0-9, точка, ⌫). Стираем старое число и набираем новое кнопками.
        const block = el.closest('.block') || (el.parentElement && el.parentElement.parentElement) || el.parentElement;
        // Режимы размытия/лупы перехватили бы эти клики - на время выключаем.
        const wasSel = selectMode, wasDraw = drawMode;
        setSelectMode(false); setDrawMode(false);
        try {
          // Открываем калькулятор. Пробуем по очереди: клик по блоку суммы
          // (элемент с data-toggle-dropdown), касание (мобильная версия), клик по самому числу.
          const opener = el.closest('[data-toggle-dropdown]') || el.closest('.control__value') || el;
          const curBefore = (parseMoney(amountText(el)) || {}).value || 0;
          const calcSeen = () => findKeypad() || (findMulDiv() ? 'muldiv' : null) || (findCalcToggle() ? 'toggle' : null);
          // Способ, который сработал в прошлый раз, пробуем первым.
          const tapFirst = mg.tapMode === true;
          const attempts = tapFirst
            ? [[realTap, opener], [realClick, opener], [realTap, el], [realClick, el]]
            : [[realClick, opener], [realTap, opener], [realClick, el], [realTap, el]];
          let first = null, tried = 0;
          for (const [fn, target] of attempts) {
            tried++;
            fn(target);
            first = await waitFor(calcSeen, 700);
            if (first) { mg.tapMode = fn === realTap; break; }
          }
          console.info('[HUNTER] калькулятор суммы:', first ? 'открыт' : 'не открылся', '| попыток:', tried, '| блок:', opener.className);
          if (first) {
            // 1) Если нужная сумма = текущая × множитель калькулятора (или ÷), просто жмём «*» / «÷».
            const md = findMulDiv();
            if (md && curBefore > 0) {
              const res = await mulDivTo(md, curBefore, v);
              if (res === 'ok') { await closeCalc(el, md); return waitFor(() => siteAmountIs(v), 800).then((ok) => ok ? null : 'Сайт не принял сумму ' + txt); }
            }
          }
          // 2) Иначе набираем число цифрами. Если калькулятор открылся свёрнутым - раскрываем «Калькулятор».
          let pad = null;
          if (first && first !== 'toggle' && first !== 'muldiv') pad = first;
          else if (first === 'toggle' || first === 'muldiv') {
            pad = await waitFor(findKeypad, 250); // вдруг цифры просто ещё появляются
            if (!pad) {
              const toggle = findCalcToggle();
              if (toggle) {
                const p1 = mg.tapMode ? realTap : realClick, p2 = mg.tapMode ? realClick : realTap;
                p1(toggle);
                pad = await waitFor(findKeypad, 700);
                if (!pad) { p2(toggle); pad = await waitFor(findKeypad, 700); }
              }
            }
          }
          if (!first) return 'Калькулятор суммы не открылся (нажатие на «' + (opener.className || 'сумму') + '» не сработало)';
          if (pad) {
            if (!pad.back) return 'В калькуляторе сайта не нашёл кнопку стирания ⌫';
            // Какой способ нажатия понимает калькулятор - проверяем на первой кнопке ⌫.
            // Смотрим на дисплей калькулятора и поле «Сумма» - меняются ли они от нажатия ⌫.
            let popup = pad.root;
            for (let up = 0; up < 4 && popup.parentElement && popup.parentElement !== document.body; up++) popup = popup.parentElement;
            const snapshot = () => (popup.textContent || '') + '|' + (findAmountEl() ? amountText(findAmountEl()) : '');
            const before = snapshot();
            const tryFirst = mg.tapMode ? realTap : realClick, tryNext = mg.tapMode ? realClick : realTap;
            tryFirst(pad.back);
            await sleep(80);
            const press = snapshot() !== before ? tryFirst : tryNext;
            if (press === tryNext) { tryNext(pad.back); await sleep(60); }
            for (let n = 0; n < 12; n++) { press(pad.back); await sleep(20); }
            for (const ch of txt) {
              if (!pad.keys[ch]) return 'В калькуляторе сайта нет кнопки «' + ch + '»';
              press(pad.keys[ch]);
              await sleep(35);
            }
            await sleep(150);
            const typedOk = siteAmountIs(v) || calcDisplayIs(popup, v);
            await closeCalc(el, pad);
            if (!typedOk && !(await waitFor(() => siteAmountIs(v), 600))) {
              const md = findMulDiv();
              const F = md && md.factor ? md.factor : null;
              if (F && Math.abs(F - mg.k) > 1e-9) {
                return 'Калькулятор не принял цифры. Поставьте в калькуляторе сайта множитель ' + fmtMoney(mg.k) +
                  ' (сейчас ' + fmtMoney(F) + ') - тогда виджет будет менять ставку кнопками «*» и «÷»';
              }
              return 'Калькулятор не принял цифры: поставьте на сайте сумму ' + txt +
                ' вручную - дальше виджет будет менять её кнопками «*» и «÷»';
            }
          } else {
            // Вдруг вместо калькулятора открылось обычное поле ввода.
            const inp = await waitFor(() => {
              const a = document.activeElement;
              if (a && a !== document.body && !ownWidget(a) && (a.tagName === 'INPUT' || a.isContentEditable)) return a;
              const i = block && Array.prototype.find.call(block.querySelectorAll('input, [contenteditable="true"]'), (x) => siteVisible(x));
              return i || null;
            }, 400);
            if (!inp) return 'Калькулятор открылся, но в нём не нашёл цифры 0-9';
            typeInto(inp, txt);
            await sleep(80);
            if (inp.isConnected && inp.blur) inp.blur();
          }
        } finally {
          setTimeout(() => { if (wasSel) setSelectMode(true); if (wasDraw) setDrawMode(true); }, 300);
        }
      }
    } catch (e) {
      return 'Ошибка при записи суммы: ' + e.message;
    } finally {
      if (active && active.focus && active !== document.body && document.activeElement !== active) { try { active.focus(); } catch (e) {} }
      setTimeout(() => { writingAmount = false; }, 300);
    }
    const ok = await waitFor(() => siteAmountIs(v), 800);
    return ok ? null : 'Сайт не принял сумму ' + txt;
  }

  // --- Расчёт следующей ставки ---
  function currentPayout() {
    const a = otcAssets.get(assetKey(state.pair));
    return a && a.payout ? a.payout / 100 : 0.85;
  }
  function roundStake(v) {
    return Math.abs(mg.base - Math.round(mg.base)) < 1e-9 ? Math.ceil(v - 1e-9) : Math.round(v * 100) / 100;
  }
  function stakeForStep(step) {
    if (step <= 0) return mg.base;
    return roundStake(mg.base * Math.pow(mg.k, step));
  }
  async function applyStake() {
    if (!mg.on || !(mg.base > 0)) return;
    const v = stakeForStep(mg.step);
    const err = await writeSiteAmount(v);
    mgStatus(err);
  }

  // --- Обработка результата сделки ---
  // В счётчик идёт результат СЕРИИ: WIN - серия закончилась выигрышем (на любой ставке),
  // LOSE - все ставки серии проиграли. Промежуточные проигрыши не отмечаются.
  function onTradeResult(res, stake) {
    if (!mg.on) return;
    if (res === 'w') {
      if (mg.countWL) box.querySelector('#pott-win-plus').click();
      mg.step = 0; mg.lost = 0;
    } else if (res === 'l') {
      mg.lost += stake || stakeForStep(mg.step);
      mg.step += 1;
      if (mg.step >= mg.steps) { // серия проиграна целиком - начинаем с начальной ставки
        if (mg.countWL) box.querySelector('#pott-loss-plus').click();
        mg.step = 0; mg.lost = 0;
      }
    }
    saveState(state);
    applyStake();
    renderMg();
  }

  // 1) Данные сайта о закрытых сделках.
  let wsDealsSeen = false;
  let dealsNet = !!mg.dealsNet;
  // Уже учтённые сделки помним и после перезагрузки страницы. При загрузке сайт присылает
  // список недавних закрытых сделок - их нельзя считать заново.
  const pageLoadedAt = Date.now() / 1000;
  if (!Array.isArray(mg.seen)) mg.seen = [];
  const seenDeals = new Set(mg.seen);
  function rememberDeal(id) {
    seenDeals.add(id);
    mg.seen.push(id);
    if (mg.seen.length > 300) mg.seen = mg.seen.slice(-300);
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !Array.isArray(e.data.__pottDeals)) return;
    const batch = e.data.__pottDeals;
    const historyBatch = batch.length > 1 && Date.now() / 1000 - pageLoadedAt < 15; // пачка старых сделок при загрузке
    let changed = false;
    for (const d of batch) {
      if (seenDeals.has(d.id)) continue;
      rememberDeal(d.id);
      changed = true;
      wsDealsSeen = true;
      // Сделка закрылась до открытия страницы - это история, не новый результат.
      if (historyBatch || (d.closeTime != null && d.closeTime < pageLoadedAt - 30)) continue;
      pendingTrades.length = 0; // по данным сайта считаем точнее - запасной способ не нужен
      // Сайт может писать прибыль «чистой» (проигрыш = -ставка, возврат = 0)
      // или «полной» (проигрыш = 0, возврат = ставка). Если хоть раз пришло отрицательное
      // число - значит «чистая», и 0 - это возврат.
      if (d.profit < 0 && !dealsNet) { dealsNet = true; mg.dealsNet = true; }
      let res;
      if (d.isWin === true) res = 'w';
      else if (dealsNet) res = d.profit > 0 ? 'w' : d.profit === 0 ? 'd' : 'l';
      else res = d.profit > 0 && Math.abs(d.profit - d.amount) > 1e-9 ? 'w' : Math.abs(d.profit - d.amount) <= 1e-9 ? 'd' : 'l';
      // Прибыль/убыток сделки - в итог дня (считается всегда, даже при выключенном «Догоне»).
      const net = res === 'w' ? (dealsNet ? d.profit : (d.profit > d.amount ? d.profit - d.amount : d.profit)) : res === 'l' ? -d.amount : 0;
      addDayPnl(Math.round(net * 100) / 100, d.closeTime ? d.closeTime * 1000 : Date.now());
      onTradeResult(res, d.amount);
    }
    if (changed) saveState(state);
  });

  // 2) Запасной способ - по движению баланса.
  const pendingTrades = []; // { stake, until }
  let prevBal = null;
  balanceSubs.push(() => {
    if (balanceNow == null) return;
    if (prevBal == null) { prevBal = balanceNow; return; }
    const delta = Math.round((balanceNow - prevBal) * 100) / 100;
    const prev = prevBal;
    prevBal = balanceNow;
    if (!delta || wsDealsSeen) return;
    // Нет данных сайта о сделках - итог дня считаем по движению баланса. Резкие скачки
    // больше половины баланса (пополнение, смена реального/демо счёта) не учитываем.
    if (Math.abs(delta) <= Math.abs(prev) * 0.5) addDayPnl(delta);
    if (delta < 0) {
      // Списание - открылась сделка на эту сумму.
      pendingTrades.push({ stake: -delta, until: Date.now() + (findExpirySeconds() + 5) * 1000 });
    } else if (pendingTrades.length) {
      const t = pendingTrades.shift();
      onTradeResult(delta > t.stake * 1.001 ? 'w' : 'd', t.stake);
    }
  });
  setInterval(() => {
    if (wsDealsSeen) return;
    while (pendingTrades.length && Date.now() > pendingTrades[0].until) {
      const t = pendingTrades.shift();
      onTradeResult('l', t.stake);
    }
  }, 500);

  // --- Интерфейс в шестерёнке ---
  function mgStatus(err) {
    if (err) { mgEls.status.textContent = err; mgEls.status.className = 'pott-err'; return; }
    mgEls.status.className = '';
    if (!mg.on) { mgEls.status.textContent = 'Выключен'; return; }
    mgEls.status.textContent = 'Ставка ' + (mg.step + 1) + ' из ' + mg.steps + ': ' + fmtMoney(stakeForStep(mg.step));
  }
  function renderMg() {
    mgEls.on.checked = mg.on;
    mgEls.body.classList.toggle('pott-off', !mg.on);
    if (document.activeElement !== mgEls.base) mgEls.base.value = mg.base > 0 ? mg.base : '';
    if (document.activeElement !== mgEls.steps) mgEls.steps.value = mg.steps;
    if (document.activeElement !== mgEls.k) mgEls.k.value = mg.k;
    mgEls.count.checked = mg.countWL;
    mgStatus();
  }
  mgEls.on.addEventListener('change', () => {
    mg.on = mgEls.on.checked;
    mg.step = 0; mg.lost = 0;
    if (mg.on && !(mg.base > 0)) mg.base = readSiteAmount() || 0;
    saveState(state);
    if (mg.on) applyStake();
    renderMg();
  });
  mgEls.base.addEventListener('change', () => {
    const m = parseMoney(mgEls.base.value);
    if (m && m.value > 0) { mg.base = m.value; mg.step = 0; mg.lost = 0; saveState(state); applyStake(); }
    renderMg();
  });
  mgEls.steps.addEventListener('change', () => {
    const n = parseInt(mgEls.steps.value, 10);
    if (n >= 2 && n <= 10) { mg.steps = n; if (mg.step >= n) { mg.step = 0; mg.lost = 0; applyStake(); } saveState(state); }
    renderMg();
  });
  mgEls.k.addEventListener('change', () => {
    const v = parseFloat(String(mgEls.k.value).replace(',', '.'));
    if (v > 1 && v <= 10) { mg.k = Math.round(v * 100) / 100; saveState(state); applyStake(); }
    renderMg();
  });
  mgEls.count.addEventListener('change', () => { mg.countWL = mgEls.count.checked; saveState(state); renderMg(); });
  [mgEls.base, mgEls.steps, mgEls.k].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') i.blur(); }));
  renderMg();

  /* ================= ПОЯВЛЕНИЕ ПОСЛЕ ЗАГРУЗКИ САЙТА =================
     Показываем всё разом, когда: страница загружена, в шапке появился баланс
     (значит, сайт отрисовал интерфейс) и подгрузился шрифт. Плюс короткая пауза,
     чтобы шапка успела встать на место. Если что-то из этого так и не наступит -
     через 15 секунд показываем всё равно. */
  (function revealWhenReady() {
    const started = Date.now();
    const MAX_WAIT = 15000;
    const SETTLE = 500;
    let readySince = 0;
    function fontsReady() {
      return !document.fonts || document.fonts.status === 'loaded';
    }
    function reveal() {
      placeMini();
      if (!state.minimized && state.pos) clampPosition();
      preloadStyle.remove();
      [box, mini, quickBlur, quickMag, quickGear, quickDisc].forEach((el) => {
        if (el.isConnected && !el.hidden && el.animate) {
          el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250, easing: 'ease-out' });
        }
      });
    }
    const timer = setInterval(() => {
      const ok = document.readyState === 'complete' && !!findBalancePill() && fontsReady();
      if (ok) {
        if (!readySince) { readySince = Date.now(); placeMini(); }
      } else {
        readySince = 0;
      }
      if ((readySince && Date.now() - readySince >= SETTLE) || Date.now() - started > MAX_WAIT) {
        clearInterval(timer);
        reveal();
      }
    }, 100);
  })();

})();
