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
    const r = await db.query(
      `SELECT l.id, l.owner_id, coalesce(p.rotate, l.rotate) AS rotate, coalesce(l.parent_id, l.id) AS root
         FROM links l LEFT JOIN links p ON p.id = l.parent_id WHERE l.slug = $1 OR l.token = $1`,
      [slug],
    );
    if (r.rows[0]) {
      linkId = r.rows[0].id;
      ownerId = r.rows[0].owner_id;
      // «Случайно»: владельца выбираем по очереди, только для нового лида или лида без владельца
      if (r.rows[0].rotate) {
        const cur = (await db.query('SELECT owner_id FROM leads WHERE tg_id = $1', [tgId])).rows[0];
        if (!cur || cur.owner_id == null) ownerId = (await pickRotationOwner(r.rows[0].root, tgId)) ?? ownerId;
      }
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

/** Кому отдать лида со ссылки «Случайно». Среди сотрудников ссылки (активных): у кого сегодня (по Киеву) меньше лидов с этой ссылки,
 *  при равенстве — у кого больше часов в эфире за месяц, затем больше FTD за месяц. Так за день каждый получает по одному от лучшего
 *  к худшему, потом круг повторяется. Выбор записывается, чтобы очередь знала, кто уже получил */
export async function pickRotationOwner(rootLinkId: number, tgId: number): Promise<number | null> {
  const TZ = "'Europe/Kyiv'";
  const r = await db.query(
    `SELECT s.id,
            (SELECT count(*)::int FROM link_assign a WHERE a.link_id = $1 AND a.staff_id = s.id
               AND (a.at AT TIME ZONE ${TZ})::date = (now() AT TIME ZONE ${TZ})::date) AS today,
            (SELECT coalesce(sum(r.approved_min), 0)::int FROM shift_reports r WHERE r.staff_id = s.id AND NOT r.team AND r.status = 'approved'
               AND to_char(r.day, 'YYYY-MM') = to_char(now() AT TIME ZONE ${TZ}, 'YYYY-MM')) AS mins,
            (SELECT count(*)::int FROM events e JOIN leads d ON d.tg_id = e.tg_id WHERE d.owner_id = s.id AND e.type = 'ftd'
               AND to_char(e.created_at AT TIME ZONE ${TZ}, 'YYYY-MM') = to_char(now() AT TIME ZONE ${TZ}, 'YYYY-MM')) AS ftd
       FROM link_pool lp JOIN staff s ON s.id = lp.staff_id
      WHERE lp.link_id = $1 AND s.active AND s.deleted_at IS NULL
      ORDER BY today ASC, mins DESC, ftd DESC, s.id ASC LIMIT 1`,
    [rootLinkId],
  );
  const id = r.rows[0]?.id as number | undefined;
  if (!id) return null;
  await db.query('INSERT INTO link_assign (link_id, staff_id, tg_id) VALUES ($1,$2,$3)', [rootLinkId, id, tgId]);
  return id;
}
