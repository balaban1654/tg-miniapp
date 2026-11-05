/**
 * Виджет HUNTER TEAM для Pocket Option.
 *
 * Клиент вставляет в расширение «User JavaScript and CSS» короткий загрузчик со своим личным ключом.
 * Загрузчик при каждом открытии платформы берёт актуальный виджет с сервера: обновили файл
 * server/widget/hunter-widget.js — у всех новая версия. Виджет отдаётся только по действующему ключу
 * клиента с открытым доступом (или сотрудника), не заблокированного и не отключённого в Office.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { db } from './db.js';
import { SITE_URL } from './reserved.js';

const WIDGET_FILE = resolve(process.cwd(), 'widget/hunter-widget.js');
let widgetCode = '';
try { widgetCode = readFileSync(WIDGET_FILE, 'utf8'); } catch (e) { console.error('Виджет: не найден файл', WIDGET_FILE, e); }

/** Короткое сообщение вместо виджета: табличка в углу платформы, без ошибок в консоли */
const notice = (text: string) =>
  `(function(){if(document.getElementById('pott-notice'))return;var d=document.createElement('div');d.id='pott-notice';` +
  `d.style.cssText='position:fixed;z-index:2147483647;right:12px;bottom:12px;max-width:300px;padding:10px 14px;border-radius:10px;background:#1c1233;color:#fff;font:600 13px/1.45 sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5)';` +
  `d.textContent=${JSON.stringify(text)};(document.body||document.documentElement).appendChild(d);setTimeout(function(){d.remove()},15000)})();`;

/** Кому можно выдать виджет: клиент с доступом или аккаунт сотрудника, не заблокирован, не удалён */
const ALLOWED = `(coalesce(d.lead_role, 'lead') NOT IN ('lead','test') OR d.access) AND d.banned_at IS NULL AND d.removed_at IS NULL`;

/** Загрузчик для расширения: ключ уже вставлен. GM_* передаём в виджет, если расширение их даёт */
export function loaderCode(key: string): string {
  return [
    '// HUNTER TEAM: виджет для Pocket Option. Код загружается с сервера и обновляется сам.',
    '// Ключ личный: не передавайте этот код другим.',
    '(function () {',
    `  var KEY = '${key}';`,
    `  fetch('${SITE_URL}/widget/w.js?key=' + KEY, { cache: 'no-store' })`,
    '    .then(function (r) { return r.text(); })',
    "    .then(function (code) { new Function('GM_getValue', 'GM_setValue', code)(typeof GM_getValue === 'function' ? GM_getValue : undefined, typeof GM_setValue === 'function' ? GM_setValue : undefined); })",
    "    .catch(function (e) { console.warn('HUNTER widget:', e); });",
    '})();',
  ].join('\n');
}

/** Ключ клиента: создаётся при первом запросе. null — виджет ему не положен или отключён */
export async function widgetKeyFor(tgId: number): Promise<string | null> {
  const r = (await db.query(`SELECT d.widget_key, d.widget_blocked, ${ALLOWED} AS ok FROM leads d WHERE d.tg_id = $1`, [tgId])).rows[0];
  if (!r || !r.ok || r.widget_blocked) return null;
  if (r.widget_key) return r.widget_key;
  const key = randomBytes(18).toString('base64url');
  await db.query('UPDATE leads SET widget_key = $2 WHERE tg_id = $1 AND widget_key IS NULL', [tgId, key]);
  return (await db.query('SELECT widget_key FROM leads WHERE tg_id = $1', [tgId])).rows[0].widget_key;
}

export async function widgetRoutes(app: FastifyInstance): Promise<void> {
  // Сам виджет по личному ключу. Ответ всегда исполняемый JS: при отказе — табличка с причиной
  app.get<{ Querystring: { key?: string } }>('/widget/w.js', async (req, reply) => {
    reply.type('application/javascript; charset=utf-8').header('Access-Control-Allow-Origin', '*').header('Cache-Control', 'no-store');
    const key = String(req.query.key ?? '');
    if (!/^[A-Za-z0-9_-]{16,40}$/.test(key)) return notice('HUNTER: ключ виджета неверный. Скопируйте код заново в профиле Mini App.');
    const d = (await db.query(`SELECT d.tg_id, d.widget_blocked, ${ALLOWED} AS ok FROM leads d WHERE d.widget_key = $1`, [key])).rows[0];
    if (!d) return notice('HUNTER: ключ виджета больше не действует. Скопируйте код заново в профиле Mini App.');
    if (d.widget_blocked) return notice('HUNTER: виджет для вас отключён. Напишите в поддержку.');
    if (!d.ok) return notice('HUNTER: виджет доступен после подключения. Откройте Mini App, чтобы узнать подробнее.');
    if (!widgetCode) return notice('HUNTER: виджет временно недоступен, попробуйте позже.');
    await db.query('UPDATE leads SET widget_used_at = now() WHERE tg_id = $1', [d.tg_id]).catch(() => {});
    return widgetCode;
  });
}
