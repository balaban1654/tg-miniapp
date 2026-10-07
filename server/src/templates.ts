import { db } from './db.js';
import { config } from './config.js';
import { createBroadcast, buildKeyboard, deliver, renderText, SEGMENTS, type Button, type Photo } from './push.js';

/** Сообщения, которые бот шлёт сам. Текст, картинку, кнопки, получателей и каналы настраивает админ в Office */
export const TEMPLATE_KEYS = ['signal', 'live', 'result'] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const DEFAULTS: Record<TemplateKey, { enabled: boolean; text: string; buttons: Button[]; segment: string }> = {
  signal: {
    enabled: true,
    text: 'Новый сигнал: {пара}, {направление}, экспирация {экспирация}.\nВход в {время}. Откройте кабинет.',
    buttons: [{ label: 'Открыть кабинет', type: 'miniapp' }],
    segment: 'all',
  },
  result: {
    enabled: true,
    text: '{иконка} Результат сигнала: {пара}, {направление}, экспирация {экспирация}.\n**{итог}**',
    buttons: [{ label: 'Открыть кабинет', type: 'miniapp' }],
    segment: 'access',
  },
  live: {
    enabled: false,
    text: '🔴 {стример} сейчас в прямом эфире!\n\nЗаходите, пока идёт трансляция.',
    buttons: [{ label: 'Смотреть эфир', type: 'stream', style: 'success' }],
    segment: 'own',
  },
};

export async function seedTemplates(): Promise<void> {
  for (const k of TEMPLATE_KEYS) {
    const d = DEFAULTS[k];
    await db.query(
      `INSERT INTO push_templates (key, enabled, text, buttons, segment) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (key) DO NOTHING`,
      [k, d.enabled, d.text, JSON.stringify(d.buttons), d.segment],
    );
  }
}

/** @имя, ссылка t.me/имя или числовой id канала → единый вид; пусто, если не похоже на канал */
export function normChannel(v: string): string {
  const x = v.trim().replace(/^https?:\/\/(www\.)?t\.me\//i, '@').replace(/\/+$/, '');
  const y = /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(x) ? '@' + x : x;
  return CHANNEL_RE.test(y) ? y : '';
}

export const CHANNEL_RE = /^(@[A-Za-z][A-Za-z0-9_]{3,31}|-100\d{5,})$/;

interface Tpl {
  enabled: boolean;
  text: string;
  buttons: Button[];
  segment: string;
  channels: string[];
  toStaffChannel: boolean;
  photo: Photo | null;
}

async function load(key: TemplateKey): Promise<Tpl | null> {
  const r = (await db.query('SELECT enabled, text, buttons, segment, channels, to_staff_channel, photo, photo_type FROM push_templates WHERE key = $1', [key])).rows[0];
  if (!r) return null;
  return { enabled: r.enabled, text: r.text, buttons: r.buttons, segment: r.segment, channels: r.channels, toStaffChannel: r.to_staff_channel, photo: r.photo ? { data: r.photo, type: r.photo_type } : null };
}

/** В канал нельзя кнопку Mini App и обратные вызовы: оставляем ссылки, а вход в кабинет превращаем в ссылку на бота */
function channelButtons(buttons: Button[]): Button[] {
  const out: Button[] = [];
  for (const b of buttons) {
    if (b.type === 'url' && b.url) out.push(b);
    else if (b.type === 'support') out.push(b);
    else if (['miniapp', 'register', 'review'].includes(b.type)) out.push({ label: b.label, type: 'url', url: `https://t.me/${config.botUsername}`, ...(b.style ? { style: b.style } : {}), ...(b.inline ? { inline: b.inline } : {}) });
  }
  return out;
}

export interface Dispatch {
  /** Значения для подстановок в текст: {пара}, {стример} и т. д. */
  vars: Record<string, string>;
  /** Ссылка на эфир для кнопки «Смотреть эфир» */
  streamUrl?: string;
  /** Канал самого стримера (из карточки сотрудника) */
  staffChannel?: string | null;
  /** Чьим лидам слать, если в шаблоне выбрано «Лиды этого стримера» */
  ownerId?: number | null;
  createdBy: number;
  /** Приписка в начало текста, например «ТЕСТ» */
  prefix?: string;
}

/** Рассылает шаблон: клиентам бота по выбранному списку и в Telegram-каналы. Возвращает, сколько получателей поставлено в очередь */
export async function dispatchTemplate(key: TemplateKey, d: Dispatch): Promise<{ users: number; channels: number; skipped?: string }> {
  const t = await load(key);
  if (!t || !t.enabled) return { users: 0, channels: 0, skipped: 'выключен' };
  let text = t.text;
  for (const [k, v] of Object.entries(d.vars)) text = text.replaceAll(`{${k}}`, v);
  text = (d.prefix ?? '') + text;
  if (!text.trim() && !t.photo) return { users: 0, channels: 0, skipped: 'нет текста и картинки' };
  const buttons: Button[] = [];
  for (const b of t.buttons) {
    if (b.type === 'stream') {
      if (d.streamUrl) buttons.push({ ...b, type: 'url', url: d.streamUrl });
    } else buttons.push(b);
  }
  let users = 0;
  const seg = t.segment;
  if (seg !== 'none' && (seg === 'own' ? d.ownerId : seg in SEGMENTS)) {
    const r = await createBroadcast({ text, buttons, segment: seg === 'own' ? 'all' : seg, ownerId: seg === 'own' ? d.ownerId : null, createdBy: d.createdBy, photo: t.photo });
    users = r.total;
  }
  let channels = 0;
  const cb = channelButtons(buttons);
  const targets = [...t.channels];
  if (t.toStaffChannel && d.staffChannel && !targets.includes(d.staffChannel)) targets.push(d.staffChannel);
  for (const ch of targets) {
    if (!CHANNEL_RE.test(ch)) continue;
    const kb = buildKeyboard(cb, { tg_id: '0', first_name: null, username: null, region: null, owner_name: null, po_promo: null, po_link: null, po_link_ru: null, tz: null });
    const res = await deliver(ch, renderText(text, { first_name: null, username: null, owner_name: null, po_promo: null, tz: null }), kb, t.photo);
    if (res.ok) channels++;
    else console.error(`Шаблон ${key}: не удалось отправить в ${ch}: ${res.error}`);
  }
  return { users, channels };
}

const lastLive = new Map<number, number>();

/** Стример открыл смену: шлём «Стример в прямом эфире». Повтор от одного стримера не чаще раза в 30 минут */
export async function announceLive(staffId: number, streamUrl: string): Promise<void> {
  try {
    const prev = lastLive.get(staffId) ?? 0;
    if (Date.now() - prev < 30 * 60_000) return;
    const st = (await db.query('SELECT name, live_channel FROM staff WHERE id = $1', [staffId])).rows[0];
    if (!st) return;
    const r = await dispatchTemplate('live', { vars: { 'стример': st.name }, streamUrl, ownerId: staffId, staffChannel: st.live_channel, createdBy: staffId });
    if (!r.skipped) lastLive.set(staffId, Date.now());
  } catch (e) {
    console.error('Не удалось отправить «Стример в эфире»:', e);
  }
}

