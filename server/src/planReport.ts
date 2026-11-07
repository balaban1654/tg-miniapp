import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { db } from './db.js';
import { COOKIE } from './auth.js';

/** Ежедневный «План / факт» в общую группу: в 12:00 по Киеву. Группа задаётся командой /plan_here.
 *  Цифры берём из того же /dashboard, что видит админ в Office (тестовые аккаунты там уже исключены). */
const TZ = 'Europe/Kyiv';
const HOUR = 12;
const TAG = '@AccorD0000';
const MG = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

let app: FastifyInstance | null = null;
export function setPlanReportApp(a: FastifyInstance): void { app = a; }

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const grp = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const usd = (n: number) => (n < 0 ? '−$' : '$') + grp(Math.abs(n));
const n1 = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',');
const pc = (x: number) => Math.round(x * 100) + '%';

async function setting(k: string): Promise<string> {
  return ((await db.query('SELECT value FROM app_settings WHERE key = $1', [k])).rows[0]?.value as string | undefined) ?? '';
}
async function save(k: string, v: string): Promise<void> {
  await db.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [k, v]);
}

/** Дашборд за текущий месяц глазами админа: временная сессия на минуту, запрос внутри сервера, сессия удаляется */
async function dashboard(): Promise<any> {
  if (!app) throw new Error('сервер ещё не запущен');
  const adm = (await db.query(`SELECT id FROM staff WHERE role = 'admin' AND active AND deleted_at IS NULL ORDER BY id LIMIT 1`)).rows[0];
  if (!adm) throw new Error('нет активного админа');
  const token = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(token).digest('hex');
  await db.query(`INSERT INTO sessions (token_hash, staff_id, expires_at) VALUES ($1, $2, now() + interval '2 minutes')`, [hash, adm.id]);
  try {
    const r = await app.inject({ method: 'GET', url: '/api/office/dashboard', cookies: { [COOKIE]: token } });
    if (r.statusCode !== 200) throw new Error('дашборд ответил ' + r.statusCode);
    return r.json();
  } finally {
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [hash]).catch(() => {});
  }
}

