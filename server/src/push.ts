import { GrammyError, InlineKeyboard } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { db } from './db.js';
import { config } from './config.js';
import { bot } from './tg.js';
import { withClickId } from './app.js';

export type Trigger = 'start' | 'no_reg' | 'no_deposit' | 'ftd' | 'inactive' | 'withdrawal';
export interface Button {
  label: string;
  type: 'miniapp' | 'url' | 'support' | 'register' | 'callback' | 'review';
  url?: string;
  data?: string;
  /** Цвет кнопки в Telegram: primary — синяя, success — зелёная */
  style?: 'primary' | 'success' | 'danger';
  /** Кнопка стоит в одной строке со следующей */
  inline?: boolean;
}
export interface Rule {
  id: number;
  name: string;
  trigger: Trigger;
  delay_min: number;
  text: string;
  buttons: Button[];
  daytime_only: boolean;
  enabled: boolean;
  starts_at: Date;
}
interface Target {
  tg_id: string;
  first_name: string | null;
  username: string | null;
  region: string | null;
  owner_name: string | null;
  po_promo: string | null;
  po_link: string | null;
  po_link_ru: string | null;
  tz: string | null;
}

/** В тестах (DISABLE_BOT=1) сообщения не уходят в Telegram, а складываются сюда. */
export const outbox: { tgId: string; text: string; buttons: unknown }[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Тексты и кнопки ----------

/** Время вида «13:30:15» в часовом поясе клиента. Если пояс неизвестен, берём Киев и добавляем пометку */
export function clockFor(ms: number, tz: string | null | undefined): string {
  const fmt = (zone: string) => new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: zone }).format(new Date(ms));
  if (tz) {
    try {
      return fmt(tz);
    } catch {
      /* неизвестный пояс, падаем в Киев */
    }
  }
  return `${fmt(config.pushTz)} (Киев)`;
}

export function renderText(text: string, t: Pick<Target, 'first_name' | 'username' | 'owner_name' | 'po_promo'> & { tz?: string | null }): string {
  return text
    .replace(/\{время:(\d{10,14})\}/g, (_m, ms) => clockFor(Number(ms), t.tz))
    .replaceAll('{имя}', t.first_name || t.username || 'друг')
    .replaceAll('{стример}', t.owner_name || 'наша команда')
    .replaceAll('{промокод}', t.po_promo || '');
}

export function registerUrl(t: Target): string | null {
  const ru = t.po_link_ru || config.defaultPoLinkRu;
  const ww = t.po_link || config.defaultPoLink;
  const pick = t.region === 'ru' ? ru || ww : t.region === 'ww' ? ww || ru : '';
  return pick ? withClickId(pick, t.tg_id) : null;
}

/** Простая разметка для текстов: **жирный**, __курсив__, [текст](https://ссылка). Остальное экранируется. */
export function toHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>')
    .replace(/__(.+?)__/gs, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
}

export function buildKeyboard(buttons: Button[], t: Target): InlineKeyboard | undefined {
  const kb = new InlineKeyboard();
  let any = false;
  for (const b of buttons) {
    let btn: InlineKeyboardButton | null = null;
    if (b.type === 'callback' && b.data) btn = InlineKeyboard.text(b.label, b.data);
    else if (b.type === 'url' && b.url) btn = InlineKeyboard.url(b.label, b.url);
    else if (b.type === 'support') btn = InlineKeyboard.url(b.label, `https://t.me/${config.botUsername}?start=support`);
    else if (b.type === 'register') {
      // Регистрация только в Mini App: ссылки Pocket Option в боте не показываем, регион и ссылка выбираются там
      if (config.miniAppUrl) btn = InlineKeyboard.webApp(b.label, config.miniAppUrl);
    } else if (b.type === 'miniapp' && config.miniAppUrl) btn = InlineKeyboard.webApp(b.label, config.miniAppUrl);
    else if (b.type === 'review' && config.miniAppUrl) btn = InlineKeyboard.webApp(b.label, config.miniAppUrl + (config.miniAppUrl.includes('?') ? '&' : '?') + 'go=review');
    if (!btn) continue;
    kb.add(b.style ? { ...btn, style: b.style } : btn);
    if (!b.inline) kb.row();
    any = true;
  }
  // .row() оставляет в конце пустую строку, Telegram такое не любит
  const rows = kb.inline_keyboard as unknown as unknown[][];
  while (rows.length && !rows[rows.length - 1].length) rows.pop();
  return any ? kb : undefined;
}

