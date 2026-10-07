/** Дата, по которой лид попадает в счётчики периода. FTD и активные считаются по дате первого депозита,
 *  остальные по дате прихода: лид, зашедший в бота позже своего первого депозита, не должен попадать в месяц захода.
 *  Флаг nopay (событие до начала месяца, не оплачивается стримеру) на дату не влияет: это только про зарплату.
 *  strict: только по событию FTD (как в KPI); у лида со статусом FTD/активный, но без такого события, даты нет и в счётчик он не попадает.
 *  Без strict (список «Лиды») такой лид остаётся на дате прихода, чтобы не пропасть из списка. */
export const leadStatusDate = (a: string, strict = false): string =>
  `(CASE WHEN ${a}.status IN ('ftd','active')
         THEN ${
           strict
             ? `(SELECT min(e.created_at) FROM events e WHERE e.tg_id = ${a}.tg_id AND e.type = 'ftd')`
             : `coalesce((SELECT min(e.created_at) FROM events e WHERE e.tg_id = ${a}.tg_id AND e.type IN ('ftd','dep') ), ${a}.created_at)`
         }
         ELSE ${a}.created_at END)`;
