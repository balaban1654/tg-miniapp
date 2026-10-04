import type { FastifyInstance } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { processLead } from './push.js';

type Ev = 'reg' | 'ftd' | 'dep' | 'wd' | 'comm';
const EVENTS: Ev[] = ['reg', 'ftd', 'dep', 'wd', 'comm'];

// Партнёрка может называть одни и те же параметры по-разному, берём первый найденный
const ID_KEYS = ['click_id', 'clickid', 'subid', 'sub_id', 'sub_id1', 'tg_id'];
const AMOUNT_KEYS = ['commission', 'comm', 'revshare', 'sumdep', 'wdr_sum', 'amount', 'sum', 'payout', 'profit', 'value'];
const TX_KEYS = ['txid', 'transaction_id', 'order_id', 'deposit_id', 'id'];

const pick = (q: Record<string, string>, keys: string[]): string => {
  for (const k of keys) if (q[k]) return q[k];
  return '';
};

function secretOk(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(config.postbackSecret);
  return config.postbackSecret.length >= 16 && a.length === b.length && timingSafeEqual(a, b);
}

async function log(event: string, q: Record<string, string>, tgId: number | null, result: string, eventId: number | null = null) {
  const { secret: _s, ...safe } = q;
  await db.query('INSERT INTO postback_log (event, query, tg_id, result, event_id) VALUES ($1,$2,$3,$4,$5)', [
    event,
    JSON.stringify(safe),
    tgId,
    result,
    eventId,
  ]);
}

export async function postbackRoutes(app: FastifyInstance): Promise<void> {
  const handler = async (req: any, reply: any) => {
    const event = String(req.params.event) as Ev;
    const q: Record<string, string> = {};
    for (const src of [req.query, typeof req.body === 'object' ? req.body : {}]) {
      for (const [k, v] of Object.entries(src ?? {})) if (typeof v === 'string' || typeof v === 'number') q[k.toLowerCase()] = String(v);
    }

    if (!secretOk(q.secret ?? '')) return reply.code(401).send({ ok: false, error: 'bad secret' });
    if (!EVENTS.includes(event)) return reply.code(404).send({ ok: false, error: 'unknown event' });

    // Лида ищем по метке из ссылки (click_id), а если её нет, по trader_id, который запомнили при регистрации
    const traderId = q.trader_id ?? '';
    const rawId = pick(q, ID_KEYS);
    let tgId = Number(rawId);
    const idValid = Number.isSafeInteger(tgId) && tgId > 0;
    let lead: { rowCount: number | null; rows: any[] } = { rowCount: 0, rows: [] };
    if (idValid) {
      lead = await db.query('SELECT tg_id, status, access, trader_id, owner_id FROM leads WHERE tg_id = $1', [tgId]);
    }
    if (!lead.rowCount && traderId) {
      lead = await db.query('SELECT tg_id, status, access, trader_id, owner_id FROM leads WHERE trader_id = $1 LIMIT 1', [traderId]);
      if (lead.rowCount) tgId = Number(lead.rows[0].tg_id);
    }
    if (!lead.rowCount) {
      let why: string;
      if (!rawId) why = `клиент не из бота (Pocket ID ${traderId || 'нет'}, нет click_id)`;
      else if (!idValid) why = `клиент не из бота (click_id не число: "${rawId.slice(0, 40)}")`;
      else why = `клиент не из бота (Telegram ID ${tgId} не найден, нужен /start у бота)`;
      await log(event, q, idValid ? tgId : null, 'пропущен: ' + why);
      // Отвечаем «принято», иначе партнёрка будет повторять запрос. Событие чужого клиента нам не нужно
      return { ok: true, ignored: true, reason: why };
    }
    if (traderId && !lead.rows[0].trader_id) {
      await db.query('UPDATE leads SET trader_id = $2 WHERE tg_id = $1 AND trader_id IS NULL', [tgId, traderId]);
    }
    // Лид без владельца (пришёл не через нашу ссылку): закрепляем по коду кампании {ac}
    if (!lead.rows[0].owner_id && q.ac) {
      const o = await db.query('SELECT id FROM staff WHERE lower(po_campaign) = lower($1) AND active', [q.ac]);
      if (o.rowCount) await db.query('UPDATE leads SET owner_id = $2 WHERE tg_id = $1 AND owner_id IS NULL', [tgId, o.rows[0].id]);
    }
    const amount = Math.abs(Number(pick(q, AMOUNT_KEYS))) || null;

    // Повторы одного и того же постбека не должны задваивать деньги
    const tx = pick(q, TX_KEYS);
    const { secret: _s, ...forHash } = q;
    const fingerprint = tx
      ? `${event}:${tx}`
      : event === 'reg' || event === 'ftd'
        ? `${event}:${tgId}`
        : `${event}:${createHash('sha1').update(JSON.stringify(Object.entries(forHash).sort())).digest('hex')}`;

    const ins = await db.query(
      `INSERT INTO events (tg_id, type, amount, external_id, raw)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (external_id) DO NOTHING RETURNING id`,
      [tgId, event, amount, fingerprint, JSON.stringify(forHash)],
    );
    if (!ins.rowCount) {
      await log(event, q, tgId, 'дубль, пропущен');
      return { ok: true, duplicate: true };
    }

    const cur = lead.rows[0];
    if (event === 'reg' && cur.status === 'new') {
      await db.query(`UPDATE leads SET status = 'registered' WHERE tg_id = $1`, [tgId]);
    }
    if (event === 'ftd' || event === 'dep') {
      // Доступ открывается, когда сумма пополнений достигла минимума. Если партнёрка не прислала сумму, проверить нечем, открываем
      const tot = Number((await db.query(`SELECT coalesce(sum(amount), 0) AS s FROM events WHERE tg_id = $1 AND type IN ('ftd','dep')`, [tgId])).rows[0].s);
      // 10% запас: сумма в постбеке может быть чуть меньше из-за курса в Pocket Option
      const enough = amount === null || tot >= config.minDeposit * 0.9;
      if (enough) {
        if (event === 'ftd' || (event === 'dep' && !['ftd', 'active'].includes(cur.status))) {
          // Первый достаточный депозит: открываем анализ. Лид из старого бота приходит сразу с додепом без FTD:
          // он «активный» (его первый депозит был раньше), а не FTD
          await db.query(`UPDATE leads SET status = $2, access = (removed_at IS NULL) WHERE tg_id = $1`, [tgId, event === 'ftd' ? 'ftd' : 'active']);
        } else {
          await db.query(`UPDATE leads SET status = 'active' WHERE tg_id = $1 AND status = 'ftd'`, [tgId]);
        }
      } else if (cur.status === 'new') {
        await db.query(`UPDATE leads SET status = 'registered' WHERE tg_id = $1`, [tgId]);
      }
    }

    // Комиссия по клиенту значит, что он торгует на своих депозитах (перенос из старого бота): статус «активный» и доступ
    if (event === 'comm' && amount && ['new', 'registered'].includes(cur.status)) {
      await db.query(`UPDATE leads SET status = 'active', access = (removed_at IS NULL) WHERE tg_id = $1`, [tgId]);
    }

    // Пуши по событию (например «Депозит получен») уходят сразу. Сбой пуша не должен ломать постбек
    await processLead(tgId).catch(() => {});
    await log(event, q, tgId, 'ok', Number(ins.rows[0].id));
    return { ok: true };
  };

  app.get('/postback/:event', handler);
  app.post('/postback/:event', handler);
}
