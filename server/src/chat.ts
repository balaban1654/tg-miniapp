import { db } from './db.js';

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
  return !recent.rowCount;
}