export async function loadTarget(tgId: number | string): Promise<Target> {
  const r = await db.query(
    `SELECT d.tg_id, d.first_name, d.username, d.region, d.tz, o.name AS owner_name, o.po_promo, o.po_link, o.po_link_ru
       FROM leads d LEFT JOIN staff o ON o.id = d.owner_id WHERE d.tg_id = $1`,
    [tgId],
  );
  return r.rows[0];
}

// ---------- Отправка ----------

type Delivery = { ok: true } | { ok: false; retry?: boolean; blocked?: boolean; error: string };

async function deliver(tgId: string, text: string, kb?: InlineKeyboard): Promise<Delivery> {
  if (config.disableBot) {
    outbox.push({ tgId, text, buttons: kb ? kb.inline_keyboard.map((r) => r.map((b) => ({ text: b.text, ...('url' in b ? { url: b.url } : {}), ...('callback_data' in b ? { cb: b.callback_data } : {}), ...('web_app' in b ? { web_app: b.web_app.url } : {}) }))) : null });
    return { ok: true };
  }
  try {
    await bot.api.sendMessage(tgId, toHtml(text), { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(kb ? { reply_markup: kb } : {}) });
    return { ok: true };
  } catch (e) {
    if (e instanceof GrammyError) {
      if (e.error_code === 429) return { ok: false, retry: true, error: 'лимит Telegram' };
      return { ok: false, blocked: e.error_code === 403 && /blocked/i.test(e.description), error: e.description };
    }
    return { ok: false, error: String(e) };
  }
}

async function markBlocked(tgId: string) {
  await db.query('UPDATE leads SET bot_blocked = TRUE WHERE tg_id = $1', [tgId]);
}

// ---------- Автоматические правила ----------

const T: Record<Trigger, string> = {
  start: 'd.created_at',
  no_reg: 'd.created_at',
  no_deposit: `(SELECT min(e.created_at) FROM events e WHERE e.tg_id = d.tg_id AND e.type = 'reg')`,
  ftd: `(SELECT min(e.created_at) FROM events e WHERE e.tg_id = d.tg_id AND e.type IN ('ftd','dep'))`,
  inactive: 'coalesce(d.last_seen_at, d.created_at)',
  withdrawal: `(SELECT min(e.created_at) FROM events e WHERE e.tg_id = d.tg_id AND e.type = 'wd')`,
};
const COND: Record<Trigger, string> = {
  start: 'TRUE',
  no_reg: `d.status = 'new'`,
  no_deposit: `d.status = 'registered'`,
  ftd: `d.status IN ('ftd','active')`,
  inactive: 'd.access',
  // Просим отзыв один раз после первого успешного вывода, если клиент ещё не писал отзыв
  withdrawal: `NOT EXISTS (SELECT 1 FROM reviews rv WHERE rv.tg_id = d.tg_id)`,
};

async function dueTargets(rule: Rule, limit: number, tgId?: string): Promise<Target[]> {
  const t = T[rule.trigger];
  const params: unknown[] = [String(rule.delay_min), rule.starts_at, rule.id, limit];
  let only = '';
  if (tgId) {
    params.push(tgId);
    only = `AND d.tg_id = $5`;
  }
  const r = await db.query(
    `SELECT d.tg_id, d.first_name, d.username, d.region, d.tz, o.name AS owner_name, o.po_promo, o.po_link, o.po_link_ru
       FROM leads d LEFT JOIN staff o ON o.id = d.owner_id
      WHERE d.removed_at IS NULL AND d.bot_started AND NOT d.bot_blocked AND ${COND[rule.trigger]}
        AND (${t}) + ($1 || ' minutes')::interval <= now()
        AND (${t}) + ($1 || ' minutes')::interval >= $2
        AND NOT EXISTS (SELECT 1 FROM push_log l WHERE l.rule_id = $3 AND l.tg_id = d.tg_id)
        ${only}
      ORDER BY d.tg_id LIMIT $4`,
    params,
  );
  return r.rows;
}

export function isDaytime(now = new Date()): boolean {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: config.pushTz }).format(now)) % 24;
  return h >= config.pushDayFrom && h < config.pushDayTo;
}

