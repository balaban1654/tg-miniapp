import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db.js';
import type { Role } from './auth.js';

/** Бухгалтерия стримеров: KPI, смены и отчёты, бонусы и штрафы, выплаты и авансы. Работает только для роли «стример». */

export interface KpiPlan {
  hours: number; // план смен, часов в месяц
  shiftH: number; // часов в одной смене
  leads: number; // план по лидам (FTD)
  base: number; // ставка за смены при выполнении
  baseLow: number; // ставка, если смены не выполнены
  price: number; // цена за лида
  priceLow: number; // цена за лида, если план по лидам не выполнен
  tiers: { from: number; price: number }[]; // повышенные цены за всех лидов месяца
  ftd: { over: number; bonus: number }[]; // бонус за FTD по сумме первого депозита
  day: { count: number; min: number; bonus: number; cutoffH: number }; // дневной бонус
  tol: number; // запас на курс брокера
  shiftTol: number; // допуск по дневной смене: недобор в пределах этой доли нормы не считается невыполненным днём
  advance: number; // максимальный аванс
  goals: Goals; // цели месяца для дашборда админа
}

/** Цели месяца: по ним на дашборде считается план/факт */
export interface Goals {
  ftd: number; // FTD, штук
  ftdSum: number; // пополнения по FTD, $
  deposits: number; // все депозиты (FTD и додепы), $
  commission: number; // комиссия, $
  net: number; // чистая прибыль, $
}

export const DEFAULT_PLAN: KpiPlan = {
  hours: 66,
  shiftH: 3,
  leads: 30,
  base: 500,
  baseLow: 300,
  price: 8,
  priceLow: 3,
  tiers: [
    { from: 50, price: 15 },
    { from: 40, price: 10 },
  ],
  ftd: [
    { over: 1000, bonus: 50 },
    { over: 500, bonus: 20 },
    { over: 300, bonus: 10 },
    { over: 100, bonus: 5 },
  ],
  day: { count: 4, min: 50, bonus: 50, cutoffH: 3 },
  tol: 0.1,
  shiftTol: 0.15,
  advance: 200,
  goals: { ftd: 50, ftdSum: 4500, deposits: 9500, commission: 6000, net: 3900 },
};

const TZ = 'Europe/Kyiv';
const r2 = (n: number) => Math.round(n * 100) / 100;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function getPlan(): Promise<KpiPlan> {
  const row = (await db.query('SELECT data FROM kpi_settings WHERE id = 1')).rows[0];
  const d = (row?.data ?? {}) as Partial<KpiPlan>;
  return { ...DEFAULT_PLAN, ...d, day: { ...DEFAULT_PLAN.day, ...(d.day ?? {}) }, goals: { ...DEFAULT_PLAN.goals, ...(d.goals ?? {}) } };
}

export async function currentPeriod(): Promise<string> {
  return (await db.query(`SELECT to_char(now() AT TIME ZONE '${TZ}', 'YYYY-MM') AS p`)).rows[0].p;
}

export interface KpiResult {
  staffId: number;
  period: string;
  hoursMin: number; // зачтённые минуты за месяц
  planMin: number;
  shifts: number; // смен = часы ÷ длина смены
  ftdCount: number;
  shiftsDone: boolean;
  leadsDone: boolean;
  overtimeMin: number;
  act: { base: number; baseRate: number; price: number; leadsPay: number };
  full: { base: number; baseRate: number; price: number; leadsPay: number };
  min: { base: number; baseRate: number; price: number; leadsPay: number };
  ftdBonus: number;
  dayBonus: number;
  adjBonus: number;
  adjPenalty: number;
  total: number; // начислено по текущему состоянию планов
  fullTotal: number;
  minTotal: number;
  paid: number;
  due: number;
  tiers: { over: number; bonus: number; n: number; tol: number }[];
  belowTier: number;
  dayRows: { d: string; n: number; all: number; hit: boolean }[];
}

/** Расчёт за месяц по правилам KPI. Часы берутся только из зачтённых отчётов, лиды это FTD по ссылкам стримера. */
async function kpiCompute(staffId: number, period: string, plan: KpiPlan): Promise<KpiResult> {
  const hoursMin = Number(
    (await db.query(`SELECT coalesce(sum(approved_min), 0)::int AS m FROM shift_reports WHERE staff_id = $1 AND status = 'approved' AND to_char(day, 'YYYY-MM') = $2`, [staffId, period])).rows[0].m,
  );
  const ftd = (
    await db.query(
      `SELECT coalesce(e.amount, 0)::float AS amount,
              to_char((e.created_at AT TIME ZONE '${TZ}') - ($3 || ' hours')::interval, 'YYYY-MM-DD') AS dkey
         FROM events e JOIN leads d ON d.tg_id = e.tg_id
        WHERE d.owner_id = $1 AND d.lead_role = 'lead' AND e.type = 'ftd' AND to_char(e.created_at AT TIME ZONE '${TZ}', 'YYYY-MM') = $2`,
      [staffId, period, String(plan.day.cutoffH)],
    )
  ).rows as { amount: number; dkey: string }[];
  const adj = (await db.query(`SELECT kind, coalesce(sum(amount), 0)::float AS s FROM staff_adjustments WHERE staff_id = $1 AND period = $2 GROUP BY kind`, [staffId, period])).rows;
  const adjBonus = Number(adj.find((x) => x.kind === 'bonus')?.s ?? 0);
  const adjPenalty = Number(adj.find((x) => x.kind === 'penalty')?.s ?? 0);
  const paid = Number((await db.query(`SELECT coalesce(sum(amount), 0)::float AS s FROM staff_payouts WHERE staff_id = $1 AND period = $2`, [staffId, period])).rows[0].s);

  const planMin = plan.hours * 60;
  const n = ftd.length;
  const shiftsDone = hoursMin >= planMin;
  const leadsDone = n >= plan.leads;
  const tierPrice = () => plan.tiers.slice().sort((a, b) => b.from - a.from).find((t) => n >= t.from)?.price ?? plan.price;
  const mode = (m: 'full' | 'min' | 'actual') => {
    const baseRate = m === 'full' ? plan.base : m === 'min' ? plan.baseLow : shiftsDone ? plan.base : plan.baseLow;
    const price = m === 'full' ? tierPrice() : m === 'min' ? plan.priceLow : leadsDone ? tierPrice() : plan.priceLow;
    return { base: r2((baseRate * Math.min(hoursMin, planMin)) / planMin), baseRate, price, leadsPay: r2(n * price) };
  };
  const act = mode('actual');
  const full = mode('full');
  const min = mode('min');

  // Бонус за FTD: один уровень по сумме первого депозита, с запасом на курс брокера
  const k = 1 - plan.tol;
  const tiersSorted = plan.ftd.slice().sort((a, b) => b.over - a.over);
  const tierStats = tiersSorted.map((t) => ({ over: t.over, bonus: t.bonus, n: 0, tol: 0 }));
  let belowTier = 0;
  let ftdBonus = 0;
  const days = new Map<string, { n: number; all: number }>();
  for (const f of ftd) {
    const idx = tiersSorted.findIndex((t) => f.amount >= t.over * k);
    if (idx < 0) belowTier++;
    else {
      tierStats[idx].n++;
      if (!(f.amount > tiersSorted[idx].over)) tierStats[idx].tol++;
      ftdBonus += tiersSorted[idx].bonus;
    }
    const d = days.get(f.dkey) ?? { n: 0, all: 0 };
    d.all++;
    if (f.amount >= plan.day.min * k) d.n++;
    days.set(f.dkey, d);
  }
  const dayRows = [...days.entries()].sort().map(([d, v]) => ({ d, n: v.n, all: v.all, hit: v.n >= plan.day.count }));
  const dayBonus = dayRows.filter((x) => x.hit).length * plan.day.bonus;
  const extra = ftdBonus + dayBonus + adjBonus - adjPenalty;
  const total = r2(act.base + act.leadsPay + extra);
  return {
    staffId,
    period,
    hoursMin,
    planMin,
    shifts: Math.floor(hoursMin / (plan.shiftH * 60)),
    ftdCount: n,
    shiftsDone,
    leadsDone,
    overtimeMin: Math.max(0, hoursMin - planMin),
    act,
    full,
    min,
    ftdBonus,
    dayBonus,
    adjBonus,
    adjPenalty,
    total,
    fullTotal: r2(full.base + full.leadsPay + extra),
    minTotal: r2(min.base + min.leadsPay + extra),
    paid,
    due: r2(total - paid),
    tiers: tierStats,
    belowTier,
    dayRows: dayRows.filter((x) => x.hit || x.n >= 3),
  };
}

/** KPI за месяц. Если месяц закрыт, берём зафиксированный расчёт (выплаты считаются по факту, они идут и после закрытия). */
export async function kpiFor(staffId: number, period: string, plan: KpiPlan): Promise<KpiResult> {
  const snap = (await db.query('SELECT data FROM kpi_closed WHERE period = $1 AND staff_id = $2', [period, staffId])).rows[0];
  if (!snap) return kpiCompute(staffId, period, plan);
  const k = snap.data as KpiResult;
  const paid = Number((await db.query(`SELECT coalesce(sum(amount), 0)::float AS s FROM staff_payouts WHERE staff_id = $1 AND period = $2`, [staffId, period])).rows[0].s);
  return { ...k, paid, due: r2(k.total - paid) };
}

/** План, по которому месяц был закрыт (для закрытого месяца), иначе текущий */
export async function planFor(period: string): Promise<KpiPlan> {
  const row = (await db.query('SELECT plan FROM month_closes WHERE period = $1', [period])).rows[0];
  if (!row) return getPlan();
  const d = row.plan as Partial<KpiPlan>;
  return { ...DEFAULT_PLAN, ...d, day: { ...DEFAULT_PLAN.day, ...(d.day ?? {}) }, goals: { ...DEFAULT_PLAN.goals, ...(d.goals ?? {}) } };
}

