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
  advance: number; // максимальный аванс
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
  advance: 200,
};

const TZ = 'Europe/Kyiv';
const r2 = (n: number) => Math.round(n * 100) / 100;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function getPlan(): Promise<KpiPlan> {
  const row = (await db.query('SELECT data FROM kpi_settings WHERE id = 1')).rows[0];
  const d = (row?.data ?? {}) as Partial<KpiPlan>;
  return { ...DEFAULT_PLAN, ...d, day: { ...DEFAULT_PLAN.day, ...(d.day ?? {}) } };
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
export async function kpiFor(staffId: number, period: string, plan: KpiPlan): Promise<KpiResult> {
  const hoursMin = Number(
    (await db.query(`SELECT coalesce(sum(approved_min), 0)::int AS m FROM shift_reports WHERE staff_id = $1 AND status = 'approved' AND to_char(day, 'YYYY-MM') = $2`, [staffId, period])).rows[0].m,
  );
  const ftd = (
    await db.query(
      `SELECT coalesce(e.amount, 0)::float AS amount,
              to_char((e.created_at AT TIME ZONE '${TZ}') - ($3 || ' hours')::interval, 'YYYY-MM-DD') AS dkey
         FROM events e JOIN leads d ON d.tg_id = e.tg_id
        WHERE d.owner_id = $1 AND e.type = 'ftd' AND to_char(e.created_at AT TIME ZONE '${TZ}', 'YYYY-MM') = $2`,
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
  const stream = need('streamer');
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
      advance: n(b.advance, cur.advance),
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
    // Удалённые из списка поля просто скрываем: старые отчёты хранят значения вместе с названиями
    await db.query(`UPDATE report_fields SET active = FALSE WHERE NOT (id = ANY($1::int[]))`, [keep]);
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
    return { live, now: new Date().toISOString(), ...(await todayInfo(me.id)), fields: await fieldsDef(true) };
  });

  app.post('/shifts/start', { preHandler: stream }, async (req, reply) => {
    const me = req.staff!;
    const url = str((req.body as any)?.stream_url, 500);
    if (!/^https?:\/\/[^\s]+\.[^\s]+$/i.test(url)) return reply.code(400).send({ error: 'Вставьте ссылку на эфир, например https://tiktok.com/@name/live' });
    if ((await db.query(`SELECT 1 FROM shift_reports WHERE staff_id = $1 AND status = 'live'`, [me.id])).rowCount) return reply.code(409).send({ error: 'Смена уже идёт' });
    const r = await db.query(`INSERT INTO shift_reports (staff_id, stream_url, day) VALUES ($1,$2,(now() AT TIME ZONE '${TZ}')::date) RETURNING id`, [me.id, url]);
    return { ok: true, id: r.rows[0].id };
  });

  app.post<{ Params: { id: string } }>('/shifts/:id/finish', { preHandler: stream, bodyLimit: 9 * 1024 * 1024 }, async (req, reply) => {
    const me = req.staff!;
    const b = (req.body ?? {}) as Record<string, any>;
    const row = (await db.query(`SELECT id, started_at FROM shift_reports WHERE id = $1 AND staff_id = $2 AND status = 'live'`, [Number(req.params.id), me.id])).rows[0];
    if (!row) return reply.code(404).send({ error: 'Смена не найдена или уже отправлена' });
    const declared = Math.trunc(Number(b.declared_min));
    if (!Number.isFinite(declared) || declared < 1 || declared > 720) return reply.code(400).send({ error: 'Укажите время эфира в минутах, от 1 до 720' });
    // Скриншот обязателен: только настоящие jpg/png/webp до 6 МБ
    const rawPhoto = b.screenshot;
    if (typeof rawPhoto !== 'string' || !rawPhoto) return reply.code(400).send({ error: 'Загрузите скриншот статистики эфира' });
    const photo = Buffer.from(rawPhoto.replace(/^data:[^,]*,/, ''), 'base64');
    if (!IMG_OK(photo)) return reply.code(400).send({ error: 'Скриншот должен быть картинкой JPG, PNG или WebP' });
    if (photo.length > 6 * 1024 * 1024) return reply.code(400).send({ error: 'Скриншот больше 6 МБ' });
    // Поля формы из текущих настроек, значения сохраняются вместе с названиями
    const defs = await fieldsDef(true);
    const given = (b.fields ?? {}) as Record<string, unknown>;
    const fields: { name: string; kind: string; value: string | number | null }[] = [];
    for (const d of defs) {
      const raw = given[String(d.id)];
      const has = raw !== undefined && raw !== null && String(raw).trim() !== '';
      if (!has) {
        if (d.required) return reply.code(400).send({ error: `Заполните поле «${d.name}»` });
        fields.push({ name: d.name, kind: d.kind, value: null });
        continue;
      }
      if (d.kind === 'number') {
        const v = Number(String(raw).replace(',', '.'));
        if (!Number.isFinite(v) || v < 0 || v > 1e9) return reply.code(400).send({ error: `Поле «${d.name}»: введите число` });
        fields.push({ name: d.name, kind: d.kind, value: v });
      } else if (d.kind === 'link') {
        const v = str(raw, 500);
        if (!/^https?:\/\/[^\s]+$/i.test(v)) return reply.code(400).send({ error: `Поле «${d.name}»: вставьте ссылку` });
        fields.push({ name: d.name, kind: d.kind, value: v });
      } else fields.push({ name: d.name, kind: d.kind, value: str(raw, 500) });
    }
    await db.query(
      `UPDATE shift_reports SET status = 'pending', ended_at = now(), declared_min = $2, fields = $3::jsonb, comment = $4, screenshot = $5, screenshot_type = $6 WHERE id = $1`,
      [row.id, declared, JSON.stringify(fields), str(b.comment, 1000) || null, photo, imgType(photo)],
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
    ended_at: r.ended_at,
    day: r.day,
    declared_min: r.declared_min,
    approved_min: r.approved_min,
    fields: r.fields,
    comment: r.comment,
    reject_reason: r.reject_reason,
    has_screenshot: r.has_screenshot,
  });
  const REPORT_COLS = `s.id, s.staff_id, st.name AS staff_name, s.status, s.stream_url, s.started_at, s.ended_at, to_char(s.day, 'YYYY-MM-DD') AS day, s.declared_min, s.approved_min,
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
    const r = await db.query(`DELETE FROM shift_reports WHERE id = $1 AND status <> 'approved' AND (staff_id = $2 OR $3) RETURNING id`, [Number(req.params.id), me.id, me.role === 'admin']);
    if (!r.rowCount) return reply.code(409).send({ error: 'Принятый отчёт удалить нельзя' });
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
    const cur = (await db.query(`SELECT id, declared_min FROM shift_reports WHERE id = $1 AND status = 'pending'`, [Number(req.params.id)])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'Отчёт не найден или уже проверен' });
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
  app.get<{ Querystring: { period?: string } }>('/shifts/fieldstats', { preHandler: admin }, async (req) => {
    const period = PERIOD.test(String(req.query.period)) ? String(req.query.period) : await currentPeriod();
    const defs = (await fieldsDef(true)).filter((d: any) => d.on_dashboard);
    const rows = (await db.query(`SELECT s.staff_id, st.name, s.fields, s.approved_min FROM shift_reports s JOIN staff st ON st.id = s.staff_id WHERE s.status = 'approved' AND to_char(s.day, 'YYYY-MM') = $1`, [period])).rows;
    type Agg = { staff_id: number; name: string; reports: number; minutes: number; sums: Record<string, number> };
    const by = new Map<number, Agg>();
    for (const r of rows) {
      const e: Agg = by.get(r.staff_id) ?? { staff_id: r.staff_id, name: r.name, reports: 0, minutes: 0, sums: {} };
      e.reports++;
      e.minutes += r.approved_min ?? 0;
      for (const f of r.fields as any[]) if (f.kind === 'number' && typeof f.value === 'number') e.sums[f.name] = (e.sums[f.name] ?? 0) + f.value;
      by.set(r.staff_id, e);
    }
    return { period, fields: defs.map((d: any) => d.name), rows: [...by.values()] };
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
    return { plan, kpi: k, ...t, live, now: new Date().toISOString(), advance: await advState(me.id, period, k.minTotal, plan), shortfalls: unpaidShort };
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
    const plan = await getPlan();
    const period = PERIOD.test(String(req.query.period)) ? String(req.query.period) : await currentPeriod();
    const staff = (await db.query(`SELECT id, name, login, active FROM staff WHERE role = 'streamer' ORDER BY active DESC, name`)).rows;
    const rows = [];
    for (const s of staff) rows.push({ staff: s, kpi: await kpiFor(s.id, period, plan) });
    return { plan, period, rows };
  });

  app.get<{ Params: { id: string }; Querystring: { period?: string } }>('/kpi/:id', { preHandler: admin }, async (req, reply) => {
    const plan = await getPlan();
    const period = PERIOD.test(String(req.query.period)) ? String(req.query.period) : await currentPeriod();
    const id = Number(req.params.id);
    const s = (await db.query(`SELECT id, name, login FROM staff WHERE id = $1 AND role = 'streamer'`, [id])).rows[0];
    if (!s) return reply.code(404).send({ error: 'Стример не найден' });
    const adj = (await db.query(`SELECT a.id, a.kind, a.amount::float AS amount, a.comment, a.created_at, c.name AS by FROM staff_adjustments a LEFT JOIN staff c ON c.id = a.created_by WHERE a.staff_id = $1 AND a.period = $2 ORDER BY a.id`, [id, period])).rows;
    const pay = (await db.query(`SELECT id, kind, amount::float AS amount, note, created_at FROM staff_payouts WHERE staff_id = $1 AND period = $2 ORDER BY id`, [id, period])).rows;
    return { plan, period, staff: s, kpi: await kpiFor(id, period, plan), adjustments: adj, payouts: pay };
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
    if (!(await db.query(`SELECT 1 FROM staff WHERE id = $1 AND role = 'streamer'`, [sid])).rowCount) return reply.code(404).send({ error: 'Стример не найден' });
    const period = PERIOD.test(String(b.period)) ? String(b.period) : await currentPeriod();
    await db.query('INSERT INTO staff_adjustments (staff_id, period, kind, amount, comment, created_by) VALUES ($1,$2,$3,$4,$5,$6)', [sid, period, kind, amount, str(b.comment, 500) || null, req.staff!.id]);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/adjustments/:id', { preHandler: admin }, async (req) => {
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
    if (!(await db.query(`SELECT 1 FROM staff WHERE id = $1 AND role = 'streamer'`, [sid])).rowCount) return reply.code(404).send({ error: 'Стример не найден' });
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
    const need = plan.shiftH * 60;
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
}