async function sendRule(rule: Rule, t: Target): Promise<'sent' | 'retry' | 'failed'> {
  const res = await deliver(t.tg_id, renderText(rule.text, t), buildKeyboard(rule.buttons, t));
  if (!res.ok && res.retry) return 'retry';
  await db.query(`INSERT INTO push_log (rule_id, tg_id, status, error) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [
    rule.id,
    t.tg_id,
    res.ok ? 'sent' : 'failed',
    res.ok ? null : res.error.slice(0, 200),
  ]);
  if (!res.ok && res.blocked) await markBlocked(t.tg_id);
  return res.ok ? 'sent' : 'failed';
}

async function enabledRules(): Promise<Rule[]> {
  return (await db.query('SELECT * FROM push_rules WHERE enabled ORDER BY sort, id')).rows;
}

/** Отправляет клиенту все правила, срок которых уже наступил. Вызывается сразу после /start и депозита. */
export async function processLead(tgId: number | string): Promise<number> {
  let sent = 0;
  for (const rule of await enabledRules()) {
    if (rule.daytime_only && !isDaytime()) continue;
    const [t] = await dueTargets(rule, 1, String(tgId));
    if (!t) continue;
    if ((await sendRule(rule, t)) === 'sent') sent++;
  }
  return sent;
}

async function runRules(): Promise<boolean> {
  for (const rule of await enabledRules()) {
    if (rule.daytime_only && !isDaytime()) continue;
    for (const t of await dueTargets(rule, 100)) {
      if ((await sendRule(rule, t)) === 'retry') return false;
      await sleep(config.disableBot ? 0 : 40);
    }
  }
  return true;
}

// ---------- Ручные рассылки ----------

export const SEGMENTS: Record<string, string> = {
  all: 'TRUE',
  new: `d.status = 'new'`,
  registered: `d.status = 'registered'`,
  ftd: `d.status IN ('ftd','active')`,
  access: 'd.access',
  churned: `d.status = 'churned'`,
  testers: 'd.is_tester',
  withdrew: `EXISTS (SELECT 1 FROM events e WHERE e.tg_id = d.tg_id AND e.type = 'wd')`,
};

export function segmentWhere(segment: string, ownerId?: number | null): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let sql = `d.removed_at IS NULL AND d.bot_started AND NOT d.bot_blocked AND ${SEGMENTS[segment] ?? 'FALSE'}`;
  if (ownerId) {
    params.push(ownerId);
    sql += ` AND d.owner_id = $1`;
  }
  return { sql, params };
}

export async function createBroadcast(b: { text: string; buttons: Button[]; segment: string; ownerId?: number | null; createdBy: number }) {
  const w = segmentWhere(b.segment, b.ownerId);
  const ins = await db.query(
    `INSERT INTO broadcasts (text, buttons, segment, owner_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [b.text, JSON.stringify(b.buttons), b.segment, b.ownerId ?? null, b.createdBy],
  );
  const id = ins.rows[0].id;
  const jobs = await db.query(
    `INSERT INTO broadcast_jobs (broadcast_id, tg_id) SELECT ${id}, d.tg_id FROM leads d WHERE ${w.sql} ON CONFLICT DO NOTHING`,
    w.params,
  );
  await db.query('UPDATE broadcasts SET total = $2 WHERE id = $1', [id, jobs.rowCount ?? 0]);
  return { id, total: jobs.rowCount ?? 0 };
}

async function runBroadcasts(): Promise<boolean> {
  const jobs = await db.query(
    `SELECT j.broadcast_id, j.tg_id, b.text, b.buttons, d.first_name, d.username, d.region, d.tz,
            o.name AS owner_name, o.po_promo, o.po_link, o.po_link_ru
       FROM broadcast_jobs j
       JOIN broadcasts b ON b.id = j.broadcast_id
       JOIN leads d ON d.tg_id = j.tg_id
       LEFT JOIN staff o ON o.id = d.owner_id
      WHERE j.status = 'pending' ORDER BY j.broadcast_id, j.tg_id LIMIT 250`,
  );
  for (const j of jobs.rows) {
    const res = await deliver(j.tg_id, renderText(j.text, j), buildKeyboard(j.buttons, j));
    if (!res.ok && res.retry) return false;
    await db.query(`UPDATE broadcast_jobs SET status = $3, error = $4 WHERE broadcast_id = $1 AND tg_id = $2`, [
      j.broadcast_id,
      j.tg_id,
      res.ok ? 'sent' : 'failed',
      res.ok ? null : res.error.slice(0, 200),
    ]);
    if (!res.ok && res.blocked) await markBlocked(j.tg_id);
    await sleep(config.disableBot ? 0 : 45);
  }
  return true;
}

// ---------- Планировщик ----------

let running = false;
export async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (await runRules()) await runBroadcasts();
  } catch (e) {
    console.error('Ошибка планировщика пушей:', e);
  } finally {
    running = false;
  }
}

export function startScheduler(): void {
  setInterval(() => void tick(), 20_000);
}

// ---------- Правила по умолчанию ----------

