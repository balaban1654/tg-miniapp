import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db.js';
import { buildKeyboard, deliver, loadTarget, renderText, type Button } from './push.js';

import type { Role } from './auth.js';
type Need = (...roles: Role[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Допуск: депозит засчитывается, если он не меньше 90% нужной суммы (курс брокера, округления) */
export const TOL = 0.9;
/** Одному лиду акцию не чаще, чем раз в столько дней */
export const OFFER_GAP_DAYS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const r2 = (n: number) => Math.round(n * 100) / 100;

export async function getMinDeposit(): Promise<number> {
  const v = Number((await db.query('SELECT min_deposit FROM connect_settings WHERE id = 1')).rows[0]?.min_deposit);
  return v > 0 ? v : 50;
}

export interface Required {
  /** сколько нужно внести лиду (с учётом его акции, если она действует) */
  required: number;
  /** общий порог без акции */
  base: number;
  offer: { id: number | null; name: string; pct: number; until: string } | null;
}

/** Сумма для подключения именно этого лида: общий порог или цена по действующей акции */
export async function requiredFor(tgId: number | string): Promise<Required> {
  const base = await getMinDeposit();
  const s = (
    await db.query(
      `SELECT offer_id, offer_name, discount_pct, required, expires_at FROM connect_sends
        WHERE tg_id = $1 AND delivery <> 'failed' AND connected_at IS NULL AND expires_at > now() ORDER BY id DESC LIMIT 1`,
      [tgId],
    )
  ).rows[0];
  if (!s) return { required: base, base, offer: null };
  return { required: Number(s.required), base, offer: { id: s.offer_id, name: s.offer_name, pct: s.discount_pct, until: new Date(s.expires_at).toISOString() } };
}

/** Доступ лиду открыт: действующая акция сработала */
export async function markConnected(tgId: number | string, total: number): Promise<void> {
  await db.query(
    `UPDATE connect_sends SET connected_at = now(), connected_amount = $2
      WHERE tg_id = $1 AND delivery <> 'failed' AND connected_at IS NULL AND expires_at > now()`,
    [tgId, total],
  );
}

const usd = (n: number) => '$' + String(r2(n)).replace('.', ',');
const kyivDate = (d: Date) => new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Kyiv' }).format(d);

export const DEFAULT_OFFER_TEXT = '🔥 Для вас скидка {скидка}%: подключитесь всего от **{сумма}**! Предложение действует до {дата}.';
const OFFER_BUTTONS: Button[] = [{ label: 'Активировать скидку', type: 'miniapp', style: 'success' }];

interface Offer {
  id: number;
  name: string;
  discount_pct: number;
  days: number;
  text: string;
}

function fillText(text: string, o: { pct: number; required: number; until: Date }): string {
  return text.replaceAll('{скидка}', String(o.pct)).replaceAll('{сумма}', usd(o.required)).replaceAll('{дата}', kyivDate(o.until));
}

/** Отправляет одну акцию одному лиду. Запись об отправке создаётся до отправки, результат дописывается после */
async function sendOffer(o: Offer, tgId: string, by: number | null): Promise<{ ok: boolean; error?: string; blocked?: boolean }> {
  const base = await getMinDeposit();
  const required = r2(base * (1 - o.discount_pct / 100));
  const until = new Date(Date.now() + o.days * 86_400_000);
  const ins = await db.query(
    `INSERT INTO connect_sends (offer_id, offer_name, tg_id, discount_pct, required, expires_at, sent_by, delivery)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'queued') RETURNING id`,
    [o.id, o.name, tgId, o.discount_pct, required, until, by],
  );
  const id = ins.rows[0].id as number;
  const t = await loadTarget(tgId);
  const text = renderText(fillText(o.text, { pct: o.discount_pct, required, until }), t);
  const kb = buildKeyboard(OFFER_BUTTONS, t);
  let res = await deliver(tgId, text, kb);
  if (!res.ok && res.retry) {
    await sleep(2000);
    res = await deliver(tgId, text, kb);
  }
  if (res.ok) await db.query(`UPDATE connect_sends SET delivery = 'sent' WHERE id = $1`, [id]);
  else {
    await db.query(`UPDATE connect_sends SET delivery = 'failed', error = $2 WHERE id = $1`, [id, res.error.slice(0, 300)]);
    if (res.blocked) await db.query('UPDATE leads SET bot_blocked = TRUE WHERE tg_id = $1', [tgId]);
  }
  return res.ok ? { ok: true } : { ok: false, error: res.error, blocked: res.blocked };
}

const NOT_CONNECTED = `d.removed_at IS NULL AND coalesce(d.lead_role, 'lead') = 'lead' AND d.status IN ('new','registered') AND NOT d.access`;
const GAP = `NOT EXISTS (SELECT 1 FROM connect_sends s WHERE s.tg_id = d.tg_id AND s.delivery <> 'failed' AND s.sent_at > now() - interval '${OFFER_GAP_DAYS} days')`;

/** Данные для карточки лида: сколько нужно, что внесено, действующая акция, прошлые отправки */
export async function connectInfo(tgId: number, hideDeposit = false) {
  const rq = await requiredFor(tgId);
  const dep = Number((await db.query(`SELECT coalesce(sum(amount),0) AS s FROM events WHERE tg_id = $1 AND type IN ('ftd','dep')`, [tgId])).rows[0].s);
  const offers = (await db.query(`SELECT id, name, discount_pct, days, text FROM connect_offers WHERE active ORDER BY id`)).rows as Offer[];
  const sends = (
    await db.query(
      `SELECT offer_name, discount_pct, required, sent_at, expires_at, delivery, connected_at, connected_amount::float AS connected_amount
         FROM connect_sends WHERE tg_id = $1 ORDER BY id DESC LIMIT 5`,
      [tgId],
    )
  ).rows;
  const gap = (await db.query(`SELECT 1 FROM connect_sends s WHERE s.tg_id = $1 AND s.delivery <> 'failed' AND s.sent_at > now() - interval '${OFFER_GAP_DAYS} days' LIMIT 1`, [tgId])).rowCount;
  return {
    required: rq.required,
    base: rq.base,
    from: r2(rq.required * TOL),
    offer: rq.offer,
    deposited: hideDeposit ? null : r2(dep),
    offers: offers.map((o) => ({ id: o.id, name: o.name, pct: o.discount_pct, days: o.days, text: o.text, required: r2(rq.base * (1 - o.discount_pct / 100)) })),
    sends,
    gapDays: gap ? OFFER_GAP_DAYS : 0,
  };
}

export async function connectRoutes(app: FastifyInstance, h: { need: Need; str: (v: unknown, max: number) => string }): Promise<void> {
  const admin = h.need('admin');
  const { str } = h;

  app.get('/connect', { preHandler: admin }, async () => {
    const base = await getMinDeposit();
    const offers = (await db.query(`SELECT id, name, discount_pct, days, text, active FROM connect_offers ORDER BY id`)).rows;
    const aud = (
      await db.query(
        `SELECT d.owner_id, o.name AS owner_name, count(*)::int AS n,
                count(*) FILTER (WHERE ${GAP})::int AS ready,
                count(*) FILTER (WHERE d.status = 'new')::int AS fresh,
                count(*) FILTER (WHERE d.status = 'registered')::int AS reg
           FROM leads d LEFT JOIN staff o ON o.id = d.owner_id
          WHERE ${NOT_CONNECTED} AND d.bot_started AND NOT d.bot_blocked GROUP BY 1, 2 ORDER BY n DESC`,
      )
    ).rows;
    return {
      minDeposit: base,
      tolerance: Math.round((1 - TOL) * 100),
      from: r2(base * TOL),
      gapDays: OFFER_GAP_DAYS,
      offers: offers.map((o) => ({ ...o, required: r2(base * (1 - o.discount_pct / 100)) })),
      audience: aud,
      defaultText: DEFAULT_OFFER_TEXT,
    };
  });

  app.put('/connect/settings', { preHandler: admin }, async (req, reply) => {
    const v = Number((req.body as any)?.min_deposit);
    if (!(v >= 1 && v <= 100000)) return reply.code(400).send({ error: 'Сумма от $1 до $100 000' });
    await db.query('UPDATE connect_settings SET min_deposit = $1 WHERE id = 1', [r2(v)]);
    return { ok: true, minDeposit: r2(v), from: r2(v * TOL) };
  });

  const readOffer = (b: Record<string, unknown>) => {
    const name = str(b.name, 60);
    const pct = Math.round(Number(b.discount_pct));
    const days = Math.round(Number(b.days));
    const text = str(b.text, 800);
    if (!name) return { error: 'Назовите акцию' };
    if (!(pct >= 1 && pct <= 95)) return { error: 'Скидка от 1 до 95%' };
    if (!(days >= 1 && days <= 60)) return { error: 'Срок от 1 до 60 дней' };
    if (text.length < 5) return { error: 'Напишите текст пуша' };
    return { name, pct, days, text };
  };

  app.post('/connect/offers', { preHandler: admin }, async (req, reply) => {
    const o = readOffer((req.body ?? {}) as Record<string, unknown>);
    if ('error' in o) return reply.code(400).send({ error: o.error });
    const r = await db.query(`INSERT INTO connect_offers (name, discount_pct, days, text) VALUES ($1,$2,$3,$4) RETURNING id`, [o.name, o.pct, o.days, o.text]);
    return { id: r.rows[0].id };
  });

  app.patch<{ Params: { id: string } }>('/connect/offers/:id', { preHandler: admin }, async (req, reply) => {
    const o = readOffer((req.body ?? {}) as Record<string, unknown>);
    if ('error' in o) return reply.code(400).send({ error: o.error });
    const r = await db.query(`UPDATE connect_offers SET name = $2, discount_pct = $3, days = $4, text = $5 WHERE id = $1 RETURNING id`, [Number(req.params.id), o.name, o.pct, o.days, o.text]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Акция не найдена' });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/connect/offers/:id', { preHandler: admin }, async (req, reply) => {
    const r = await db.query('DELETE FROM connect_offers WHERE id = $1 RETURNING id', [Number(req.params.id)]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Акция не найдена' });
    return { ok: true };
  });

  // Отправка акции: одному лиду (tg_id), себе для проверки (test) или всем «не подключившимся» (по желанию одного стримера)
  // Стример предлагает скидку только своим лидам и только по одному, из карточки лида. Тест и массовая рассылка у админа
  app.post<{ Params: { id: string } }>('/connect/offers/:id/send', { preHandler: h.need('admin', 'streamer') }, async (req, reply) => {
    const me = (req as any).staff as { id: number; role: string; tg_username?: string | null };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const mine = me.role === 'streamer';
    if (mine && (b.test === true || b.tg_id === undefined || b.tg_id === null || b.tg_id === '')) return reply.code(403).send({ error: 'Стример предлагает скидку из карточки своего лида' });
    const o = (await db.query(`SELECT id, name, discount_pct, days, text FROM connect_offers WHERE id = $1 AND active`, [Number(req.params.id)])).rows[0] as Offer | undefined;
    if (!o) return reply.code(404).send({ error: 'Акция не найдена' });

    if (b.test === true) {
      const un = (await db.query('SELECT tg_username FROM staff WHERE id = $1', [me.id])).rows[0]?.tg_username as string | null;
      let lead = un ? (await db.query(`SELECT tg_id FROM leads WHERE lower(username) = lower($1) AND bot_started AND NOT bot_blocked LIMIT 1`, [String(un).replace(/^@/, '')])).rows[0] : null;
      // Telegram в профиле не указан: если в админ составе ровно один админ, это вы
      if (!lead) {
        const adm = (await db.query(`SELECT d.tg_id, lower(coalesce(d.first_name, '')) = lower(s.name) AS same FROM leads d, staff s
            WHERE s.id = $1 AND d.lead_role = 'admin' AND d.bot_started AND NOT d.bot_blocked AND d.removed_at IS NULL`, [me.id])).rows as { tg_id: string; same: boolean }[];
        lead = adm.find((x) => x.same) ?? (adm.length === 1 ? adm[0] : null);
      }
      if (!lead) return reply.code(404).send({ error: 'Не нашёл вас в боте. Впишите свой Telegram в карточке сотрудника (шестерёнка внизу слева) и нажмите «Старт» у бота' });
      // Тест не создаёт акцию лиду: отправляем сообщение напрямую
      const base = await getMinDeposit();
      const required = r2(base * (1 - o.discount_pct / 100));
      const until = new Date(Date.now() + o.days * 86_400_000);
      const t = await loadTarget(lead.tg_id);
      const res = await deliver(String(lead.tg_id), '[Тест]\n' + renderText(fillText(o.text, { pct: o.discount_pct, required, until }), t), buildKeyboard(OFFER_BUTTONS, t));
      if (!res.ok) return reply.code(502).send({ error: 'Не удалось отправить: ' + res.error });
      return { ok: true, test: true };
    }

    if (b.tg_id !== undefined && b.tg_id !== null && b.tg_id !== '') {
      const tgId = Number(b.tg_id);
      const d = (await db.query(`SELECT d.tg_id, d.bot_started, d.bot_blocked FROM leads d WHERE d.tg_id = $1 AND ${NOT_CONNECTED} AND ($2::int IS NULL OR d.owner_id = $2)`, [tgId, mine ? me.id : null])).rows[0];
      if (!d) return reply.code(409).send({ error: mine ? 'Лид не найден среди ваших или уже подключён: скидка ему не нужна' : 'Лид уже подключён или не найден: скидка ему не нужна' });
      if (!d.bot_started || d.bot_blocked) return reply.code(409).send({ error: 'Лид не запускал бота или заблокировал его: пуш не дойдёт' });
      const gap = (await db.query(`SELECT 1 FROM connect_sends s WHERE s.tg_id = $1 AND s.delivery <> 'failed' AND s.sent_at > now() - interval '${OFFER_GAP_DAYS} days' LIMIT 1`, [tgId])).rowCount;
      if (gap) return reply.code(409).send({ error: `Этому лиду акцию уже отправляли за последние ${OFFER_GAP_DAYS} дня. Подождите` });
      const res = await sendOffer(o, String(tgId), me.id);
      if (!res.ok) return reply.code(502).send({ error: 'Не удалось отправить: ' + (res.error ?? 'ошибка Telegram') });
      return { ok: true, total: 1 };
    }

    const owner = b.owner_id ? Number(b.owner_id) : null;
    const rows = (
      await db.query(
        `SELECT d.tg_id FROM leads d WHERE ${NOT_CONNECTED} AND d.bot_started AND NOT d.bot_blocked AND ${GAP}
            AND ($1::int IS NULL OR d.owner_id = $1) ORDER BY d.tg_id`,
        [owner],
      )
    ).rows as { tg_id: string }[];
    // Рассылка идёт в фоне: ответ сразу, ход виден во вкладке «Отправленные»
    void (async () => {
      for (const r of rows) {
        try {
          await sendOffer(o, String(r.tg_id), me.id);
        } catch (e) {
          console.error('Акция «Подключение»: сбой отправки', e);
        }
        await sleep(60);
      }
    })();
    return { ok: true, total: rows.length };
  });

  app.get('/connect/sends', { preHandler: admin }, async () => {
    const r = await db.query(
      `SELECT s.id, s.tg_id, s.offer_name, s.discount_pct, s.required::float AS required, s.sent_at, s.expires_at, s.delivery, s.error,
              s.connected_at, s.connected_amount::float AS connected_amount,
              coalesce(nullif(d.first_name,''), nullif(d.username,''), s.tg_id::text) AS lead_name, d.username, st.name AS by_name
         FROM connect_sends s LEFT JOIN leads d ON d.tg_id = s.tg_id LEFT JOIN staff st ON st.id = s.sent_by
        ORDER BY s.id DESC LIMIT 300`,
    );
    return r.rows.map((x) => ({ ...x, state: x.delivery === 'failed' ? 'failed' : x.delivery === 'queued' ? 'queued' : x.connected_at ? 'connected' : new Date(x.expires_at) < new Date() ? 'expired' : 'pending' }));
  });
}