export const prevPeriod = (p: string): string => {
  const y = Number(p.slice(0, 4));
  const m = Number(p.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

export async function isClosed(period: string): Promise<boolean> {
  return (await db.query('SELECT 1 FROM month_closes WHERE period = $1', [period])).rowCount! > 0;
}

/** Закрывает месяц: расчёт каждого стримера записывается и дальше не пересчитывается. Бросает ошибку, если месяц уже закрыт. */
export async function closeMonth(period: string, byStaffId: number | null): Promise<{ streamers: number; total: number }> {
  const plan = await getPlan();
  const ids = (await db.query(`SELECT id FROM staff WHERE (role = 'streamer' OR streams) ORDER BY id`)).rows.map((r: any) => r.id as number);
  const calc: [number, KpiResult][] = [];
  for (const id of ids) calc.push([id, await kpiCompute(id, period, plan)]);
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const ins = await c.query('INSERT INTO month_closes (period, closed_by, plan) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING', [period, byStaffId, JSON.stringify(plan)]);
    if (!ins.rowCount) throw new Error('Месяц уже закрыт');
    for (const [id, k] of calc) await c.query('INSERT INTO kpi_closed (period, staff_id, data) VALUES ($1,$2,$3::jsonb)', [period, id, JSON.stringify(k)]);
    await c.query('DELETE FROM month_holds WHERE period = $1', [period]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  return { streamers: calc.length, total: r2(calc.reduce((a, [, k]) => a + k.total, 0)) };
}

/** Количество отчётов за месяц, которые ещё не проверены или не закончены */
export async function unreviewed(period: string): Promise<number> {
  return Number((await db.query(`SELECT count(*)::int AS n FROM shift_reports WHERE status IN ('pending','live') AND to_char(day, 'YYYY-MM') = $1`, [period])).rows[0].n);
}

/**
 * Автозакрытие прошлого месяца в 03:00 первого числа (по Киеву). Ждёт, пока проверены все отчёты месяца,
 * и не трогает месяц, который админ открыл заново.
 */
export async function autoCloseMonth(): Promise<string | null> {
  const t = (await db.query(`SELECT extract(day FROM now() AT TIME ZONE '${TZ}')::int AS d, extract(hour FROM now() AT TIME ZONE '${TZ}')::int AS h`)).rows[0];
  if (t.d === 1 && t.h < 3) return null;
  const prev = prevPeriod(await currentPeriod());
  if (await isClosed(prev)) return null;
  if ((await db.query('SELECT 1 FROM month_holds WHERE period = $1', [prev])).rowCount) return null;
  if (!(await db.query(`SELECT 1 FROM staff WHERE (role = 'streamer' OR streams) LIMIT 1`)).rowCount) return null;
  if ((await unreviewed(prev)) > 0) return null;
  try {
    const r = await closeMonth(prev, null);
    const chat = process.env.ALERT_TG_CHAT_ID || process.env.BACKUP_TG_CHAT_ID;
    if (chat && process.env.BOT_TOKEN) {
      const text = `🔒 Hunter: месяц ${prev} закрыт автоматически. Начислено стримерам $${r.total.toLocaleString('ru-RU')} (${r.streamers} чел.). Выплаты: Бухгалтерия → Выплаты и авансы.`;
      await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }) }).catch(() => {});
    }
    return prev;
  } catch {
    return null;
  }
}

type Pre = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
interface Helpers {
  need: (...roles: Role[]) => Pre;
  str: (v: unknown, max?: number) => string;
  num: (v: unknown) => number;
}

