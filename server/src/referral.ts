import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db.js';
import { config } from './config.js';
import { deliver } from './push.js';
import type { Role } from './auth.js';

type Need = (...roles: Role[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Ставки по умолчанию: пригласившему за друга с первым депозитом и трейдеру (бонусом в зарплату). Меняются в Подключение → Рефералы */
export const REF_LEAD_USD = 5;
export const REF_STAFF_USD = 3;
export const REF_MIN_PAYOUT = 50;
export async function refRates(): Promise<{ lead: number; staff: number; minPayout: number }> {
  const r = (await db.query('SELECT ref_lead::float AS lead, ref_staff::float AS staff, ref_min_payout::float AS min FROM connect_settings WHERE id = 1')).rows[0];
  return { lead: r && r.lead >= 0 ? Number(r.lead) : REF_LEAD_USD, staff: r && r.staff >= 0 ? Number(r.staff) : REF_STAFF_USD, minPayout: r && r.min >= 0 ? Number(r.min) : REF_MIN_PAYOUT };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => '$' + String(r2(n)).replace('.', ',');

/** Код в ссылке: Telegram ID в 36-ричной записи (короче и не так бросается в глаза) */
export const refCode = (tgId: number | string) => 'ref_' + BigInt(tgId).toString(36);
export function parseRefPayload(payload: string): number | null {
  const m = /^ref_([0-9a-z]{1,14})$/.exec(payload.trim());
  if (!m) return null;
  const n = parseInt(m[1], 36);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
export const refLink = (tgId: number | string) => `https://t.me/${config.botUsername}?start=${refCode(tgId)}`;

/** Кто может пригласить: обычный клиент (или тест), не заблокирован и не удалён. Возвращает его трейдера */
export async function referrerOf(refId: number, newTgId: number): Promise<{ owner_id: number | null } | null> {
  if (refId === newTgId) return null;
  const r = (
    await db.query(
      `SELECT owner_id FROM leads WHERE tg_id = $1 AND coalesce(lead_role, 'lead') IN ('lead','test') AND banned_at IS NULL AND removed_at IS NULL`,
      [refId],
    )
  ).rows[0];
  return r ? { owner_id: r.owner_id ?? null } : null;
}

/** Друг сделал первый депозит и получил доступ: начисляем пригласившему и трейдеру. Один раз на друга.
 *  Тестовые аккаунты зарплату трейдеру не начисляют */
export async function accrueReferral(tgId: number | string): Promise<void> {
  const d = (
    await db.query(
      `SELECT d.tg_id, d.referrer_id, d.owner_id, d.lead_role, d.username, d.first_name, r.lead_role AS ref_role, s.role AS owner_role
         FROM leads d JOIN leads r ON r.tg_id = d.referrer_id LEFT JOIN staff s ON s.id = d.owner_id
        WHERE d.tg_id = $1 AND d.referrer_id IS NOT NULL AND d.access`,
      [tgId],
    )
  ).rows[0];
  if (!d) return;
  const test = d.lead_role === 'test' || d.ref_role === 'test';
  const rate = await refRates();
  const staffPay = !test && d.owner_id && d.owner_role !== 'admin' && rate.staff > 0 ? rate.staff : 0;
  const ins = await db.query(
    `INSERT INTO referral_rewards (tg_id, referrer_id, owner_id, lead_amount, staff_amount) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tg_id) DO NOTHING RETURNING tg_id`,
    [d.tg_id, d.referrer_id, d.owner_id, rate.lead, staffPay],
  );
  if (!ins.rowCount) return;
  if (staffPay) {
    const who = d.username ? '@' + d.username : d.first_name || String(d.tg_id);
    const a = await db.query(
      `INSERT INTO staff_adjustments (staff_id, period, kind, amount, comment, visible)
       VALUES ($1, to_char(now() AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM'), 'bonus', $2, $3, TRUE) RETURNING id`,
      [d.owner_id, staffPay, '🤝 Реферал: ' + who + ' сделал первый депозит'],
    );
    await db.query('UPDATE referral_rewards SET adjustment_id = $2 WHERE tg_id = $1', [d.tg_id, a.rows[0].id]);
  }
  const friend = d.first_name || (d.username ? '@' + d.username : 'Ваш друг');
  if (rate.lead > 0) await deliver(String(d.referrer_id), `🎉 ${friend} сделал первый депозит по вашей ссылке. На реферальный баланс начислено **${usd(rate.lead)}**.`).catch(() => {});
}

/** Баланс пригласившего: начислено минус выплаченное и ждущее выплаты */
async function balanceOf(tgId: number) {
  const e = Number((await db.query(`SELECT coalesce(sum(lead_amount), 0)::float AS s FROM referral_rewards WHERE referrer_id = $1`, [tgId])).rows[0].s);
  const p = (await db.query(`SELECT coalesce(sum(amount) FILTER (WHERE status = 'paid'), 0)::float AS paid, coalesce(sum(amount) FILTER (WHERE status = 'pending'), 0)::float AS pending FROM referral_payouts WHERE tg_id = $1`, [tgId])).rows[0];
  return { earned: r2(e), paid: r2(p.paid), pending: r2(p.pending), balance: r2(e - p.paid - p.pending) };
}

const POCKET_RE = /^\d{5,12}$/;
const BEP20_RE = /^0x[a-fA-F0-9]{40}$/;
const mask = (name: string) => (name.length <= 2 ? name[0] + '•' : name.slice(0, 2) + '•'.repeat(Math.min(4, name.length - 2)));

/** Mini App: ссылка, статистика, друзья, заявка на выплату */
export async function referralAppRoutes(app: FastifyInstance, auth: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>): Promise<void> {
  app.get('/referral', { preHandler: auth }, async (req) => {
    const tgId = req.tg!.id;
    const friends = (
      await db.query(
        `SELECT d.first_name, d.username, d.created_at, w.lead_amount::float AS reward, w.created_at AS rewarded_at
           FROM leads d LEFT JOIN referral_rewards w ON w.tg_id = d.tg_id
          WHERE d.referrer_id = $1 ORDER BY d.created_at DESC LIMIT 200`,
        [tgId],
      )
    ).rows;
    const payouts = (await db.query(`SELECT id, amount::float AS amount, method, wallet, status, reject_reason, created_at, decided_at FROM referral_payouts WHERE tg_id = $1 ORDER BY id DESC LIMIT 50`, [tgId])).rows;
    const pocketId = (await db.query('SELECT trader_id FROM leads WHERE tg_id = $1', [tgId])).rows[0]?.trader_id ?? null;
    return {
      link: refLink(tgId),
      perFriend: (await refRates()).lead,
      minPayout: (await refRates()).minPayout,
      invited: friends.length,
      deposited: friends.filter((f) => f.reward != null).length,
      ...(await balanceOf(tgId)),
      friends: friends.map((f) => ({ name: mask(String(f.first_name || f.username || 'Друг')), at: f.created_at, reward: f.reward, rewardedAt: f.rewarded_at })),
      payouts,
      pocketId,
    };
  });

  app.post('/referral/payout', { preHandler: auth }, async (req, reply) => {
    const tgId = req.tg!.id;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const method = b.method === 'usdt' ? 'usdt' : b.method === 'pocket' ? 'pocket' : null;
    const wallet = String(b.wallet ?? '').trim();
    if (!method) return reply.code(400).send({ error: 'Выберите, куда вывести' });
    if (method === 'pocket' && !POCKET_RE.test(wallet)) return reply.code(400).send({ error: 'ID торгового счёта Pocket Option: только цифры, 5–12 знаков' });
    if (method === 'usdt' && !BEP20_RE.test(wallet)) return reply.code(400).send({ error: 'Адрес USDT BEP20 начинается с 0x и содержит 42 символа' });
    if ((await db.query(`SELECT 1 FROM leads WHERE tg_id = $1 AND banned_at IS NULL`, [tgId])).rowCount === 0) return reply.code(403).send({ error: 'Выплата недоступна' });
    if ((await db.query(`SELECT 1 FROM referral_payouts WHERE tg_id = $1 AND status = 'pending'`, [tgId])).rowCount) return reply.code(409).send({ error: 'Заявка уже на рассмотрении. Дождитесь выплаты' });
    const { balance } = await balanceOf(tgId);
    if (!(balance > 0)) return reply.code(409).send({ error: 'На балансе пока нет средств' });
    const { minPayout } = await refRates();
    if (balance < minPayout) return reply.code(409).send({ error: `Минимальная сумма вывода ${usd(minPayout)}. Сейчас на балансе ${usd(balance)}` });
    const r = await db.query(`INSERT INTO referral_payouts (tg_id, amount, method, wallet) VALUES ($1,$2,$3,$4) RETURNING id`, [tgId, balance, method, wallet]);
    return { ok: true, id: r.rows[0].id, amount: balance };
  });
}

/** Office: заявки на выплату и начисления (админ) */
export async function referralOfficeRoutes(app: FastifyInstance, h: { need: Need; str: (v: unknown, max: number) => string }): Promise<void> {
  const admin = h.need('admin');
  const name = (a: string) => `coalesce(nullif(${a}.first_name, ''), '@' || ${a}.username, ${a}.tg_id::text)`;

  app.get<{ Querystring: { period?: string } }>('/referral/overview', { preHandler: admin }, async (req) => {
    const period = /^\d{4}-\d{2}$/.test(String(req.query.period ?? '')) ? String(req.query.period) : null;
    const payouts = (
      await db.query(
        `SELECT p.id, p.tg_id, ${name('d')} AS lead_name, d.username, p.amount::float AS amount, p.method, p.wallet, p.status, p.reject_reason,
                p.created_at, p.decided_at, s.name AS decided_name
           FROM referral_payouts p JOIN leads d ON d.tg_id = p.tg_id LEFT JOIN staff s ON s.id = p.decided_by
          WHERE p.status = 'pending' OR $1::text IS NULL OR to_char(p.created_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM') = $1
          ORDER BY (p.status = 'pending') DESC, p.id DESC LIMIT 300`,
        [period],
      )
    ).rows;
    const rewards = (
      await db.query(
        `SELECT w.tg_id, ${name('d')} AS friend_name, w.referrer_id, ${name('r')} AS referrer_name, s.name AS owner_name,
                w.lead_amount::float AS lead_amount, w.staff_amount::float AS staff_amount, w.created_at
           FROM referral_rewards w JOIN leads d ON d.tg_id = w.tg_id JOIN leads r ON r.tg_id = w.referrer_id LEFT JOIN staff s ON s.id = w.owner_id
          WHERE $1::text IS NULL OR to_char(w.created_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM') = $1
          ORDER BY w.created_at DESC LIMIT 500`,
        [period],
      )
    ).rows;
    const invited = Number((await db.query(`SELECT count(*)::int AS n FROM leads WHERE referrer_id IS NOT NULL AND ($1::text IS NULL OR to_char(created_at AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM') = $1)`, [period])).rows[0].n);
    // Все рефералы: кто пришёл, кто пригласил, за каким трейдером закреплён, был ли первый депозит и сколько начислено
    const all = (
      await db.query(
        `SELECT d.tg_id, ${name('d')} AS friend_name, d.username, d.created_at, d.referrer_id, ${name('r')} AS referrer_name, s.name AS owner_name,
                (SELECT min(e.created_at) FROM events e WHERE e.tg_id = d.tg_id AND e.type = 'ftd') AS ftd_at,
                w.lead_amount::float AS lead_amount, w.staff_amount::float AS staff_amount
           FROM leads d JOIN leads r ON r.tg_id = d.referrer_id LEFT JOIN staff s ON s.id = d.owner_id LEFT JOIN referral_rewards w ON w.tg_id = d.tg_id
          WHERE d.referrer_id IS NOT NULL AND d.removed_at IS NULL ORDER BY d.created_at DESC LIMIT 2000`,
      )
    ).rows;
    const rate = await refRates();
    return { perFriend: rate.lead, perStaff: rate.staff, minPayout: rate.minPayout, invited, payouts, rewards, all };
  });

  app.put('/referral/settings', { preHandler: admin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const lead = Math.round(Number(b.lead) * 100) / 100, staff = Math.round(Number(b.staff) * 100) / 100, min = Math.round(Number(b.minPayout) * 100) / 100;
    if (!(lead >= 0 && lead <= 1000 && staff >= 0 && staff <= 1000)) return reply.code(400).send({ error: 'Суммы от $0 до $1000' });
    if (!(min >= 0 && min <= 10000)) return reply.code(400).send({ error: 'Минимальный вывод от $0 до $10 000' });
    await db.query('UPDATE connect_settings SET ref_lead = $1, ref_staff = $2, ref_min_payout = $3 WHERE id = 1', [lead, staff, min]);
    return { ok: true };
  });

  app.get('/referral/pending', { preHandler: admin }, async () => {
    return { n: Number((await db.query(`SELECT count(*)::int AS n FROM referral_payouts WHERE status = 'pending'`)).rows[0].n) };
  });

  app.post<{ Params: { id: string } }>('/referral/payouts/:id/decide', { preHandler: admin }, async (req, reply) => {
    const me = (req as any).staff as { id: number };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const action = b.action === 'paid' ? 'paid' : b.action === 'reject' ? 'rejected' : null;
    if (!action) return reply.code(400).send({ error: 'Неизвестное действие' });
    const reason = action === 'rejected' ? h.str(b.reason, 300).trim() : '';
    if (action === 'rejected' && !reason) return reply.code(400).send({ error: 'Укажите причину: её увидит клиент' });
    const r = (
      await db.query(
        `UPDATE referral_payouts SET status = $2, reject_reason = $3, decided_by = $4, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING tg_id, amount::float AS amount, method`,
        [Number(req.params.id), action, reason || null, me.id],
      )
    ).rows[0];
    if (!r) return reply.code(409).send({ error: 'Заявка уже обработана' });
    const where = r.method === 'usdt' ? 'кошелёк USDT BEP20' : 'торговый счёт Pocket Option';
    const text = action === 'paid'
      ? `✅ Реферальная выплата **${usd(r.amount)}** отправлена на ${where}.`
      : `Заявка на реферальную выплату ${usd(r.amount)} отклонена: ${reason}. Сумма вернулась на баланс.`;
    await deliver(String(r.tg_id), text).catch(() => {});
    return { ok: true };
  });
}
