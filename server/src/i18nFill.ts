/**
 * Английские версии текстов, которые админ писал сам в Office (новости, отзывы, пуши, ответы бота, акции, подписи кнопок).
 *
 * exportTexts(): в Office кнопка «Тексты для перевода» выгружает всё, у чего нет английской версии.
 * applyFill(): при запуске сервера переводы из i18n-fill.json вписываются в пустые английские поля,
 * но только если русский текст совпадает дословно. Заполненное вручную не трогаем.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db } from './db.js';
import { DEFAULTS, type TemplateKey } from './templates.js';
import { REPLY_DEFAULTS, type ReplyKey } from './replies.js';
import { DEFAULT_OFFER_TEXT } from './connect.js';
import { LABEL_EN, type Button } from './push.js';

export interface FillItem {
  type: 'news' | 'review' | 'rule' | 'template' | 'reply' | 'offer' | 'button';
  id: string;
  field: 'title' | 'body' | 'text' | 'label';
  ru: string;
  en: string;
}

/** Таблицы с кнопками: подписи без английской версии собираем и заполняем во всех */
const BUTTON_TABLES = ['push_rules', 'push_templates', 'bot_replies'] as const;

export async function exportTexts(): Promise<FillItem[]> {
  const out: FillItem[] = [];
  const add = (type: FillItem['type'], id: unknown, field: FillItem['field'], ru: string) => { if (ru && ru.trim()) out.push({ type, id: String(id), field, ru, en: '' }); };
  for (const r of (await db.query(`SELECT id, title, body, title_en, body_en FROM news ORDER BY id`)).rows) {
    if (!r.title_en) add('news', r.id, 'title', r.title);
    if (!r.body_en) add('news', r.id, 'body', r.body);
  }
  for (const r of (await db.query(`SELECT id, body FROM reviews WHERE body_en = '' AND status = 'published' ORDER BY id`)).rows) add('review', r.id, 'body', r.body);
  for (const r of (await db.query(`SELECT id, text FROM push_rules WHERE text_en = '' ORDER BY id`)).rows) add('rule', r.id, 'text', r.text);
  for (const r of (await db.query(`SELECT key, text FROM push_templates WHERE text_en = '' ORDER BY key`)).rows)
    if (r.text !== DEFAULTS[r.key as TemplateKey]?.text) add('template', r.key, 'text', r.text);
  for (const r of (await db.query(`SELECT key, text FROM bot_replies WHERE text_en = '' ORDER BY key`)).rows)
    if (r.text !== REPLY_DEFAULTS[r.key as ReplyKey]?.text) add('reply', r.key, 'text', r.text);
  for (const r of (await db.query(`SELECT id, text FROM connect_offers WHERE text_en = '' ORDER BY id`)).rows)
    if (r.text !== DEFAULT_OFFER_TEXT) add('offer', r.id, 'text', r.text);
  const labels = new Set<string>();
  for (const t of BUTTON_TABLES)
    for (const r of (await db.query(`SELECT buttons FROM ${t}`)).rows)
      for (const b of (Array.isArray(r.buttons) ? r.buttons : []) as Button[])
        if (b?.label && !b.label_en && !LABEL_EN[b.label]) labels.add(b.label);
  for (const l of [...labels].sort()) add('button', '', 'label', l);
  return out;
}

const SQL: Record<string, string> = {
  'news:title': `UPDATE news SET title_en = $3 WHERE id = $1::int AND title_en = '' AND title = $2`,
  'news:body': `UPDATE news SET body_en = $3 WHERE id = $1::int AND body_en = '' AND body = $2`,
  'review:body': `UPDATE reviews SET body_en = $3 WHERE id = $1::int AND body_en = '' AND body = $2`,
  'rule:text': `UPDATE push_rules SET text_en = $3 WHERE id = $1::int AND text_en = '' AND text = $2`,
  'template:text': `UPDATE push_templates SET text_en = $3 WHERE key = $1 AND text_en = '' AND text = $2`,
  'reply:text': `UPDATE bot_replies SET text_en = $3 WHERE key = $1 AND text_en = '' AND text = $2`,
  'offer:text': `UPDATE connect_offers SET text_en = $3 WHERE id = $1::int AND text_en = '' AND text = $2`,
};

export async function applyFill(): Promise<void> {
  const file = resolve(process.cwd(), 'i18n-fill.json');
  if (!existsSync(file)) return;
  let items: FillItem[];
  try { items = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.warn('i18n-fill.json: не читается', e); return; }
  let n = 0;
  const labels = new Map<string, string>();
  for (const it of items) {
    if (!it?.en?.trim() || !it.ru) continue;
    if (it.type === 'button') { labels.set(it.ru, it.en.trim()); continue; }
    const q = SQL[`${it.type}:${it.field}`];
    if (q) n += (await db.query(q, [it.id, it.ru, it.en.trim()])).rowCount ?? 0;
  }
  if (labels.size)
    for (const t of BUTTON_TABLES) {
      const pk = t === 'push_rules' ? 'id' : 'key';
      for (const r of (await db.query(`SELECT ${pk} AS k, buttons FROM ${t}`)).rows) {
        if (!Array.isArray(r.buttons)) continue;
        let changed = false;
        const next = (r.buttons as Button[]).map((b) => {
          const en = b?.label && !b.label_en ? labels.get(b.label) : undefined;
          if (!en) return b;
          changed = true; n++;
          return { ...b, label_en: en };
        });
        if (changed) await db.query(`UPDATE ${t} SET buttons = $2 WHERE ${pk} = $1`, [r.k, JSON.stringify(next)]);
      }
    }
  if (n) console.log(`i18n-fill: вписано английских текстов: ${n}`);
}
