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

/** Дата лида в списке «Лиды»: новый по дате прихода, регистрация по дате последней регистрации (после «Разрешить новую регистрацию» - новой), FTD и активный по дате первого депозита (и остаётся за ним).
 *  Так свежая регистрация или свежий FTD всегда сверху. */
export const leadListDate = (a: string): string =>
  `(CASE WHEN coalesce(${a}.status_before_block, ${a}.status) IN ('ftd','active')
         THEN coalesce((SELECT min(e.created_at) FROM events e WHERE e.tg_id = ${a}.tg_id AND e.type IN ('ftd','dep') AND e.pocket IS NOT DISTINCT FROM ${a}.trader_id), ${a}.created_at)
         WHEN coalesce(${a}.status_before_block, ${a}.status) = 'registered'
         THEN coalesce((SELECT max(e.created_at) FROM events e WHERE e.tg_id = ${a}.tg_id AND e.type = 'reg' AND e.pocket IS NOT DISTINCT FROM ${a}.trader_id), ${a}.created_at)
         ELSE coalesce(${a}.rereg_at, ${a}.created_at) END)`;

/** Источник событий основного Pocket ID лида: подзапросы (по умолчанию) или готовые агрегаты из mainPocketEv (быстрее для списков) */
type EvSrc = { ftd: string; ftdAt: string; depAt: string; regAt: string };
const subSrc = (a: string): EvSrc => {
  const m = (t: string, f = 'min') => `(SELECT ${f}(e.created_at) FROM events e WHERE e.tg_id = ${a}.tg_id AND e.type = '${t}' AND e.pocket IS NOT DISTINCT FROM ${a}.trader_id)`;
  return {
    ftd: `EXISTS (SELECT 1 FROM events e WHERE e.tg_id = ${a}.tg_id AND e.type = 'ftd' AND e.pocket IS NOT DISTINCT FROM ${a}.trader_id)`,
    ftdAt: m('ftd'), depAt: m('dep'), regAt: m('reg', 'max'),
  };
};
const evSrc = (ev: string): EvSrc => ({ ftd: `(${ev}.ftd_at IS NOT NULL)`, ftdAt: `${ev}.ftd_at`, depAt: `${ev}.dep_at`, regAt: `${ev}.reg_at` });
/** LEFT JOIN LATERAL: все события основного Pocket ID лида одним проходом (даты этапов, первый FTD, депозиты, комиссия).
 *  depTypes — список типов депозитов, например ('ftd','dep') */
export const mainPocketEv = (a: string, ev: string, depTypes = "('ftd','dep')"): string =>
  `LEFT JOIN LATERAL (SELECT min(e.created_at) FILTER (WHERE e.type = 'ftd') AS ftd_at, min(e.created_at) FILTER (WHERE e.type = 'dep') AS dep_at,
            max(e.created_at) FILTER (WHERE e.type = 'reg') AS reg_at,
            (array_agg(e.amount ORDER BY e.created_at, e.id) FILTER (WHERE e.type = 'ftd'))[1] AS ftd_amount,
            coalesce(sum(e.amount) FILTER (WHERE e.type IN ${depTypes}), 0) AS deposits, coalesce(sum(e.amount) FILTER (WHERE e.type = 'comm'), 0) AS commission
       FROM events e WHERE e.tg_id = ${a}.tg_id AND e.pocket IS NOT DISTINCT FROM ${a}.trader_id) ${ev} ON true`;

const stageOf = (a: string, s: EvSrc): string =>
  `(CASE WHEN coalesce(${a}.status_before_block, ${a}.status) = 'active' THEN 'active'
         WHEN coalesce(${a}.status_before_block, ${a}.status) = 'ftd' OR ${s.ftd} THEN 'ftd'
         ELSE coalesce(${a}.status_before_block, ${a}.status) END)`;
const stageDateOf = (a: string, s: EvSrc): string =>
  `(CASE WHEN ${stageOf(a, s)} IN ('ftd','active')
         THEN coalesce(${s.ftdAt}, ${s.depAt}, ${a}.created_at)
         WHEN ${stageOf(a, s)} = 'registered'
         THEN coalesce(${s.regAt}, ${a}.created_at)
         ELSE coalesce(${a}.rereg_at, ${a}.created_at) END)`;

/** Этап лида для полосы «Лиды по статусам»: лид с событием FTD (первым депозитом) считается FTD, даже если его статус остался
 *  «Регистрация» (депозит меньше минимума для доступа) или он в «Отвале» из-за блокировки бота. Так полоса сходится со счётчиком FTD */
export const funnelStage = (a: string): string => stageOf(a, subSrc(a));
/** Дата этапа - одна для дашборда («Статусы лидов») и списка «Лиды»: FTD и активный по первому FTD (как в KPI; без события FTD -
 *  по первому депозиту), регистрация по дате регистрации (последней, после «Разрешить новую регистрацию» - новой), новый по дате прихода.
 *  Лид, зарегистрировавшийся в октябре и сделавший FTD в ноябре, в октябре больше не виден: он в ноябре как FTD */
export const funnelStageDate = (a: string): string => stageDateOf(a, subSrc(a));
/** То же по агрегатам mainPocketEv(a, ev) — без подзапросов на каждую строку */
export const funnelStageEv = (a: string, ev: string): string => stageOf(a, evSrc(ev));
export const funnelStageDateEv = (a: string, ev: string): string => stageDateOf(a, evSrc(ev));
export const shownStageEv = (a: string, ev: string): string =>
  `(CASE WHEN (${a}.status = 'churned' AND ${funnelStageEv(a, ev)} IN ('ftd','active')) THEN 'churned' ELSE ${funnelStageEv(a, ev)} END)`;
/** Этап для показа (дашборд и список «Лиды»): «Отвал» только после первого депозита, ушедшие раньше остаются в своём этапе */
export const shownStage = (a: string): string => `(CASE WHEN ${churnedAfterFtd(a)} THEN 'churned' ELSE ${funnelStage(a)} END)`;
/** «Отвал» в статистике: заблокировал бота (статус «Отвал») после первого депозита, то есть был FTD или активным.
 *  Новые и регистрации, заблокировавшие бота, сюда не входят и остаются на своём этапе */
export const churnedAfterFtd = (a: string): string => `(${a}.status = 'churned' AND ${funnelStage(a)} IN ('ftd','active'))`;