export function buildPlanText(d: any): string {
  const t = d.totals ?? {};
  const g = d.goals ?? d.goalsMonthly ?? {};
  const pace = Math.max(0.0001, Number(d.pace) || 0);
  const today: string = d.today;
  const dayN = Number(today.slice(8, 10));
  const monthLen = Number(String(d.range?.to ?? today).slice(8, 10)) || 30;
  const left = Math.max(0, monthLen - dayN);
  const mark = (v: number, goal: number) => {
    if (!(goal > 0)) return '';
    const r = v / goal;
    return r >= pace ? ' ✅' : r >= pace * 0.85 ? ' ⚠️' : ' 🔴';
  };
  const behind = (v: number, goal: number) => goal > 0 && v / goal < pace;
  const line = (ic: string, name: string, v: number, goal: number, f: (n: number) => string) =>
    `${ic} ${name}: <b>${f(v)}</b>` + (goal > 0 ? ` / ${f(goal)} · ${pc(v / goal)}${mark(v, goal)}` + (behind(v, goal) ? ` (по графику ${name === 'FTD' ? 'нужно ' : ''}${f(goal * pace)})` : '') : '');

  const out: string[] = [];
  out.push(`📊 <b>План / факт на ${dayN} ${MG[Number(today.slice(5, 7)) - 1]}</b> · день ${dayN} из ${monthLen}`, '');
  out.push('<b>Команда</b>');
  out.push(line('📝', 'Регистрации', t.regs ?? 0, g.regs ?? 0, grp));
  out.push(line('💳', 'FTD', t.ftd ?? 0, g.ftd ?? 0, grp));
  out.push(line('💰', 'Все депозиты', t.deposits ?? 0, g.deposits ?? 0, usd));

  // По сотрудникам: только активные стримеры; план к сегодняшнему дню (личный план часов, FTD из KPI-плана)
  const planLeads = Number(d.plan?.leads) || 0;
  const S = ((d.streamers ?? []) as any[]).filter((s) => s.role === 'streamer' && s.active).map((s) => {
    const hMin = Number(s.month?.hoursMin) || 0;
    const hPlan = (Number(s.month?.planMin) || Number(d.plan?.planMin) || 0) * pace;
    const ftd = Number(s.month?.ftd) || 0;
    const fPlan = planLeads * pace;
    const rh = hPlan > 0 ? hMin / hPlan : 1;
    const rf = fPlan > 0 ? ftd / fPlan : 1;
    const worst = Math.min(rh, rf);
    return { name: s.name as string, hMin, hPlan, ftd, fPlan, rh, rf, worst, ic: worst >= 1 ? '🟢' : worst >= 0.85 ? '🟡' : '🔴' };
  }).sort((a, b) => b.worst - a.worst || b.ftd - a.ftd);
  if (S.length) {
    out.push('', '<b>По сотрудникам</b> (часы · FTD)');
    for (const s of S) out.push(`${s.ic} ${esc(s.name)}: ${Math.floor(s.hMin / 60)} / ${Math.round(s.hPlan / 60)} ч · ${s.ftd} / ${Math.round(s.fPlan)} FTD`);
    out.push('', '🟢 идёт по графику', '🟡 отстаёт до 15%', '🔴 отстаёт сильнее');
  }

  // Советы по правилам: самые важные, не больше четырёх
  const tips: string[] = [];
  const ftd = t.ftd ?? 0, regs = t.regs ?? 0;
  if (g.ftd > 0) {
    if (behind(ftd, g.ftd) && left > 0) tips.push(`FTD нужно <b>${n1(Math.max(0, g.ftd - ftd) / left)} в день</b> до конца месяца. Сейчас выходит ${n1(ftd / Math.max(1, dayN))}.`);
    else if (ftd >= g.ftd) tips.push('План по FTD на месяц уже выполнен 🔥 Держим темп, всё сверху идёт в плюс.');
    else tips.push(`FTD идёт по графику: держим темп ${n1(ftd / Math.max(1, dayN))} в день.`);
  }
  const rtd = regs ? ftd / regs : 0;
  if (g.regs > 0 && behind(regs, g.regs)) tips.push(`Мало регистраций: ${grp(regs)} при нужных ${grp(g.regs * pace)} к сегодня. Больше эфиров, ссылка в описании и закрепе, призыв зарегистрироваться в каждом эфире.`);
  else if (g.ftd > 0 && behind(ftd, g.ftd) && regs > 0) tips.push(`Регистраций хватает, но в депозит переходят только ${pc(rtd)}. Дожимаем зарегистрированных: напомнить в личке, показать бонус на первый депозит.`);
  if (g.deposits > 0 && behind(t.deposits ?? 0, g.deposits) && !(g.ftd > 0 && behind(ftd, g.ftd))) tips.push('FTD по графику, а сумма депозитов отстаёт: напоминаем активным клиентам про додепы и бонусы за них.');
  const lag = S.filter((s) => s.rh < 0.85 && s.hPlan > 0);
  if (lag.length) {
    const L = lag.slice(0, 4);
    tips.push(`${L.length > 1 ? 'Отстают' : 'Отстаёт'} по часам: ${L.map((s) => esc(s.name)).join(', ')}. Чтобы догнать график, добавить смены: ${L.map((s) => `${esc(s.name)} +${Math.max(1, Math.round((s.hPlan - s.hMin) / 60))} ч`).join(', ')}.`);
  }
  const best = [...S].filter((s) => s.ftd > 0).sort((a, b) => b.rf - a.rf || b.ftd - a.ftd)[0];
  if (best && S.length > 1 && best.rf >= 1) tips.push(`${esc(best.name)} идёт лучше всех: можно поставить дополнительные эфиры в прайм-тайм.`);
  if (tips.length) {
    out.push('', '<b>💡 Как выйти на план</b>');
    out.push('<blockquote>' + tips.slice(0, 4).map((x, i) => `${i + 1}. ${x}`).join('\n') + '</blockquote>');
  }
  out.push('', TAG);
  return out.join('\n');
}

async function tgSend(chat: string, thread: string, text: string): Promise<string | null> {
  const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(thread ? { message_thread_id: Number(thread) } : {}) }),
  }).catch((e) => ({ ok: false, json: async () => ({ description: String(e) }) }) as any);
  if (r.ok) return null;
  const j = await r.json().catch(() => ({}));
  return j.description || 'ошибка отправки';
}

/** Отправить отчёт сейчас в сохранённую группу. Возвращает текст ошибки или null */
export async function sendPlanReport(): Promise<string | null> {
  const chat = await setting('plan_report_chat');
  if (!chat) return 'группа не задана: отправьте /plan_here в нужной группе';
  try {
    const err = await tgSend(chat, await setting('plan_report_thread'), buildPlanText(await dashboard()));
    await save('plan_report_error', err ?? '');
    return err;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    await save('plan_report_error', m);
    return m;
  }
}

export async function setPlanChat(chat: number, thread: number | null): Promise<void> {
  await save('plan_report_chat', String(chat));
  await save('plan_report_thread', thread ? String(thread) : '');
}

/** Раз в минуту: в 12:xx по Киеву, если сегодня ещё не отправляли */
export function startPlanReport(log: { error: (e: unknown, m: string) => void }): void {
  const tick = async () => {
    const now = new Date();
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(now)) % 24;
    if (hour !== HOUR) return;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
    if (!(await setting('plan_report_chat')) || (await setting('plan_report_last')) === today) return;
    await save('plan_report_last', today);
    const err = await sendPlanReport();
    if (err) log.error(new Error(err), 'План / факт в группу не отправлен');
  };
  setInterval(() => void tick().catch((e) => log.error(e, 'План / факт: ошибка')), 60_000);
}
