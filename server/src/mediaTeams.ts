import { db } from './db.js';

/** Основная команда медиа: органика, клиенты по ссылкам админов и клиенты стримеров без тимлидера */
export async function mainMediaTeam(): Promise<number> {
  return (await db.query('SELECT id FROM media_teams WHERE is_main')).rows[0].id as number;
}

/**
 * Команда медиа клиента: стример, за которым закреплён клиент, → его тимлидер → команда этого тимлидера.
 * Клиент самого тимлидера идёт в его команду. Нет тимлидера или у тимлидера нет своей вкладки: Основная
 */
export async function mediaTeamOf(tgId: number): Promise<number> {
  const r = (
    await db.query(
      `SELECT mt.id FROM leads d JOIN staff o ON o.id = d.owner_id
         JOIN media_teams mt ON mt.teamlead_id = CASE WHEN o.role = 'teamlead' THEN o.id ELSE o.parent_id END
        WHERE d.tg_id = $1`,
      [tgId],
    )
  ).rows[0];
  return r ? (r.id as number) : mainMediaTeam();
}
