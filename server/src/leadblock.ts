import { GrammyError } from 'grammy';
import { db } from './db.js';
import { bot } from './tg.js';

/** Ответ Telegram, по которому понятно, что клиент заблокировал бота или удалил аккаунт */
export const BLOCKED_RE = /blocked by the user|user is deactivated/i;

/** Лид заблокировал бота: отмечаем и ставим статус «Отвал», прежний статус запоминаем */
export async function markLeadBlocked(tgId: number | string): Promise<boolean> {
  const r = await db.query(
    `UPDATE leads SET bot_blocked = TRUE,
            status_before_block = CASE WHEN status <> 'churned' THEN status ELSE status_before_block END,
            status = 'churned'
      WHERE tg_id = $1 AND (NOT coalesce(bot_blocked, FALSE) OR status <> 'churned')`,
    [tgId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Лид снова с ботом (/start, сообщение, разблокировал): возвращаем статус, который был до блокировки */
export async function markLeadAlive(tgId: number | string): Promise<boolean> {
  const r = await db.query(
    `UPDATE leads SET bot_started = TRUE, bot_blocked = FALSE, last_seen_at = now(),
            status = CASE WHEN status = 'churned' AND status_before_block IS NOT NULL THEN status_before_block ELSE status END,
            status_before_block = NULL
      WHERE tg_id = $1`,
    [tgId],
  );
  return (r.rowCount ?? 0) > 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let running = false;

/** Проверка всех лидов, запускавших бота: заблокировал ли он бота. Пробуем «печатает…» (клиент сообщения не получает).
 *  Ошибка «blocked by the user» значит блокировку, успех у отмеченного заблокированным значит, что он вернулся */
export async function checkAllBlocked(log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void }) {
  if (running) return;
  running = true;
  const started = Date.now();
  let checked = 0, blocked = 0, restored = 0, errors = 0;
  try {
    const leads = (await db.query(`SELECT tg_id, coalesce(bot_blocked, FALSE) AS bot_blocked, status FROM leads WHERE bot_started ORDER BY tg_id`)).rows as { tg_id: string; bot_blocked: boolean; status: string }[];
    for (const l of leads) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await bot.api.sendChatAction(Number(l.tg_id), 'typing');
          if (l.bot_blocked && (await markLeadAlive(l.tg_id))) restored++;
          break;
        } catch (e) {
          if (e instanceof GrammyError && e.error_code === 429) {
            await sleep(((e.parameters?.retry_after ?? 5) + 1) * 1000);
            continue;
          }
          const d = e instanceof GrammyError ? e.description : String(e);
          if (BLOCKED_RE.test(d)) {
            if (!l.bot_blocked || l.status !== 'churned') { await markLeadBlocked(l.tg_id); blocked++; }
          } else errors++;
          break;
        }
      }
      checked++;
      await sleep(50);
    }
  } finally {
    running = false;
    const res = { at: new Date().toISOString(), checked, blocked, restored, errors, sec: Math.round((Date.now() - started) / 1000) };
    await db.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ('botcheck_last', $1, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(res)]).catch(() => {});
    log.info(res, 'Проверка блокировок бота завершена');
  }
}

/** Раз в сутки (ночью, около 04:00 по Киеву) и сразу, если проверки ещё не было */
export function startBlockCheck(log: Parameters<typeof checkAllBlocked>[0]) {
  const tick = async () => {
    try {
      const last = (await db.query(`SELECT updated_at FROM app_settings WHERE key = 'botcheck_last'`)).rows[0]?.updated_at as Date | undefined;
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false }).format(new Date()));
      const age = last ? Date.now() - new Date(last).getTime() : Infinity;
      if (!last || (hour === 4 && age > 20 * 3600_000) || age > 30 * 3600_000) await checkAllBlocked(log);
    } catch (e) {
      log.warn(e, 'Проверка блокировок бота не удалась');
    }
  };
  setInterval(() => void tick(), 15 * 60_000);
  setTimeout(() => void tick(), 60_000);
}