const IMG_OK = (b: Buffer) => b.length > 12 && ((b[0] === 0xff && b[1] === 0xd8) || b.subarray(1, 4).toString() === 'PNG' || (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP'));
const imgType = (b: Buffer) => (b[0] === 0xff ? 'image/jpeg' : b.subarray(1, 4).toString() === 'PNG' ? 'image/png' : 'image/webp');

export async function accountingRoutes(app: FastifyInstance, h: Helpers): Promise<void> {
  const { need, str } = h;
  // Смены, отчёты и свои цифры: стример или админ, который тоже стримит
  const streamBase = need('streamer', 'admin');
  const stream = async (req: FastifyRequest, reply: FastifyReply) => {
    await streamBase(req, reply);
    if (reply.sent) return;
    if (req.staff!.role === 'admin' && !req.staff!.streams) return reply.code(403).send({ error: 'Нет доступа' });
  };
  const admin = need('admin');
  const anyStaff = need();

  const fieldsDef = async (activeOnly = true) =>
    (await db.query(`SELECT id, name, kind, required, on_dashboard, active, sort FROM report_fields ${activeOnly ? 'WHERE active' : ''} ORDER BY sort, id`)).rows;

  // ----- Настройки KPI -----
  app.get('/kpi/settings', { preHandler: admin }, async () => getPlan());
  app.put('/kpi/settings', { preHandler: admin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const cur = await getPlan();
    const n = (v: unknown, d: number, min = 0, max = 1e6) => (Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : d);
    const next: KpiPlan = {
      hours: n(b.hours, cur.hours, 1, 744),
      shiftH: n(b.shiftH, cur.shiftH, 0.5, 24),
      leads: n(b.leads, cur.leads, 0, 10000),
      base: n(b.base, cur.base),
      baseLow: n(b.baseLow, cur.baseLow),
      price: n(b.price, cur.price),
      priceLow: n(b.priceLow, cur.priceLow),
      tiers: Array.isArray(b.tiers) ? b.tiers.map((t: any) => ({ from: n(t.from, 0), price: n(t.price, 0) })).filter((t: any) => t.from > 0) : cur.tiers,
      ftd: Array.isArray(b.ftd) ? b.ftd.map((t: any) => ({ over: n(t.over, 0), bonus: n(t.bonus, 0) })).filter((t: any) => t.over > 0) : cur.ftd,
      day: { count: n(b.day?.count, cur.day.count, 1, 100), min: n(b.day?.min, cur.day.min), bonus: n(b.day?.bonus, cur.day.bonus), cutoffH: n(b.day?.cutoffH, cur.day.cutoffH, 0, 12) },
      tol: n(b.tol, cur.tol, 0, 0.5),
      shiftTol: n(b.shiftTol, cur.shiftTol, 0, 0.5),
      advance: n(b.advance, cur.advance),
      goals: {
        ftd: n(b.goals?.ftd, cur.goals.ftd, 0, 1e6),
        ftdSum: n(b.goals?.ftdSum, cur.goals.ftdSum, 0, 1e9),
        deposits: n(b.goals?.deposits, cur.goals.deposits, 0, 1e9),
        commission: n(b.goals?.commission, cur.goals.commission, 0, 1e9),
        net: n(b.goals?.net, cur.goals.net, 0, 1e9),
      },
    };
    await db.query('UPDATE kpi_settings SET data = $1::jsonb WHERE id = 1', [JSON.stringify(next)]);
    return { ok: true, plan: next };
  });

  // ----- Поля формы отчёта -----
  app.get('/report-fields', { preHandler: anyStaff }, async (req) => fieldsDef(req.staff!.role !== 'admin'));
  app.put('/report-fields', { preHandler: admin }, async (req, reply) => {
    const list = (req.body as any)?.fields;
    if (!Array.isArray(list) || list.length > 30) return reply.code(400).send({ error: 'Неверный список полей' });
    const rows = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i] ?? {};
      const name = str(f.name, 60);
      if (!name) return reply.code(400).send({ error: 'У каждого поля нужно название' });
      const kind = ['number', 'text', 'link'].includes(f.kind) ? f.kind : 'number';
      rows.push({ id: Number(f.id) || null, name, kind, required: Boolean(f.required), on_dashboard: Boolean(f.on_dashboard) && kind === 'number', active: f.active !== false, sort: i + 1 });
    }
    const keep = rows.map((r) => r.id).filter(Boolean);
    // Удалённые из списка поля удаляем совсем: старые отчёты хранят значения вместе с названиями, они не пострадают
    await db.query(`DELETE FROM report_fields WHERE NOT (id = ANY($1::int[]))`, [keep]);
    for (const r of rows) {
      if (r.id) await db.query('UPDATE report_fields SET name=$2, kind=$3, required=$4, on_dashboard=$5, active=$6, sort=$7 WHERE id=$1', [r.id, r.name, r.kind, r.required, r.on_dashboard, r.active, r.sort]);
      else await db.query('INSERT INTO report_fields (name, kind, required, on_dashboard, active, sort) VALUES ($1,$2,$3,$4,$5,$6)', [r.name, r.kind, r.required, r.on_dashboard, r.active, r.sort]);
    }
    return { ok: true, fields: await fieldsDef(false) };
  });

  // ----- Смены (стример) -----
  const todayInfo = async (staffId: number) => {
    const t = (
      await db.query(
        `SELECT coalesce(sum(approved_min) FILTER (WHERE status = 'approved'), 0)::int AS approved,
                coalesce(sum(declared_min) FILTER (WHERE status = 'pending'), 0)::int AS pending
           FROM shift_reports WHERE staff_id = $1 AND day = (now() AT TIME ZONE '${TZ}')::date`,
        [staffId],
      )
    ).rows[0];
    return { approvedToday: t.approved as number, pendingToday: t.pending as number };
  };

  app.get('/shifts/current', { preHandler: stream }, async (req) => {
    const me = req.staff!;
    const live = (await db.query(`SELECT id, stream_url, started_at FROM shift_reports WHERE staff_id = $1 AND status = 'live' ORDER BY id DESC LIMIT 1`, [me.id])).rows[0] ?? null;
    const awaiting = (await db.query(`SELECT id, started_at, ended_at, to_char(day, 'YYYY-MM-DD') AS day FROM shift_reports WHERE staff_id = $1 AND status = 'await' ORDER BY id`, [me.id])).rows;
    return { live, awaiting, now: new Date().toISOString(), ...(await todayInfo(me.id)), fields: await fieldsDef(true) };
  });

  // Админ открывает смену за стримера (например, когда тот забыл): та же ссылка на эфир, дальше стример заканчивает смену сам
  app.post('/shifts/start-for', { preHandler: admin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const sid = Number(b.staff_id);
    const url = str(b.stream_url, 500).match(/https?:\/\/[^\s]+/i)?.[0] ?? '';
    if (!/^https?:\/\/[^\s]+\.[^\s]+$/i.test(url)) return reply.code(400).send({ error: 'Вставьте ссылку на эфир, например https://tiktok.com/@name/live' });
    const st = (await db.query(`SELECT id FROM staff WHERE id = $1 AND (role = 'streamer' OR streams) AND active`, [sid])).rows[0];
    if (!st) return reply.code(404).send({ error: 'Стример не найден' });
    if ((await db.query(`SELECT 1 FROM shift_reports WHERE staff_id = $1 AND status = 'live'`, [sid])).rowCount) return reply.code(409).send({ error: 'У этого стримера смена уже идёт' });
    const r = await db.query(`INSERT INTO shift_reports (staff_id, stream_url, day) VALUES ($1,$2,(now() AT TIME ZONE '${TZ}')::date) RETURNING id`, [sid, url]);
    return { ok: true, id: r.rows[0].id };
  });

  app.post('/shifts/start', { preHandler: stream }, async (req, reply) => {
    const me = req.staff!;
    // Из вставленного текста берём первую ссылку (TikTok и другие делятся текстом со ссылкой внутри)
    const url = str((req.body as any)?.stream_url, 500).match(/https?:\/\/[^\s]+/i)?.[0] ?? '';
    if (!/^https?:\/\/[^\s]+\.[^\s]+$/i.test(url)) return reply.code(400).send({ error: 'Вставьте ссылку на эфир, например https://tiktok.com/@name/live' });
    if ((await db.query(`SELECT 1 FROM shift_reports WHERE staff_id = $1 AND status = 'live'`, [me.id])).rowCount) return reply.code(409).send({ error: 'Смена уже идёт' });
    const r = await db.query(`INSERT INTO shift_reports (staff_id, stream_url, day) VALUES ($1,$2,(now() AT TIME ZONE '${TZ}')::date) RETURNING id`, [me.id, url]);
    return { ok: true, id: r.rows[0].id };
  });

  // Значения полей отчёта по текущим настройкам формы (requireAll: проверять обязательные поля)
  const parseFields = async (given: Record<string, unknown>, requireAll: boolean): Promise<{ error: string } | { fields: { name: string; kind: string; value: string | number | null }[] }> => {
    const defs = await fieldsDef(true);
    const fields: { name: string; kind: string; value: string | number | null }[] = [];
    for (const d of defs) {
      const raw = given[String(d.id)];
      const has = raw !== undefined && raw !== null && String(raw).trim() !== '';
      if (!has) {
        if (d.required && requireAll) return { error: `Заполните поле «${d.name}»` };
        fields.push({ name: d.name, kind: d.kind, value: null });
        continue;
      }
      if (d.kind === 'number') {
        const v = Number(String(raw).replace(',', '.'));
        if (!Number.isFinite(v) || v < 0 || v > 1e9) return { error: `Поле «${d.name}»: введите число` };
        fields.push({ name: d.name, kind: d.kind, value: v });
      } else if (d.kind === 'link') {
        const v = str(raw, 500);
        if (!/^https?:\/\/[^\s]+$/i.test(v)) return { error: `Поле «${d.name}»: вставьте ссылку` };
        fields.push({ name: d.name, kind: d.kind, value: v });
      } else fields.push({ name: d.name, kind: d.kind, value: str(raw, 500) });
    }
    return { fields };
  };

  // Админ добавляет отчёт за прошедший день: сразу проверенный и зачтённый (для переноса того, что было до запуска системы)
  app.post('/shifts/add', { preHandler: admin, bodyLimit: 9 * 1024 * 1024 }, async (req, reply) => {
    const me = req.staff!;
    const b = (req.body ?? {}) as Record<string, any>;
    const sid = Number(b.staff_id);
    if (!(await db.query(`SELECT 1 FROM staff WHERE id = $1 AND (role = 'streamer' OR streams)`, [sid])).rowCount) return reply.code(404).send({ error: 'Выберите стримера' });
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(b.start))) return reply.code(400).send({ error: 'Укажите дату и время начала эфира' });
    const mins = Math.trunc(Number(b.declared_min));
    if (!Number.isFinite(mins) || mins < 1 || mins > 720) return reply.code(400).send({ error: 'Время эфира от 1 минуты до 12 часов' });
    const t = (await db.query(`SELECT ($1::timestamp AT TIME ZONE '${TZ}') AS s, to_char($1::timestamp, 'YYYY-MM-DD') AS day, to_char($1::timestamp, 'YYYY-MM') AS pm`, [String(b.start)]).catch(() => null))?.rows[0];
    if (!t) return reply.code(400).send({ error: 'Укажите дату и время начала эфира' });
    if (+t.s > Date.now() + 10 * 60_000) return reply.code(400).send({ error: 'Начало эфира не может быть в будущем' });
    if (await isClosed(t.pm)) return reply.code(409).send({ error: 'Месяц закрыт. Откройте его заново в Бухгалтерии, добавьте отчёт и закройте месяц снова.' });
    const pf = await parseFields((b.fields ?? {}) as Record<string, unknown>, false);
    if ('error' in pf) return reply.code(400).send({ error: pf.error });
    let photo: Buffer | null = null;
    if (typeof b.screenshot === 'string' && b.screenshot) {
      photo = Buffer.from(b.screenshot.replace(/^data:[^,]*,/, ''), 'base64');
      if (!IMG_OK(photo)) return reply.code(400).send({ error: 'Скриншот должен быть картинкой JPG, PNG или WebP' });
      if (photo.length > 6 * 1024 * 1024) return reply.code(400).send({ error: 'Скриншот больше 6 МБ' });
    }
    await db.query(
      `INSERT INTO shift_reports (staff_id, status, started_at, ended_at, day, declared_min, approved_min, declared_start, fields, comment, screenshot, screenshot_type, reviewed_by, reviewed_at)
       VALUES ($1,'approved',$2::timestamptz,$2::timestamptz + make_interval(mins => $3::int),$4::date,$3::int,$3::int,$2::timestamptz,$5::jsonb,$6,$7,$8,$9,now())`,
      [sid, t.s, mins, t.day, JSON.stringify(pf.fields), str(b.comment, 1000) || null, photo, photo ? imgType(photo) : null, me.id],
    );
    return { ok: true };
  });

  // Админ закрывает смену стримера без отчёта: данные потом внесёт сам стример (у него это задача)
  app.post<{ Params: { id: string } }>('/shifts/:id/close', { preHandler: admin }, async (req, reply) => {
    const r = await db.query(`UPDATE shift_reports SET status = 'await', ended_at = now() WHERE id = $1 AND status = 'live'`, [Number(req.params.id)]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Идущая смена не найдена' });
    return { ok: true };
  });

  // Отчёт отправляет стример; админ может заполнить его за стримера (смена идёт или ждёт отчёта)
  app.post<{ Params: { id: string } }>('/shifts/:id/finish', { preHandler: need('streamer', 'admin'), bodyLimit: 9 * 1024 * 1024 }, async (req, reply) => {
    const me = req.staff!;
    const b = (req.body ?? {}) as Record<string, any>;
    const row = (await db.query(`SELECT id, started_at FROM shift_reports WHERE id = $1 AND ($2 OR staff_id = $3) AND status IN ('live','await')`, [Number(req.params.id), me.role === 'admin', me.id])).rows[0];
    if (!row) return reply.code(404).send({ error: 'Смена не найдена или уже отправлена' });
    const declared = Math.trunc(Number(b.declared_min));
    if (!Number.isFinite(declared) || declared < 1 || declared > 720) return reply.code(400).send({ error: 'Укажите время эфира в минутах, от 1 до 720' });
    // Начало эфира по Киеву, «ГГГГ-ММ-ДДTЧЧ:ММ»: не в будущем и не старше двух суток
    let declaredStart: Date | null = null;
    if (b.start !== undefined && b.start !== null && String(b.start) !== '') {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(b.start))) return reply.code(400).send({ error: 'Укажите дату и время начала эфира' });
      const t = (await db.query(`SELECT ($1::timestamp AT TIME ZONE '${TZ}') AS t`, [String(b.start)]).catch(() => null))?.rows[0]?.t as Date | undefined;
      if (!t || Number.isNaN(+t)) return reply.code(400).send({ error: 'Укажите дату и время начала эфира' });
      if (+t > Date.now() + 10 * 60_000) return reply.code(400).send({ error: 'Начало эфира не может быть в будущем' });
      if (+t < Date.now() - 48 * 3600_000) return reply.code(400).send({ error: 'Начало эфира не раньше двух суток назад' });
      declaredStart = t;
    }
    // Скриншот обязателен: только настоящие jpg/png/webp до 6 МБ
    const rawPhoto = b.screenshot;
    if (typeof rawPhoto !== 'string' || !rawPhoto) return reply.code(400).send({ error: 'Загрузите скриншот статистики эфира' });
    const photo = Buffer.from(rawPhoto.replace(/^data:[^,]*,/, ''), 'base64');
    if (!IMG_OK(photo)) return reply.code(400).send({ error: 'Скриншот должен быть картинкой JPG, PNG или WebP' });
    if (photo.length > 6 * 1024 * 1024) return reply.code(400).send({ error: 'Скриншот больше 6 МБ' });
    // Поля формы из текущих настроек, значения сохраняются вместе с названиями
    const pf = await parseFields((b.fields ?? {}) as Record<string, unknown>, true);
    if ('error' in pf) return reply.code(400).send({ error: pf.error });
    const fields = pf.fields;
    await db.query(
      `UPDATE shift_reports SET status = 'pending', ended_at = coalesce(ended_at, now()), declared_min = $2, fields = $3::jsonb, comment = $4, screenshot = $5, screenshot_type = $6, declared_start = $7 WHERE id = $1`,
      [row.id, declared, JSON.stringify(fields), str(b.comment, 1000) || null, photo, imgType(photo), declaredStart],
    );
    return { ok: true };
  });

  const reportRow = (r: any) => ({
    id: r.id,
    staff_id: r.staff_id,
    staff_name: r.staff_name,
    status: r.status,
    stream_url: r.stream_url,
    started_at: r.started_at,
    declared_start: r.declared_start,
    ended_at: r.ended_at,
    day: r.day,
    declared_min: r.declared_min,
    approved_min: r.approved_min,
    fields: r.fields,
    comment: r.comment,
    reject_reason: r.reject_reason,
    has_screenshot: r.has_screenshot,
  });
  const REPORT_COLS = `s.id, s.staff_id, st.name AS staff_name, s.status, s.stream_url, s.started_at, s.declared_start, s.ended_at, to_char(s.day, 'YYYY-MM-DD') AS day, s.declared_min, s.approved_min,
         s.fields, s.comment, s.reject_reason, (s.screenshot IS NOT NULL) AS has_screenshot`;

  // История отчётов стримера
  app.get('/shifts/mine', { preHandler: stream }, async (req) => {
    const me = req.staff!;
    const rows = (await db.query(`SELECT ${REPORT_COLS} FROM shift_reports s JOIN staff st ON st.id = s.staff_id WHERE s.staff_id = $1 AND s.status <> 'live' ORDER BY s.day DESC, s.id DESC LIMIT 200`, [me.id])).rows;
    return rows.map(reportRow);
  });

  // Удалить можно только то, что не принято
  app.delete<{ Params: { id: string } }>('/shifts/:id', { preHandler: anyStaff }, async (req, reply) => {
    const me = req.staff!;
    const row = (await db.query(`SELECT staff_id, status, to_char(day, 'YYYY-MM') AS pm FROM shift_reports WHERE id = $1`, [Number(req.params.id)])).rows[0];
    if (!row) return reply.code(404).send({ error: 'Отчёт не найден' });
    if (me.role !== 'admin') {
      if (row.staff_id !== me.id) return reply.code(404).send({ error: 'Отчёт не найден' });
      if (row.status === 'approved') return reply.code(409).send({ error: 'Принятый отчёт удалить нельзя' });
    } else if (row.status === 'approved' && (await isClosed(row.pm))) {
      return reply.code(409).send({ error: 'Месяц закрыт: принятый отчёт удалить нельзя. Откройте месяц заново в Бухгалтерии.' });
    }
    // Админ может удалить любой отчёт, в том числе принятый: время из расчёта уйдёт
    await db.query('DELETE FROM shift_reports WHERE id = $1', [Number(req.params.id)]);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/shifts/:id/screenshot', { preHandler: anyStaff }, async (req, reply) => {
    const me = req.staff!;
    const r = (await db.query('SELECT screenshot, screenshot_type, staff_id FROM shift_reports WHERE id = $1', [Number(req.params.id)])).rows[0];
    if (!r || !r.screenshot || (me.role !== 'admin' && r.staff_id !== me.id)) return reply.code(404).send({ error: 'Не найдено' });
    return reply.type(r.screenshot_type).header('Cache-Control', 'private, max-age=3600').send(r.screenshot);
  });

  // ----- Проверка отчётов (админ) -----
  app.get('/shifts/pending', { preHandler: admin }, async () => {
    const rows = (await db.query(`SELECT ${REPORT_COLS} FROM shift_reports s JOIN staff st ON st.id = s.staff_id WHERE s.status = 'pending' ORDER BY s.ended_at`)).rows;
    return rows.map(reportRow);
  });
  app.get<{ Querystring: { period?: string; staff?: string } }>('/shifts/all', { preHandler: admin }, async (req) => {
    const period = PERIOD.test(String(req.query.period)) ? String(req.query.period) : await currentPeriod();
    const sid = Number(req.query.staff) || null;
    const rows = (
      await db.query(`SELECT ${REPORT_COLS} FROM shift_reports s JOIN staff st ON st.id = s.staff_id WHERE s.status <> 'live' AND to_char(s.day, 'YYYY-MM') = $1 AND ($2::int IS NULL OR s.staff_id = $2) ORDER BY s.day DESC, s.id DESC LIMIT 500`, [period, sid])
    ).rows;
    return rows.map(reportRow);
  });
  app.post<{ Params: { id: string } }>('/shifts/:id/review', { preHandler: admin }, async (req, reply) => {
    const me = req.staff!;
    const b = (req.body ?? {}) as Record<string, any>;
    const cur = (await db.query(`SELECT id, declared_min, to_char(day, 'YYYY-MM') AS pm FROM shift_reports WHERE id = $1 AND status = 'pending'`, [Number(req.params.id)])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'Отчёт не найден или уже проверен' });
    if (await isClosed(cur.pm)) return reply.code(409).send({ error: 'Месяц отчёта закрыт. Откройте месяц заново в Бухгалтерии, проверьте отчёт и закройте месяц снова.' });
    if (b.action === 'approve') {
      const min = b.minutes === undefined ? cur.declared_min : Math.trunc(Number(b.minutes));
      if (!Number.isFinite(min) || min < 1 || min > 720) return reply.code(400).send({ error: 'Время от 1 до 720 минут' });
      await db.query(`UPDATE shift_reports SET status = 'approved', approved_min = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1`, [cur.id, min, me.id]);
    } else if (b.action === 'reject') {
      await db.query(`UPDATE shift_reports SET status = 'rejected', reject_reason = $2, reviewed_by = $3, reviewed_at = now() WHERE id = $1`, [cur.id, str(b.reason, 500) || null, me.id]);
    } else return reply.code(400).send({ error: 'Неизвестное действие' });
    return { ok: true };
  });

  // Сводка по полям формы для общего дашборда: суммы числовых полей по зачтённым отчётам
  app.get<{ Querystring: { period?: string; from?: string; to?: string } }>('/shifts/fieldstats', { preHandler: admin }, async (req) => {
    const period = PERIOD.test(String(req.query.period)) ? String(req.query.period) : await currentPeriod();
    const r = DATE.test(String(req.query.from)) && DATE.test(String(req.query.to)) ? { from: String(req.query.from), to: String(req.query.to) } : null;
    const defs = (await fieldsDef(true)).filter((d: any) => d.on_dashboard);
    const rows = (
      await db.query(
        r
          ? `SELECT s.staff_id, st.name, s.fields, s.approved_min FROM shift_reports s JOIN staff st ON st.id = s.staff_id WHERE s.status = 'approved' AND s.day BETWEEN $1::date AND $2::date`
          : `SELECT s.staff_id, st.name, s.fields, s.approved_min FROM shift_reports s JOIN staff st ON st.id = s.staff_id WHERE s.status = 'approved' AND to_char(s.day, 'YYYY-MM') = $1`,
        r ? [r.from, r.to] : [period],
      )
    ).rows;
    type Agg = { staff_id: number; name: string; reports: number; minutes: number; sums: Record<string, number> };
    const by = new Map<number, Agg>();
    for (const x of rows) {
      const e: Agg = by.get(x.staff_id) ?? { staff_id: x.staff_id, name: x.name, reports: 0, minutes: 0, sums: {} };
      e.reports++;
      e.minutes += x.approved_min ?? 0;
      for (const f of x.fields as any[]) if (f.kind === 'number' && typeof f.value === 'number') e.sums[f.name] = (e.sums[f.name] ?? 0) + f.value;
      by.set(x.staff_id, e);
    }
    return { period, from: r?.from ?? null, to: r?.to ?? null, fields: defs.map((d: any) => d.name), rows: [...by.values()] };
  });

  // ----- KPI: свой (стример) и сводка (админ) -----
  const advState = async (staffId: number, period: string, minTotal: number, plan: KpiPlan) => {
    const rq = (await db.query(`SELECT id, status, amount FROM advance_requests WHERE staff_id = $1 AND period = $2 AND status <> 'rejected'`, [staffId, period])).rows[0] ?? null;
    return { request: rq, can: !rq && minTotal >= plan.advance, amount: plan.advance };
  };

  app.get('/kpi/me', { preHandler: stream }, async (req) => {
    const me = req.staff!;
    const plan = await getPlan();
    const period = await currentPeriod();
    const k = await kpiFor(me.id, period, plan);
    const t = await todayInfo(me.id);
    const live = (await db.query(`SELECT id, stream_url, started_at FROM shift_reports WHERE staff_id = $1 AND status = 'live' LIMIT 1`, [me.id])).rows[0] ?? null;
    const unpaidShort = (await db.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, minutes FROM shift_shortfalls WHERE staff_id = $1 AND reason IS NULL ORDER BY day`, [me.id])).rows;
    // Стримеру показываем суммы бонусов и штрафов без комментариев
    const awaiting = (await db.query(`SELECT id, started_at, ended_at, to_char(day, 'YYYY-MM-DD') AS day FROM shift_reports WHERE staff_id = $1 AND status = 'await' ORDER BY id`, [me.id])).rows;
    return { plan, kpi: k, ...t, live, awaiting, now: new Date().toISOString(), advance: await advState(me.id, period, k.minTotal, plan), shortfalls: unpaidShort };
  });

  app.post('/advance/request', { preHandler: stream }, async (req, reply) => {
    const me = req.staff!;
    const plan = await getPlan();
    const period = await currentPeriod();
    const k = await kpiFor(me.id, period, plan);
    const st = await advState(me.id, period, k.minTotal, plan);
    if (st.request) return reply.code(409).send({ error: 'Аванс в этом месяце уже запрошен' });
    if (!st.can) return reply.code(400).send({ error: `Аванс откроется, когда по минимальным ставкам накопится $${plan.advance}` });
    await db.query('INSERT INTO advance_requests (staff_id, period, amount) VALUES ($1,$2,$3)', [me.id, period, plan.advance]);
    return { ok: true };
  });

  app.get<{ Querystring: { period?: string } }>('/kpi/summary', { preHandler: admin }, async (req) => {
    const period = PERIOD.test(String(req.query.period)) ? String(req.query.period) : await currentPeriod();
    const plan = await planFor(period);
    const staff = (await db.query(`SELECT id, name, login, active FROM staff WHERE (role = 'streamer' OR streams) ORDER BY active DESC, name`)).rows;
    const rows = [];
    for (const s of staff) rows.push({ staff: s, kpi: await kpiFor(s.id, period, plan) });
    return { plan, period, rows };
  });

  app.get<{ Params: { id: string }; Querystring: { period?: string } }>('/kpi/:id', { preHandler: admin }, async (req, reply) => {
    const period = PERIOD.test(String(req.query.period)) ? String(req.query.period) : await currentPeriod();
    const plan = await planFor(period);
    const id = Number(req.params.id);
    const s = (await db.query(`SELECT id, name, login FROM staff WHERE id = $1 AND (role = 'streamer' OR streams)`, [id])).rows[0];
    if (!s) return reply.code(404).send({ error: 'Стример не найден' });
    const adj = (await db.query(`SELECT a.id, a.kind, a.amount::float AS amount, a.comment, a.created_at, c.name AS by FROM staff_adjustments a LEFT JOIN staff c ON c.id = a.created_by WHERE a.staff_id = $1 AND a.period = $2 ORDER BY a.id`, [id, period])).rows;
    const pay = (await db.query(`SELECT id, kind, amount::float AS amount, note, created_at FROM staff_payouts WHERE staff_id = $1 AND period = $2 ORDER BY id`, [id, period])).rows;
    return { plan, period, staff: s, kpi: await kpiFor(id, period, plan), adjustments: adj, payouts: pay };
  });

  // ----- Закрытие месяца -----
  const monthInfo = async (period: string) => {
    const c = (await db.query(`SELECT m.closed_at, m.closed_by, s.name AS by FROM month_closes m LEFT JOIN staff s ON s.id = m.closed_by WHERE m.period = $1`, [period])).rows[0] ?? null;
    const cur = await currentPeriod();
    const hold = ((await db.query('SELECT 1 FROM month_holds WHERE period = $1', [period])).rowCount ?? 0) > 0;
    return { period, closed: !!c, closed_at: c?.closed_at ?? null, auto: c ? c.closed_by === null : false, by: c?.by ?? null, canClose: period < cur, current: period === cur, hold, pending: await unreviewed(period) };
  };
  app.get<{ Querystring: { period?: string } }>('/month/status', { preHandler: admin }, async (req) => {
    const period = PERIOD.test(String(req.query.period)) ? String(req.query.period) : await currentPeriod();
    return monthInfo(period);
  });
  app.post('/month/close', { preHandler: admin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const period = PERIOD.test(String(b.period)) ? String(b.period) : '';
    if (!period) return reply.code(400).send({ error: 'Укажите месяц' });
    const info = await monthInfo(period);
    if (!info.canClose) return reply.code(400).send({ error: 'Текущий месяц закрыть нельзя: он ещё идёт. Закроется автоматически в 03:00 первого числа.' });
    if (info.closed) return reply.code(409).send({ error: 'Месяц уже закрыт' });
    if (info.pending > 0 && !b.force) return reply.code(409).send({ error: `За месяц есть непроверенные отчёты: ${info.pending}. Проверьте их или закройте всё равно.`, pending: info.pending });
    try {
      const r = await closeMonth(period, req.staff!.id);
      return { ok: true, ...r };
    } catch (e: any) {
      return reply.code(409).send({ error: e?.message ?? 'Не удалось закрыть месяц' });
    }
  });
  app.post('/month/reopen', { preHandler: admin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const period = PERIOD.test(String(b.period)) ? String(b.period) : '';
    if (!period) return reply.code(400).send({ error: 'Укажите месяц' });
    const r = await db.query('DELETE FROM month_closes WHERE period = $1 RETURNING period', [period]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Месяц не закрыт' });
    // Чтобы автозакрытие не закрыло его снова, пока админ правит
    await db.query('INSERT INTO month_holds (period) VALUES ($1) ON CONFLICT DO NOTHING', [period]);
    return { ok: true };
  });

  // ----- Бонусы и штрафы (админ). Стример видит только суммы -----
  app.get<{ Querystring: { period?: string } }>('/adjustments', { preHandler: admin }, async (req) => {
    const period = PERIOD.test(String(req.query.period)) ? String(req.query.period) : await currentPeriod();
    return (
      await db.query(
        `SELECT a.id, a.staff_id, s.name AS staff_name, a.kind, a.amount::float AS amount, a.comment, a.created_at, to_char(a.created_at AT TIME ZONE '${TZ}', 'DD.MM') AS d
           FROM staff_adjustments a JOIN staff s ON s.id = a.staff_id WHERE a.period = $1 ORDER BY a.id DESC`,
        [period],
      )
    ).rows;
  });
  app.post('/adjustments', { preHandler: admin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const kind = b.kind === 'penalty' ? 'penalty' : b.kind === 'bonus' ? 'bonus' : '';
    const amount = Math.abs(Number(b.amount));
    if (!kind || !Number.isFinite(amount) || amount <= 0 || amount > 100000) return reply.code(400).send({ error: 'Укажите тип и сумму' });
    const sid = Number(b.staff_id);
    if (!(await db.query(`SELECT 1 FROM staff WHERE id = $1 AND (role = 'streamer' OR streams)`, [sid])).rowCount) return reply.code(404).send({ error: 'Стример не найден' });
    const period = PERIOD.test(String(b.period)) ? String(b.period) : await currentPeriod();
    if (await isClosed(period)) return reply.code(409).send({ error: 'Месяц закрыт, бонусы и штрафы менять нельзя. Откройте месяц заново в Бухгалтерии.' });
    await db.query('INSERT INTO staff_adjustments (staff_id, period, kind, amount, comment, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [sid, period, kind, amount, str(b.comment, 500) || null, req.staff!.id]);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/adjustments/:id', { preHandler: admin }, async (req, reply) => {
    const row = (await db.query('SELECT period FROM staff_adjustments WHERE id = $1', [Number(req.params.id)])).rows[0];
    if (row && (await isClosed(row.period))) return reply.code(409).send({ error: 'Месяц закрыт, бонусы и штрафы менять нельзя. Откройте месяц заново в Бухгалтерии.' });
    await db.query('DELETE FROM staff_adjustments WHERE id = $1', [Number(req.params.id)]);
    return { ok: true };
  });

  // ----- Выплаты и авансы (админ) -----
  app.get('/advances', { preHandler: admin }, async () =>
    (await db.query(`SELECT r.id, r.staff_id, s.name AS staff_name, r.period, r.amount::float AS amount, r.status, r.created_at FROM advance_requests r JOIN staff s ON s.id = r.staff_id WHERE r.status = 'pending' ORDER BY r.id`)).rows,
  );
  app.post<{ Params: { id: string } }>('/advances/:id/decide', { preHandler: admin }, async (req, reply) => {
    const me = req.staff!;
    const r = (await db.query(`SELECT id, staff_id, period, amount FROM advance_requests WHERE id = $1 AND status = 'pending'`, [Number(req.params.id)])).rows[0];
    if (!r) return reply.code(404).send({ error: 'Запрос не найден или уже решён' });
    const pay = (req.body as any)?.action === 'pay';
    if (pay) await db.query(`INSERT INTO staff_payouts (staff_id, period, kind, amount, note, created_by) VALUES ($1,$2,'advance',$3,'Аванс по запросу',$4)`, [r.staff_id, r.period, r.amount, me.id]);
    await db.query(`UPDATE advance_requests SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1`, [r.id, pay ? 'paid' : 'rejected', me.id]);
    return { ok: true };
  });
  // Запись выплаты вручную: итоговая или дополнительная (в том числе аванс больше обычного)
  app.post('/payouts', { preHandler: admin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const kind = ['advance', 'final', 'extra'].includes(b.kind) ? b.kind : 'final';
    const amount = Number(b.amount);
    const sid = Number(b.staff_id);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e6) return reply.code(400).send({ error: 'Укажите сумму выплаты' });
    if (!(await db.query(`SELECT 1 FROM staff WHERE id = $1 AND (role = 'streamer' OR streams)`, [sid])).rowCount) return reply.code(404).send({ error: 'Стример не найден' });
    const period = PERIOD.test(String(b.period)) ? String(b.period) : await currentPeriod();
    await db.query('INSERT INTO staff_payouts (staff_id, period, kind, amount, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [sid, period, kind, amount, str(b.note, 300) || null, req.staff!.id]);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/payouts/:id', { preHandler: admin }, async (req) => {
    await db.query('DELETE FROM staff_payouts WHERE id = $1', [Number(req.params.id)]);
    return { ok: true };
  });

  // ----- Невыполненный день: стример пишет причину -----
  // Дни без выполненной нормы создаются при открытии страницы (вчера и раньше в этом месяце), без отдельного планировщика
  app.post('/shortfalls/sync', { preHandler: stream }, async (req) => {
    const me = req.staff!;
    const plan = await getPlan();
    // Норма смены с допуском: например, 3 ч и допуск 15% значит, что 2 ч 33 мин и больше считается выполненным днём
    const need = Math.round(plan.shiftH * 60 * (1 - plan.shiftTol));
    // Прежние дни без причины, которые теперь укладываются в допуск, убираем
    await db.query(
      `DELETE FROM shift_shortfalls f WHERE f.staff_id = $1 AND f.reason IS NULL
         AND coalesce((SELECT sum(coalesce(approved_min, declared_min)) FROM shift_reports r WHERE r.staff_id = f.staff_id AND r.day = f.day AND r.status IN ('approved','pending')), 0) >= $2`,
      [me.id, need],
    );
    await db.query(
      `INSERT INTO shift_shortfalls (staff_id, day, minutes)
       SELECT $1, d::date, coalesce((SELECT sum(coalesce(approved_min, declared_min)) FROM shift_reports r WHERE r.staff_id = $1 AND r.day = d::date AND r.status IN ('approved','pending')), 0)
         FROM generate_series(date_trunc('month', now() AT TIME ZONE '${TZ}')::date,
                              ((now() AT TIME ZONE '${TZ}')::date - 1), interval '1 day') AS d
        WHERE d::date >= (SELECT (created_at AT TIME ZONE '${TZ}')::date FROM staff WHERE id = $1)
          AND coalesce((SELECT sum(coalesce(approved_min, declared_min)) FROM shift_reports r WHERE r.staff_id = $1 AND r.day = d::date AND r.status IN ('approved','pending')), 0) < $2
       ON CONFLICT (staff_id, day) DO NOTHING`,
      [me.id, need],
    );
    return { ok: true };
  });
  app.post('/shortfalls/reason', { preHandler: stream }, async (req, reply) => {
    const me = req.staff!;
    const b = (req.body ?? {}) as Record<string, any>;
    const reason = str(b.reason, 1000);
    if (reason.length < 3) return reply.code(400).send({ error: 'Напишите причину' });
    const r = await db.query(`UPDATE shift_shortfalls SET reason = $3, reason_at = now() WHERE staff_id = $1 AND day = $2::date AND reason IS NULL RETURNING id`, [me.id, String(b.day), reason]);
    if (!r.rowCount) return reply.code(404).send({ error: 'День не найден или причина уже указана' });
    return { ok: true };
  });
  app.get<{ Querystring: { period?: string } }>('/shortfalls', { preHandler: admin }, async (req) => {
    const period = PERIOD.test(String(req.query.period)) ? String(req.query.period) : await currentPeriod();
    return (
      await db.query(
        `SELECT f.id, f.staff_id, s.name AS staff_name, to_char(f.day, 'YYYY-MM-DD') AS day, f.minutes, f.reason, f.reason_at
           FROM shift_shortfalls f JOIN staff s ON s.id = f.staff_id WHERE to_char(f.day, 'YYYY-MM') = $1 ORDER BY f.day DESC, s.name`,
        [period],
      )
    ).rows;
  });

  // ----- Расходы компании (админ) -----
  app.get<{ Querystring: { period?: string } }>('/expenses', { preHandler: admin }, async (req) => {
    const period = PERIOD.test(String(req.query.period)) ? String(req.query.period) : await currentPeriod();
    const rows = (
      await db.query(
        `SELECT e.id, to_char(e.day, 'YYYY-MM-DD') AS day, e.amount::float AS amount, e.comment, c.name AS by
           FROM expenses e LEFT JOIN staff c ON c.id = e.created_by WHERE to_char(e.day, 'YYYY-MM') = $1 ORDER BY e.day DESC, e.id DESC`,
        [period],
      )
    ).rows;
    return { period, total: r2(rows.reduce((a: number, x: any) => a + x.amount, 0)), rows };
  });
  app.post('/expenses', { preHandler: admin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const amount = Math.abs(Number(String(b.amount).replace(',', '.')));
    const comment = str(b.comment, 300);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e7) return reply.code(400).send({ error: 'Укажите сумму расхода в долларах' });
    if (!comment) return reply.code(400).send({ error: 'Напишите, на что потрачено' });
    const day = DATE.test(String(b.day)) ? String(b.day) : (await db.query(`SELECT to_char((now() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
    await db.query('INSERT INTO expenses (day, amount, comment, created_by) VALUES ($1::date, $2, $3, $4)', [day, r2(amount), comment, req.staff!.id]);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/expenses/:id', { preHandler: admin }, async (req) => {
    await db.query('DELETE FROM expenses WHERE id = $1', [Number(req.params.id)]);
    return { ok: true };
  });

  // ----- Дашборд админа: план/факт, воронка, зарплаты, расходы, чистая прибыль -----
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const addDays = (s: string, n: number) => {
    const d = new Date(`${s}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return ymd(d);
  };
  const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  const monthLen = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
  const lastOfMonth = (m: string) => `${m}-${String(monthLen(m)).padStart(2, '0')}`;
  const nextMonth = (m: string) => {
    const y = Number(m.slice(0, 4));
    const mo = Number(m.slice(5, 7));
    return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  };

  type Agg = { reg: number; ftd: number; ftdSum: number; dep: number; depSum: number; comm: number };
  const emptyAgg = (): Agg => ({ reg: 0, ftd: 0, ftdSum: 0, dep: 0, depSum: 0, comm: 0 });
  const aggEvents = async (from: string, to: string): Promise<Map<number, Agg>> => {
    const rows = (
      await db.query(
        `SELECT d.owner_id, e.type, count(*)::int AS n, coalesce(sum(e.amount), 0)::float AS s
           FROM events e JOIN leads d ON d.tg_id = e.tg_id
          WHERE d.owner_id IS NOT NULL AND d.lead_role = 'lead' AND e.type IN ('reg','ftd','dep','comm')
            AND (e.created_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date
          GROUP BY d.owner_id, e.type`,
        [from, to],
      )
    ).rows as { owner_id: number; type: string; n: number; s: number }[];
    const m = new Map<number, Agg>();
    for (const r of rows) {
      const a = m.get(r.owner_id) ?? emptyAgg();
      if (r.type === 'reg') a.reg = r.n;
      else if (r.type === 'ftd') {
        a.ftd = r.n;
        a.ftdSum = r.s;
      } else if (r.type === 'dep') {
        a.dep = r.n;
        a.depSum = r.s;
      } else a.comm = r.s;
      m.set(r.owner_id, a);
    }
    return m;
  };

  app.get<{ Querystring: { from?: string; to?: string; all?: string } }>('/dashboard', { preHandler: admin }, async (req) => {
    const plan = await getPlan();
    const today = (await db.query(`SELECT to_char((now() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d`)).rows[0].d as string;
    const allTime = req.query.all === '1';
    let from: string;
    let to: string;
    if (allTime) {
      const first = (
        await db.query(
          `SELECT to_char(least(
              (SELECT min(created_at AT TIME ZONE '${TZ}') FROM events),
              (SELECT min(day)::timestamp FROM shift_reports),
              (SELECT min(day)::timestamp FROM expenses)), 'YYYY-MM-DD') AS d`,
        )
      ).rows[0].d as string | null;
      from = first ?? today;
      to = today;
    } else if (DATE.test(String(req.query.from)) && DATE.test(String(req.query.to))) {
      from = String(req.query.from);
      to = String(req.query.to);
      if (from > to) [from, to] = [to, from];
      if (daysBetween(from, to) > 800) from = addDays(to, -800);
    } else {
      const m = today.slice(0, 7);
      from = `${m}-01`;
      to = lastOfMonth(m);
    }
    const rangeDays = daysBetween(from, to) + 1;
    const ref = to > today ? today : to; // последний день периода, который уже наступил
    const refMonth = ref.slice(0, 7);

    // Месяцы периода и доля каждого: для зарплаты неполного месяца
    const months: { m: string; w: number }[] = [];
    for (let m = from.slice(0, 7); m <= to.slice(0, 7) && months.length < 36; m = nextMonth(m)) {
      const s = `${m}-01` > from ? `${m}-01` : from;
      const e = lastOfMonth(m) < to ? lastOfMonth(m) : to;
      months.push({ m, w: allTime ? 1 : (daysBetween(s, e) + 1) / monthLen(m) });
    }
    const goalFactor = allTime ? null : months.reduce((a, x) => a + x.w, 0);
    const g = plan.goals;
    const goals = goalFactor === null ? null : { ftd: g.ftd * goalFactor, ftdSum: g.ftdSum * goalFactor, deposits: g.deposits * goalFactor, commission: g.commission * goalFactor, net: g.net * goalFactor };
    // Где должны быть сегодня: доля прошедших дней периода
    const pace = ref >= to ? 1 : Math.max(0, Math.min(1, (daysBetween(from, ref) + 1) / rangeDays));

    const staffRows = (await db.query(`SELECT id, name, login, tg_username, active FROM staff WHERE (role = 'streamer' OR streams) ORDER BY id`)).rows as { id: number; name: string; login: string; tg_username: string | null; active: boolean }[];
    const ids = staffRows.map((s) => s.id);

    const evRange = await aggEvents(from, to);
    const refStart = `${refMonth}-01`;
    const evMonth = refStart === from && lastOfMonth(refMonth) === to ? evRange : await aggEvents(refStart, lastOfMonth(refMonth));

    const clicksRows = (
      allTime
        ? await db.query(`SELECT owner_id, coalesce(sum(clicks), 0)::int AS n FROM links GROUP BY owner_id`)
        : await db.query(
            `SELECT l.owner_id, count(*)::int AS n FROM link_clicks c JOIN links l ON l.id = c.link_id
              WHERE (c.at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date GROUP BY l.owner_id`,
            [from, to],
          )
    ).rows as { owner_id: number; n: number }[];
    const clicks = new Map(clicksRows.map((r) => [r.owner_id, r.n]));
    const clicksSince = (await db.query(`SELECT to_char(min(at AT TIME ZONE '${TZ}'), 'YYYY-MM-DD') AS d FROM link_clicks`)).rows[0].d as string | null;

    const nowIso = new Date().toISOString();
    const live = new Map(
      ((await db.query(`SELECT DISTINCT ON (staff_id) staff_id, id, started_at, stream_url FROM shift_reports WHERE status = 'live' ORDER BY staff_id, id DESC`)).rows as { staff_id: number; id: number; started_at: string; stream_url: string }[]).map((r) => [r.staff_id, r]),
    );
    const lastEnd = new Map(
      ((await db.query(`SELECT staff_id, max(ended_at) AS t FROM shift_reports WHERE status <> 'live' AND ended_at IS NOT NULL GROUP BY staff_id`)).rows as { staff_id: number; t: string }[]).map((r) => [r.staff_id, r.t]),
    );
    const lastLen = new Map(
      ((await db.query(`SELECT DISTINCT ON (staff_id) staff_id, coalesce(approved_min, declared_min) AS m FROM shift_reports WHERE status <> 'live' AND ended_at IS NOT NULL ORDER BY staff_id, ended_at DESC`)).rows as { staff_id: number; m: number | null }[]).map((r) => [r.staff_id, r.m]),
    );
    const todayMin = new Map(
      ((await db.query(`SELECT staff_id, coalesce(sum(coalesce(approved_min, declared_min)), 0)::int AS m FROM shift_reports WHERE status IN ('approved','pending') AND day = $1::date GROUP BY staff_id`, [today])).rows as { staff_id: number; m: number }[]).map((r) => [r.staff_id, r.m]),
    );
    const pendingBy = new Map(
      ((await db.query(`SELECT staff_id, count(*)::int AS n FROM shift_reports WHERE status = 'pending' GROUP BY staff_id`)).rows as { staff_id: number; n: number }[]).map((r) => [r.staff_id, r.n]),
    );
    const shortBy = new Map(
      ((await db.query(`SELECT staff_id, count(*)::int AS n FROM shift_shortfalls WHERE reason IS NULL AND to_char(day, 'YYYY-MM') = $1 GROUP BY staff_id`, [refMonth])).rows as { staff_id: number; n: number }[]).map((r) => [r.staff_id, r.n]),
    );
    const advances = (await db.query(`SELECT r.id, r.staff_id, s.name AS staff_name, r.amount::float AS amount FROM advance_requests r JOIN staff s ON s.id = r.staff_id WHERE r.status = 'pending' ORDER BY r.id`)).rows as { id: number; staff_id: number; staff_name: string; amount: number }[];

    // KPI: по месяцам периода (зарплата за период) и за «текущий» месяц (карточка стримера)
    const kpiCache = new Map<string, KpiResult>();
    const kpi = async (id: number, m: string) => {
      const key = `${id}:${m}`;
      let v = kpiCache.get(key);
      if (!v) {
        v = await kpiFor(id, m, plan);
        kpiCache.set(key, v);
      }
      return v;
    };
    const paceMin = plan.hours * 60 * (refMonth === today.slice(0, 7) ? Number(today.slice(8, 10)) / monthLen(refMonth) : 1);

    const out: any[] = [];
    let salaries = 0;
    for (const s of staffRows) {
      let salary = 0;
      let paid = 0;
      for (const mm of months) {
        const k = await kpi(s.id, mm.m);
        salary += k.fullTotal * mm.w;
        paid += k.paid * mm.w;
      }
      const a = evRange.get(s.id) ?? emptyAgg();
      const am = evMonth.get(s.id) ?? emptyAgg();
      const k = await kpi(s.id, refMonth);
      const lv = live.get(s.id) ?? null;
      const elapsed = lv ? Math.max(0, Math.floor((Date.now() - Date.parse(lv.started_at)) / 60000)) : 0;
      const doneToday = (todayMin.get(s.id) ?? 0) + elapsed;
      const has = a.reg || a.ftd || a.dep || a.comm || (clicks.get(s.id) ?? 0) || k.hoursMin || salary || lv;
      if (!s.active && !has) continue;
      salaries += salary;
      out.push({
        id: s.id,
        name: s.name,
        login: s.login,
        tg: s.tg_username,
        active: s.active,
        live: lv ? { id: lv.id, started_at: lv.started_at, stream_url: lv.stream_url, elapsed } : null,
        lastEnd: lastEnd.get(s.id) ?? null,
        lastMin: lastLen.get(s.id) ?? null,
        minLeft: lv ? Math.max(0, plan.shiftH * 60 - doneToday) : null,
        pending: pendingBy.get(s.id) ?? 0,
        range: { clicks: clicks.get(s.id) ?? 0, regs: a.reg, ftd: a.ftd, ftdSum: a.ftdSum, dep: a.dep, depSum: a.depSum, deposits: a.ftdSum + a.depSum, commission: a.comm, salary: r2(salary), paid: r2(paid) },
        month: {
          period: refMonth,
          ftd: am.ftd,
          ftdSum: am.ftdSum,
          deposits: am.ftdSum + am.depSum,
          commission: am.comm,
          hoursMin: k.hoursMin,
          planMin: k.planMin,
          shifts: k.shifts,
          baseMin: k.min.base,
          baseFull: k.full.base,
          leadsMin: k.min.leadsPay,
          leadsFull: k.full.leadsPay,
          ftdBonus: k.ftdBonus,
          dayBonus: k.dayBonus,
          bonus: k.adjBonus,
          penalty: k.adjPenalty,
          paid: k.paid,
          totalMin: k.minTotal,
          totalFull: k.fullTotal,
        },
      });
    }
    out.sort((x, y) => (y.live ? y.live.elapsed + 1e6 : 0) - (x.live ? x.live.elapsed + 1e6 : 0) || (Date.parse(y.lastEnd ?? '0') || 0) - (Date.parse(x.lastEnd ?? '0') || 0));

    const sum = (f: (x: any) => number) => out.reduce((acc, x) => acc + f(x), 0);
    const commission = sum((x) => x.range.commission);
    const expRows = (
      await db.query(`SELECT id, to_char(day, 'YYYY-MM-DD') AS day, amount::float AS amount, comment FROM expenses WHERE day BETWEEN $1::date AND $2::date ORDER BY day DESC, id DESC`, [from, to])
    ).rows as { id: number; day: string; amount: number; comment: string }[];
    const expenses = r2(expRows.reduce((acc, x) => acc + x.amount, 0));
    const net = r2(commission - salaries - expenses);

    const lagging = out
      .filter((x) => x.active && paceMin > 0 && x.month.hoursMin < paceMin)
      .map((x) => ({ id: x.id, name: x.name, hoursMin: x.month.hoursMin, level: x.month.hoursMin < paceMin * 0.85 ? 'bad' : 'warn' }))
      .sort((a, b) => a.hoursMin - b.hoursMin);

    return {
      now: nowIso,
      today,
      range: { from, to, days: rangeDays, all: allTime, ref, refMonth, whole: months.length === 1 && months[0].w === 1 },
      plan: { hours: plan.hours, shiftH: plan.shiftH, paceMin, planMin: plan.hours * 60, dayCount: plan.day.count },
      pace,
      goals,
      goalsMonthly: g,
      clicksSince,
      streamers: out,
      totals: {
        clicks: sum((x) => x.range.clicks),
        regs: sum((x) => x.range.regs),
        ftd: sum((x) => x.range.ftd),
        ftdSum: sum((x) => x.range.ftdSum),
        dep: sum((x) => x.range.dep),
        depSum: sum((x) => x.range.depSum),
        deposits: sum((x) => x.range.deposits),
        commission: r2(commission),
        salaries: r2(salaries),
        expenses,
        net,
        netPlanToDate: goals ? r2(goals.net * pace) : null,
      },
      expenses: expRows,
      tasks: {
        pending: out.filter((x) => x.pending).map((x) => ({ id: x.id, name: x.name, n: x.pending })),
        advances,
        lagging,
        shortfalls: out.filter((x) => shortBy.get(x.id)).map((x) => ({ id: x.id, name: x.name, n: shortBy.get(x.id) as number })),
        monthWaiting: await (async () => {
          const prev = prevPeriod(await currentPeriod());
          if (await isClosed(prev)) return null;
          const hold = ((await db.query('SELECT 1 FROM month_holds WHERE period = $1', [prev])).rowCount ?? 0) > 0;
          const pending = await unreviewed(prev);
          return pending > 0 || hold ? { period: prev, pending, hold } : null;
        })(),
        tasksDone: (await db.query(`SELECT t.id, s.name AS staff_name, t.title FROM staff_tasks t JOIN staff s ON s.id = t.staff_id WHERE t.status = 'done' ORDER BY t.done_at`)).rows,
        tasksOverdue: (await db.query(`SELECT t.id, s.name AS staff_name, t.title FROM staff_tasks t JOIN staff s ON s.id = t.staff_id WHERE t.status = 'open' AND t.due < $1::date ORDER BY t.due`, [today])).rows,
      },
    };
  });

  // ----- Задачи сотрудникам -----
  const taskRow = (r: any) => ({ id: r.id, staff_id: r.staff_id, staff_name: r.staff_name, title: r.title, details: r.details, due: r.due, status: r.status, created_at: r.created_at, done_at: r.done_at, accepted_at: r.accepted_at });
  const TASK_COLS = `t.id, t.staff_id, s.name AS staff_name, t.title, t.details, to_char(t.due, 'YYYY-MM-DD') AS due, t.status, t.created_at, t.done_at, t.accepted_at`;

  app.get<{ Querystring: { status?: string } }>('/tasks', { preHandler: admin }, async (req) => {
    const st = ['open', 'done', 'accepted'].includes(String(req.query.status)) ? String(req.query.status) : null;
    const rows = (
      await db.query(
        `SELECT ${TASK_COLS} FROM staff_tasks t JOIN staff s ON s.id = t.staff_id WHERE ($1::text IS NULL OR t.status = $1)
          ORDER BY (t.status = 'done') DESC, (t.status = 'open') DESC, t.due NULLS LAST, t.id DESC LIMIT 500`,
        [st],
      )
    ).rows;
    return rows.map(taskRow);
  });
  app.post('/tasks', { preHandler: admin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const title = str(b.title, 200);
    if (!title) return reply.code(400).send({ error: 'Напишите, что нужно сделать' });
    const details = str(b.details, 2000) || null;
    const due = DATE.test(String(b.due)) ? String(b.due) : null;
    let ids: number[] = [];
    if (b.all_streamers) ids = (await db.query(`SELECT id FROM staff WHERE (role = 'streamer' OR streams) AND active`)).rows.map((r: any) => r.id);
    else if (Array.isArray(b.staff_ids)) ids = b.staff_ids.map(Number).filter((n: number) => Number.isInteger(n) && n > 0);
    if (!ids.length) return reply.code(400).send({ error: 'Выберите, кому поставить задачу' });
    const ok = (await db.query(`SELECT id FROM staff WHERE id = ANY($1::int[]) AND active AND role <> 'admin'`, [ids])).rows.map((r: any) => r.id);
    if (!ok.length) return reply.code(404).send({ error: 'Сотрудники не найдены' });
    for (const id of ok) await db.query('INSERT INTO staff_tasks (staff_id, title, details, due, created_by) VALUES ($1,$2,$3,$4::date,$5)', [id, title, details, due, req.staff!.id]);
    return { ok: true, count: ok.length };
  });
  app.patch<{ Params: { id: string } }>('/tasks/:id', { preHandler: admin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const id = Number(req.params.id);
    if (b.action === 'accept') {
      const r = await db.query(`UPDATE staff_tasks SET status = 'accepted', accepted_at = now(), done_at = coalesce(done_at, now()) WHERE id = $1 RETURNING id`, [id]);
      if (!r.rowCount) return reply.code(404).send({ error: 'Задача не найдена' });
    } else if (b.action === 'reopen') {
      const r = await db.query(`UPDATE staff_tasks SET status = 'open', done_at = NULL, accepted_at = NULL WHERE id = $1 RETURNING id`, [id]);
      if (!r.rowCount) return reply.code(404).send({ error: 'Задача не найдена' });
    } else return reply.code(400).send({ error: 'Неизвестное действие' });
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/tasks/:id', { preHandler: admin }, async (req) => {
    await db.query('DELETE FROM staff_tasks WHERE id = $1', [Number(req.params.id)]);
    return { ok: true };
  });
  // Свои задачи: открытые и ждущие принятия
  app.get<{ Querystring: { all?: string } }>('/tasks/mine', { preHandler: anyStaff }, async (req) => {
    const withAccepted = req.query.all === '1';
    const rows = (
      await db.query(
        `SELECT ${TASK_COLS} FROM staff_tasks t JOIN staff s ON s.id = t.staff_id WHERE t.staff_id = $1 AND ($2::boolean OR t.status <> 'accepted')
          ORDER BY (t.status = 'open') DESC, (t.status = 'done') DESC, t.due NULLS LAST, t.id DESC LIMIT 60`,
        [req.staff!.id, withAccepted],
      )
    ).rows;
    return rows.map(taskRow);
  });
  app.post<{ Params: { id: string } }>('/tasks/:id/done', { preHandler: anyStaff }, async (req, reply) => {
    const r = await db.query(`UPDATE staff_tasks SET status = 'done', done_at = now() WHERE id = $1 AND staff_id = $2 AND status = 'open' RETURNING id`, [Number(req.params.id), req.staff!.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Задача не найдена или уже отмечена' });
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/tasks/:id/undo', { preHandler: anyStaff }, async (req, reply) => {
    const r = await db.query(`UPDATE staff_tasks SET status = 'open', done_at = NULL WHERE id = $1 AND staff_id = $2 AND status = 'done' RETURNING id`, [Number(req.params.id), req.staff!.id]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Задачу уже приняли или она не отмечена' });
    return { ok: true };
  });

  // ----- Дашборд стримера: только его данные и список коллег без денег -----
  app.get<{ Querystring: { from?: string; to?: string } }>('/my/dashboard', { preHandler: stream }, async (req) => {
    const me = req.staff!;
    const plan = await getPlan();
    const today = (await db.query(`SELECT to_char((now() AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS d`)).rows[0].d as string;
    let from: string;
    let to: string;
    if (DATE.test(String(req.query.from)) && DATE.test(String(req.query.to))) {
      from = String(req.query.from);
      to = String(req.query.to);
      if (from > to) [from, to] = [to, from];
      if (daysBetween(from, to) > 800) from = addDays(to, -800);
    } else {
      from = `${today.slice(0, 7)}-01`;
      to = lastOfMonth(today.slice(0, 7));
    }
    const ref = to > today ? today : to;
    const refMonth = ref.slice(0, 7);
    const curMonth = today.slice(0, 7);
    const k = await kpiFor(me.id, refMonth, plan);
    const planMin = plan.hours * 60;
    const paceMin = planMin * (refMonth === curMonth ? Number(today.slice(8, 10)) / monthLen(refMonth) : 1);
    const pace = refMonth === curMonth ? Number(today.slice(8, 10)) / monthLen(refMonth) : 1;

    const ev = (await aggEvents(from, to)).get(me.id) ?? emptyAgg();
    const clicks = Number(
      (await db.query(`SELECT count(*)::int AS n FROM link_clicks c JOIN links l ON l.id = c.link_id WHERE l.owner_id = $1 AND (c.at AT TIME ZONE '${TZ}')::date BETWEEN $2::date AND $3::date`, [me.id, from, to])).rows[0].n,
    );
    const clicksSince = (await db.query(`SELECT to_char(min(at AT TIME ZONE '${TZ}'), 'YYYY-MM-DD') AS d FROM link_clicks`)).rows[0].d as string | null;
    const byStatus: Record<string, number> = {};
    for (const r of (await db.query(`SELECT status, count(*)::int AS n FROM leads WHERE owner_id = $1 AND (created_at AT TIME ZONE '${TZ}')::date BETWEEN $2::date AND $3::date GROUP BY status`, [me.id, from, to])).rows) byStatus[r.status] = r.n;

    const live = (await db.query(`SELECT id, stream_url, started_at FROM shift_reports WHERE staff_id = $1 AND status = 'live' ORDER BY id DESC LIMIT 1`, [me.id])).rows[0] ?? null;
    const t = await todayInfo(me.id);
    const elapsed = live ? Math.max(0, Math.floor((Date.now() - Date.parse(live.started_at)) / 60000)) : 0;
    const todayMin = t.approvedToday + t.pendingToday + elapsed;
    const shiftMin = plan.shiftH * 60;

    // Коллеги: имена, часы за месяц и эфир, без денег и без карточек
    const colRows = (await db.query(`SELECT id, name FROM staff WHERE (role = 'streamer' OR streams) AND active AND id <> $1 ORDER BY id`, [me.id])).rows as { id: number; name: string }[];
    const liveBy = new Map(((await db.query(`SELECT DISTINCT ON (staff_id) staff_id, started_at, stream_url FROM shift_reports WHERE status = 'live' ORDER BY staff_id, id DESC`)).rows as any[]).map((r) => [r.staff_id, r]));
    const lastBy = new Map(((await db.query(`SELECT DISTINCT ON (staff_id) staff_id, ended_at, coalesce(approved_min, declared_min) AS m FROM shift_reports WHERE status <> 'live' AND ended_at IS NOT NULL ORDER BY staff_id, ended_at DESC`)).rows as any[]).map((r) => [r.staff_id, r]));
    const hoursBy = new Map(((await db.query(`SELECT staff_id, coalesce(sum(approved_min), 0)::int AS m FROM shift_reports WHERE status = 'approved' AND to_char(day, 'YYYY-MM') = $1 GROUP BY staff_id`, [refMonth])).rows as any[]).map((r) => [r.staff_id, r.m]));
    // FTD за месяц по стримерам (только количество, без денег)
    const ftdBy = new Map(
      ((await db.query(`SELECT d.owner_id, count(*)::int AS n FROM events e JOIN leads d ON d.tg_id = e.tg_id WHERE e.type = 'ftd' AND d.lead_role = 'lead' AND d.owner_id IS NOT NULL AND to_char(e.created_at AT TIME ZONE '${TZ}', 'YYYY-MM') = $1 GROUP BY d.owner_id`, [refMonth])).rows as any[]).map((r) => [r.owner_id, r.n]),
    );
    const teamDeposits = Number(
      (await db.query(`SELECT coalesce(sum(e.amount), 0)::float AS s FROM events e JOIN leads d ON d.tg_id = e.tg_id WHERE e.type IN ('ftd','dep') AND d.lead_role = 'lead' AND d.owner_id IS NOT NULL AND to_char(e.created_at AT TIME ZONE '${TZ}', 'YYYY-MM') = $1`, [refMonth])).rows[0].s,
    );
    const colleagues = colRows
      .map((c) => {
        const lv = liveBy.get(c.id) ?? null;
        const ls = lastBy.get(c.id) ?? null;
        return { id: c.id, name: c.name, hoursMin: hoursBy.get(c.id) ?? 0, ftd: ftdBy.get(c.id) ?? 0, live: lv ? { started_at: lv.started_at, stream_url: lv.stream_url } : null, lastEnd: ls?.ended_at ?? null, lastMin: ls?.m ?? null };
      })
      .sort((a, b) => (b.live ? Date.now() - Date.parse(b.live.started_at) + 1e12 : 0) - (a.live ? Date.now() - Date.parse(a.live.started_at) + 1e12 : 0) || (Date.parse(b.lastEnd ?? '0') || 0) - (Date.parse(a.lastEnd ?? '0') || 0));

    const adv = await advState(me.id, curMonth, (await kpiFor(me.id, curMonth, plan)).minTotal, plan);

    // Задачи: от админа и то, что требует внимания по смене
    const tasks = (await db.query(`SELECT ${TASK_COLS} FROM staff_tasks t JOIN staff s ON s.id = t.staff_id WHERE t.staff_id = $1 AND t.status <> 'accepted' ORDER BY (t.status = 'open') DESC, t.due NULLS LAST, t.id DESC`, [me.id])).rows.map(taskRow);
    const rejected = (await db.query(`SELECT id, to_char(day, 'YYYY-MM-DD') AS day, reject_reason FROM shift_reports WHERE staff_id = $1 AND status = 'rejected' AND day >= (now() AT TIME ZONE '${TZ}')::date - 14 ORDER BY day DESC`, [me.id])).rows;
    const short = (await db.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, minutes FROM shift_shortfalls WHERE staff_id = $1 AND reason IS NULL ORDER BY day`, [me.id])).rows;

    const defs = ((await fieldsDef(true)) as any[]).filter((d) => d.on_dashboard);
    const last = (
      await db.query(
        `SELECT id, to_char(day, 'YYYY-MM-DD') AS day, status, coalesce(approved_min, declared_min) AS minutes, fields, reject_reason
           FROM shift_reports WHERE staff_id = $1 AND status <> 'live' AND day BETWEEN $2::date AND $3::date ORDER BY day DESC, id DESC LIMIT 8`,
        [me.id, from, to],
      )
    ).rows;

    return {
      now: new Date().toISOString(),
      today,
      range: { from, to, ref, refMonth, whole: from.endsWith('-01') && to === lastOfMonth(from.slice(0, 7)) },
      plan: { hours: plan.hours, shiftH: plan.shiftH, leads: plan.leads, planMin, paceMin, pace, dayCount: plan.day.count, advance: plan.advance },
      me: { id: me.id, name: me.name },
      month: { period: refMonth, hoursMin: k.hoursMin, shifts: k.shifts, planShifts: plan.hours / plan.shiftH, ftd: k.ftdCount },
      today_: { minutes: todayMin, shiftMin, minLeft: Math.max(0, shiftMin - todayMin), live },
      funnel: { clicks, regs: ev.reg, ftd: ev.ftd, dep: ev.dep },
      clicksSince,
      byStatus,
      colleagues,
      // Общий план команды (как кольца у админа): депозиты и FTD всей команды за месяц против целей компании
      team: { ftd: k.ftdCount + colRows.reduce((a, c) => a + (ftdBy.get(c.id) ?? 0), 0), ftdGoal: plan.goals.ftd, deposits: teamDeposits, depositsGoal: plan.goals.deposits },
      salary: {
        period: refMonth,
        base: [k.min.base, k.full.base],
        leads: [k.min.leadsPay, k.full.leadsPay],
        leadsN: k.ftdCount,
        shifts: k.shifts,
        ftdBonus: k.ftdBonus,
        dayBonus: k.dayBonus,
        bonus: k.adjBonus,
        penalty: k.adjPenalty,
        paid: k.paid,
        totalMin: k.minTotal,
        totalFull: k.fullTotal,
        advance: refMonth === curMonth ? adv : null,
        minForAdvance: plan.advance,
      },
      tasks,
      alerts: { rejected, shortfalls: short, awaiting: (await db.query(`SELECT id, started_at, ended_at, to_char(day, 'YYYY-MM-DD') AS day FROM shift_reports WHERE staff_id = $1 AND status = 'await' ORDER BY id`, [me.id])).rows },
      fields: defs.map((d) => d.name),
      last: last.map((r: any) => ({ id: r.id, day: r.day, status: r.status, minutes: r.minutes, reject_reason: r.reject_reason, values: Object.fromEntries((r.fields as any[]).filter((f) => f.kind === 'number').map((f) => [f.name, f.value])) })),
    };
  });
}
