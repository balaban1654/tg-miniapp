/** Дата, по которой лид попадает в счётчики периода. FTD и активные считаются по дате первого депозита,
 *  остальные по дате прихода: лид, зашедший в бота позже своего первого депозита, не должен попадать в месяц захода. */
export const leadStatusDate = (a: string): string =>
  `(CASE WHEN ${a}.status IN ('ftd','active')
         THEN coalesce((SELECT min(e.created_at) FROM events e WHERE e.tg_id = ${a}.tg_id AND e.type IN ('ftd','dep') AND coalesce(e.raw->>'nopay','') <> '1'), ${a}.created_at)
         ELSE ${a}.created_at END)`;