export const GREETING_OLD = 'Привет, {имя}! Это Hunter AI. Здесь тренажёр, учёт твоих сделок и материалы команды. У тебя уже есть аккаунт Pocket Option?';
export const GREETING_TEXT = '**Привет! Я Hunter AI.**\n\nДаю готовые сигналы: пара, направление, точки входа. Твоя задача — просто повторить.\n\nЗа 1 минуту покажу в тренажёре, как это выглядит на практике.';
export const GREETING_BUTTONS: Button[] = [
  { label: 'Тренажёр', type: 'miniapp', style: 'primary' },
  { label: 'Всё понятно — регистрация', type: 'callback', data: 'acc_ready', style: 'success' },
  { label: 'Написать в поддержку', type: 'support' },
];

export const REVIEW_ASK_TEXT = '{имя}, поздравляем с выводом средств! 🎉\n\nЕсли вам нравится работа с командой, оставьте короткий отзыв: оценка и пара слов, можно с фото. Это займёт меньше минуты и поможет новичкам решиться.';
export const REVIEW_BUTTON: Button = { label: 'Оставить отзыв', type: 'review', style: 'success' };

export async function seedDefaultRules(): Promise<void> {
  // Новое приветствие, если админ не менял прежнее
  await db.query(`UPDATE push_rules SET text = $1, buttons = $2 WHERE trigger = 'start' AND text = $3`, [GREETING_TEXT, JSON.stringify(GREETING_BUTTONS), GREETING_OLD]);
  // Переименование «клуб» в «команда» для уже сохранённых текстов и подписей
  await db.query(`UPDATE push_rules SET text = replace(text, 'материалы клуба', 'материалы команды') WHERE text LIKE '%материалы клуба%'`);
  await db.query(`UPDATE media_items SET subtitle = replace(subtitle, 'Трейдер клуба', 'Трейдер команды') WHERE subtitle LIKE '%Трейдер клуба%'`);
  // Просьба об отзыве после успешного вывода (добавляется один раз, дальше админ правит её в «Пушах»)
  await db.query(
    `INSERT INTO push_rules (name, trigger, delay_min, text, buttons, daytime_only, sort)
     SELECT 'Отзыв после вывода', 'withdrawal', 30, $1, $2, TRUE, 90
      WHERE NOT EXISTS (SELECT 1 FROM push_rules WHERE trigger = 'withdrawal')`,
    [REVIEW_ASK_TEXT, JSON.stringify([REVIEW_BUTTON])],
  );
  const c = await db.query('SELECT count(*)::int AS n FROM push_rules');
  if (c.rows[0].n > 0) return;
  const support: Button = { label: 'Написать в поддержку', type: 'support' };
  const register: Button = { label: 'Зарегистрироваться', type: 'register' };
  const cabinet: Button = { label: 'Открыть кабинет', type: 'miniapp' };
  const rules: [string, Trigger, number, string, Button[], boolean][] = [
    ['Приветствие', 'start', 0, GREETING_TEXT, GREETING_BUTTONS, false],
    ['Нет регистрации, через 1 час', 'no_reg', 60, '{имя}, не вижу твоей регистрации. Если возникли трудности, напиши в поддержку: ответим прямо здесь, в этом чате.', [support, register], false],
    ['Нет регистрации, через сутки', 'no_reg', 1440, '{имя}, регистрация в Pocket Option занимает пару минут. После неё и пополнения счёта в приложении откроется доступ. Если что-то непонятно, напиши нам.', [register, support], true],
    ['Нет депозита, через 2 часа', 'no_deposit', 120, '{имя}, регистрация есть. Осталось пополнить счёт, и доступ откроется автоматически. Рекомендуем от 100 $. Если не получается, напиши сюда, подскажем.', [cabinet, support], true],
    ['Нет депозита, через сутки', 'no_deposit', 1440, '{имя}, ждём твой первый депозит. Как только он поступит, мы сразу откроем доступ. Если нужна помощь, напиши нам.', [cabinet, support], true],
    ['Депозит получен', 'ftd', 0, 'Депозит получен. Доступ открыт. Откройте кабинет: там сделки, тренажёр и материалы команды.', [cabinet], false],
    ['Давно не заходил, через 7 дней', 'inactive', 10080, '{имя}, давно не виделись. В кабинете тренажёр и материалы команды, заглядывай.', [cabinet], true],
  ];
  let i = 0;
  for (const [name, trigger, delay, text, buttons, day] of rules) {
    await db.query(
      `INSERT INTO push_rules (name, trigger, delay_min, text, buttons, daytime_only, sort) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [name, trigger, delay, text, JSON.stringify(buttons), day, i++],
    );
  }
}
