import { db } from './db.js';
import { bot } from './tg.js';
import { config } from './config.js';

export interface Incoming {
  tgId: number;
  kind: string;
  text: string | null;
  fileId: string | null;
  fileName?: string | null;
  tgMessageId: number | null;
}

/** Сохраняет сообщение клиента. Возвращает true, если это первое сообщение за последние 10 минут. */
export async function recordIncoming(m: Incoming): Promise<boolean> {
  const recent = await db.query(`SELECT 1 FROM messages WHERE tg_id = $1 AND created_at > now() - interval '10 minutes' LIMIT 1`, [m.tgId]);
  await db.query(
    `INSERT INTO messages (tg_id, direction, kind, text, file_id, tg_message_id, file_name) VALUES ($1,'in',$2,$3,$4,$5,$6)`,
    [m.tgId, m.kind, m.text, m.fileId, m.tgMessageId, m.fileName ?? null],
  );
  await notifySupport(m).catch((e) => console.error('Уведомление о сообщении в поддержку: сбой', e));
  return !recent.rowCount;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const KIND: Record<string, string> = { photo: '📷 фото', video: '🎬 видео', voice: '🎤 голосовое', audio: '🎵 аудио', document: '📎 файл', video_note: '⭕ кружок', sticker: 'стикер' };

/** Новое сообщение клиента: одно уведомление в ветку команды с @ его трейдера. Следующее от того же клиента
 *  только после того, как чат закрыли кнопкой «Закрыть» в Office, чтобы не было уведомления на каждое сообщение */
async function notifySupport(m: Incoming): Promise<void> {
  // Куда слать: группа и ветка, назначенные командой /notify; иначе из настроек сервера
  const st = Object.fromEntries((await db.query(`SELECT key, value FROM app_settings WHERE key IN ('support_notify_chat','support_notify_thread')`)).rows.map((r) => [r.key, r.value]));
  const chat = st.support_notify_chat || config.supportNotifyChat;
  const thread = st.support_notify_chat ? Number(st.support_notify_thread) || undefined : config.supportNotifyThread;
  if (!chat || config.disableBot) return;
  const r = (
    await db.query(
      `UPDATE leads d SET chat_notified_at = now()
        WHERE d.tg_id = $1 AND coalesce(d.lead_role, 'lead') IN ('lead','test')
          AND (d.chat_notified_at IS NULL OR (d.chat_closed_at IS NOT NULL AND d.chat_notified_at < d.chat_closed_at))
        RETURNING d.first_name, d.username, d.owner_id`,
      [m.tgId],
    )
  ).rows[0];
  if (!r) return;
  const s = r.owner_id ? (await db.query('SELECT name, tg_username FROM staff WHERE id = $1', [r.owner_id])).rows[0] : null;
  const un = s?.tg_username ? String(s.tg_username).replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '') : '';
  const trader = s ? (un ? '@' + esc(un) : esc(s.name)) : 'не закреплён';
  const who = esc(r.first_name || (r.username ? '@' + r.username : 'Клиент')) + (r.username && r.first_name ? ' (@' + esc(r.username) + ')' : '');
  const body = m.text ? esc(m.text.length > 300 ? m.text.slice(0, 300) + '…' : m.text) : KIND[m.kind] ?? 'сообщение';
  const site = /^https:\/\//.test(config.publicUrl) ? config.publicUrl.replace(/\/$/, '') : 'https://hunterai.space';
  const text = `💬 <b>Новое сообщение в поддержку</b>\nКлиент: ${who} · <code>${m.tgId}</code>\nТрейдер: ${trader}\n\n«${body}»\n\n<a href="${site}/crm#/chats">Открыть чаты</a>`;
  try {
    await bot.api.sendMessage(chat, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(thread ? { message_thread_id: thread } : {}) });
  } catch (e) {
    // Причину сохраняем: её видно в app_settings.support_notify_error
    const why = (e as { description?: string }).description ?? String(e);
    await db.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ('support_notify_error', $1, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [why]).catch(() => {});
    // Не дошло (бот не в группе, нет прав): разрешаем повторить со следующим сообщением клиента
    await db.query('UPDATE leads SET chat_notified_at = NULL WHERE tg_id = $1', [m.tgId]);
    throw e;
  }
}
