import { db } from './db.js';

/** Сколько минусов подряд считается подозрительным: более трёх, то есть от четырёх */
export const FRAUD_MIN = 4;

/** Серия минусов подряд по последним оценкам клиента (плюс обрывает серию, пропуски не считаются).
 *  Серия от FRAUD_MIN и дольше: создаём или обновляем запись во вкладке «Фрод». Тестовые аккаунты и сотрудники не проверяются */
export async function fraudCheck(tgId: number | string): Promise<void> {
  const lead = (await db.query(`SELECT 1 FROM leads WHERE tg_id = $1 AND coalesce(lead_role, 'lead') = 'lead' AND NOT is_tester`, [tgId])).rowCount;
  if (!lead) return;
  const rows = (await db.query(`SELECT result FROM deals WHERE tg_id = $1 AND signal_id IS NOT NULL AND result IN ('win','loss') ORDER BY id DESC LIMIT 300`, [tgId])).rows as { result: string }[];
  let streak = 0;
  for (const r of rows) {
    if (r.result !== 'loss') break;
    streak++;
  }
  if (streak < FRAUD_MIN) {
    // Серия оборвалась плюсом: запись остаётся в истории, но больше не «текущая»
    await db.query('UPDATE fraud_alerts SET ongoing = FALSE WHERE tg_id = $1 AND ongoing', [tgId]);
    return;
  }
  // Новое событие (серия началась заново или выросла) снова подсвечивается как непросмотренное
  await db.query(
    `INSERT INTO fraud_alerts (tg_id, streak) VALUES ($1, $2)
     ON CONFLICT (tg_id) DO UPDATE SET
       seen_at = CASE WHEN NOT fraud_alerts.ongoing OR EXCLUDED.streak > fraud_alerts.streak THEN NULL ELSE fraud_alerts.seen_at END,
       streak = EXCLUDED.streak, ongoing = TRUE, updated_at = now()`,
    [tgId, streak],
  );
}

/** Один раз при запуске: проверяем всех, у кого уже есть минусы, чтобы вкладка «Фрод» не начиналась с нуля */
export async function fraudBackfill(): Promise<void> {
  if ((await db.query(`SELECT 1 FROM app_flags WHERE key = 'fraud_backfill'`)).rowCount) return;
  const ids = (await db.query(`SELECT tg_id FROM deals WHERE signal_id IS NOT NULL AND result = 'loss' GROUP BY tg_id HAVING count(*) >= $1`, [FRAUD_MIN])).rows as { tg_id: string }[];
  for (const r of ids) await fraudCheck(r.tg_id).catch(() => {});
  await db.query(`INSERT INTO app_flags (key) VALUES ('fraud_backfill') ON CONFLICT DO NOTHING`);
}
