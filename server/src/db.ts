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
    const r = await db.query('SELECT id, owner_id FROM links WHERE slug = $1', [slug]);
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
  const cur = await db.query('SELECT * FROM leads WHERE tg_id = $1', [tgId]);
  return { lead: cur.rows[0], isNew: false };
}
