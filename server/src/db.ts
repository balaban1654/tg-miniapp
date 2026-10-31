import pg from 'pg';
import { config } from './config.js';

export const db = new pg.Pool({ connectionString: config.databaseUrl });

export interface Lead {
  tg_id: string;
  owner_id: number | null;
  status: string;
  access: boolean;
}

/**
 * Создаёт лида при первом /start и закрепляет его за владельцем ссылки.
 * Повторный заход по чужой ссылке владельца не меняет.
 */
export async function attachLead(
  tgId: number,
  username: string | undefined,
  firstName: string | undefined,
  slug: string | null,
): Promise<{ lead: Lead; isNew: boolean }> {
  let linkId: number | null = null;
  let ownerId: number | null = null;
  if (slug) {
    const r = await db.query('SELECT id, owner_id FROM links WHERE slug = $1 OR token = $1', [slug]);
    if (r.rows[0]) {
      linkId = r.rows[0].id;
      ownerId = r.rows[0].owner_id;
    }
  }
  const ins = await db.query(
    `INSERT INTO leads (tg_id, username, first_name, link_id, owner_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tg_id) DO NOTHING
     RETURNING *`,
    [tgId, username ?? null, firstName ?? null, linkId, ownerId],
  );
  if (ins.rows[0]) {
    await db.query(`INSERT INTO events (tg_id, type) VALUES ($1,'start')`, [tgId]);
    return { lead: ins.rows[0], isNew: true };
  }
  // Лид, которого удалили из списка (снят с Mini App), вернулся сам (/start, сообщение, открыл Mini App): снова показываем его в «Лидах»
  // как пришедшего сейчас. Доступ при этом не открывается сам: он закрыт, пока не придёт депозит или его не выдадут вручную
  await db.query('UPDATE leads SET removed_at = NULL, created_at = now() WHERE tg_id = $1 AND removed_at IS NOT NULL', [tgId]);
  // Лид мог быть заведён вручную из постбеков (только Telegram ID и Pocket ID): дописываем юзернейм, имя, ссылку и владельца
  await db.query(
    `UPDATE leads SET username = coalesce($2, username), first_name = coalesce($3, first_name), link_id = coalesce(link_id, $4), owner_id = coalesce(owner_id, $5) WHERE tg_id = $1`,
    [tgId, username ?? null, firstName ?? null, linkId, ownerId],
  );
  await db.query(`INSERT INTO events (tg_id, type) SELECT $1, 'start' WHERE NOT EXISTS (SELECT 1 FROM events WHERE tg_id = $1 AND type = 'start')`, [tgId]);
  const cur = await db.query('SELECT * FROM leads WHERE tg_id = $1', [tgId]);
  return { lead: cur.rows[0], isNew: false };
}
