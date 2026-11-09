import { db } from './db.js';

/** Журнал лида: кто и когда пришёл, по какой ссылке, кто закрепил, отдал или сменил владельца, блокировки и т. п.
 *  Запись никогда не ломает основное действие: ошибки журнала только в консоль */
export async function leadLog(tgId: number | string, kind: string, text: string, staffId: number | null = null): Promise<void> {
  try {
    await db.query('INSERT INTO lead_log (tg_id, kind, text, staff_id) VALUES ($1,$2,$3,$4)', [tgId, kind, text, staffId]);
  } catch (e) {
    console.error('lead_log:', (e as Error).message);
  }
}

/** Имя сотрудника для текста журнала */
export async function staffName(id: number | null | undefined): Promise<string> {
  if (id == null) return 'никто';
  const r = (await db.query('SELECT name FROM staff WHERE id = $1', [id]).catch(() => null))?.rows[0];
  return r?.name ?? '#' + id;
}
