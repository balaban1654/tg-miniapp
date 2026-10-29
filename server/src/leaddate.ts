/** Статус «Отвал» из-за блокировки бота на даты не влияет: берём статус до блокировки.
 *  Дата, по которой лид попадает в счётчики периода. FTD и активные считаются по дате первого депозита,
 *  остальные по дате прихода: лид, зашедший в бота позже своего первого депозита, не должен попадать в месяц захода.
 *  Флаг nopay (событие до начала месяца, не оплачивается стримеру) на дату не влияет: это только про зарплату.
 *  strict: только по событию FTD (как в KPI); у лида со статусом FTD/активный, но без такого события, даты нет и в счётчик он не попадает.
 *  Без strict (список «Лиды») такой лид остаётся на дате прихода, чтобы не пропасть из списка. */
export const leadStatusDate = (a: string, strict = false): string =>
  `(CASE WHEN coalesce(${a}.status_before_block, ${a}.status) IN ('ftd','active')
         THEN ${
           strict
             ? `(SELECT min(e.created_at) FROM events e WHERE e.tg_id = ${a}.tg_id AND e.type = 'ftd')`
             : `coalesce((SELECT min(e.created_at) FROM events e WHERE e.tg_id = ${a}.tg_id AND e.type IN ('ftd','dep') ), ${a}.created_at)`
         }
         ELSE ${a}.created_at END)`;

/** Дата лида в списке «Лиды»: новый по дате прихода, регистрация по дате регистрации, FTD и активный по дате первого депозита (и остаётся за ним).
 *  Так свежая регистрация или свежий FTD всегда сверху. */
export const leadListDate = (a: string): string =>
  `(CASE WHEN coalesce(${a}.status_before_block, ${a}.status) IN ('ftd','active')
         THEN coalesce((SELECT min(e.created_at) FROM events e WHERE e.tg_id = ${a}.tg_id AND e.type IN ('ftd','dep')), ${a}.created_at)
         WHEN coalesce(${a}.status_before_block, ${a}.status) = 'registered'
         THEN coalesce((SELECT min(e.created_at) FROM events e WHERE e.tg_id = ${a}.tg_id AND e.type = 'reg'), ${a}.created_at)
         ELSE ${a}.created_at END)`;

/** Этап лида для полосы «Лиды по статусам»: лид с событием FTD (первым депозитом) считается FTD, даже если его статус остался
 *  «Регистрация» (депозит меньше минимума для доступа) или он в «Отвале» из-за блокировки бота. Так полоса сходится со счётчиком FTD */
export const funnelStage = (a: string): string =>
  `(CASE WHEN coalesce(${a}.status_before_block, ${a}.status) = 'active' THEN 'active'
         WHEN coalesce(${a}.status_before_block, ${a}.status) = 'ftd' OR EXISTS (SELECT 1 FROM events e WHERE e.tg_id = ${a}.tg_id AND e.type = 'ftd') THEN 'ftd'
         ELSE coalesce(${a}.status_before_block, ${a}.status) END)`;
/** Дата для этапа: FTD и активный по дате первого FTD (как в KPI), остальные по дате прихода */
export const funnelStageDate = (a: string): string =>
  `(CASE WHEN ${funnelStage(a)} IN ('ftd','active') THEN (SELECT min(e.created_at) FROM events e WHERE e.tg_id = ${a}.tg_id AND e.type = 'ftd') ELSE ${a}.created_at END)`;
/** «Отвал» в статистике: заблокировал бота (статус «Отвал») после первого депозита, то есть был FTD или активным.
 *  Новые и регистрации, заблокировавшие бота, сюда не входят и остаются на своём этапе */
export const churnedAfterFtd = (a: string): string => `(${a}.status = 'churned' AND ${funnelStage(a)} IN ('ftd','active'))`;
