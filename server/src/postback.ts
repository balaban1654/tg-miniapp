import type { FastifyInstance } from 'fastify';
import { accrueReferral } from './referral.js';
import { markLeadBlocked } from './leadblock.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { db, pickOrganicOwner, pickFallbackOwner } from './db.js';
import { config } from './config.js';
import { processLead } from './push.js';
import { requiredFor, markConnected, paidRequired, TOL } from './connect.js';

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
      lead = await db.query('SELECT tg_id, status, status_before_block, access, trader_id, owner_id, rereg_at FROM leads WHERE tg_id = $1', [tgId]);
    }
    if (!lead.rowCount && traderId) {
      lead = await db.query('SELECT tg_id, status, status_before_block, access, trader_id, owner_id, rereg_at FROM leads WHERE trader_id = $1 OR tg_id = (SELECT tg_id FROM lead_pockets WHERE trader_id = $1) LIMIT 1', [traderId]);
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
    // Старый Pocket ID после «Разрешить новую регистрацию» лежит в lead_pockets: основным его обратно не ставим
    const oldPocket = traderId ? !!(await db.query('SELECT 1 FROM lead_pockets WHERE trader_id = $1 AND tg_id = $2', [traderId, tgId])).rowCount : false;
    if (traderId && !lead.rows[0].trader_id && !oldPocket) {
      await db.query('UPDATE leads SET trader_id = $2 WHERE tg_id = $1 AND trader_id IS NULL', [tgId, traderId]);
    }
    // Ещё один Pocket ID того же человека (вторая регистрация, депозит с другого аккаунта): пишем в карточку списком, основной не меняем
    let newPocket = false;
    if (traderId && lead.rows[0].trader_id && lead.rows[0].trader_id !== traderId && !oldPocket) {
      newPocket = !!(await db.query('INSERT INTO lead_pockets (trader_id, tg_id) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM leads WHERE trader_id = $1) ON CONFLICT DO NOTHING', [traderId, tgId])).rowCount;
    }
    // Новая регистрация после «Разрешить новую регистрацию»: Pocket ID уже стал основным (выше), статус снова «Регистрация».
    // Регистрация считается в день, когда пришла (старая остаётся в своём месяце); в списке «Лиды» лид встаёт на эту дату
    if (event === 'reg' && lead.rows[0].rereg_at && !oldPocket) {
      await db.query(`UPDATE leads SET rereg_at = NULL, status = CASE WHEN status = 'new' THEN 'registered' ELSE status END WHERE tg_id = $1`, [tgId]);
      const { secret: _x, ...raw } = q;
      const ev = await db.query(`INSERT INTO events (tg_id, type, amount, external_id, raw) VALUES ($1,'reg',NULL,$2,$3) ON CONFLICT (external_id) DO NOTHING RETURNING id`,
        [tgId, `reg:${tgId}:${traderId || Date.now()}`, JSON.stringify(raw)]);
      await log(event, q, tgId, 'ok: новая регистрация (повторная)', ev.rows[0]?.id ?? null);
      return { ok: true, rereg: true };
    }
    // Лид без владельца. Пришёл по ссылке стримера — у него уже есть владелец, его не трогаем (в том числе при регистрации через общую демо-ссылку).
    // Органика (сам нашёл бота или с сайта): владелец по настройкам «Органика» (например, «Случайно»); если там «Не закреплять» — по коду кампании {ac}
    if (!lead.rows[0].owner_id) {
      const meta = (await db.query('SELECT link_id, origin FROM leads WHERE tg_id = $1', [tgId])).rows[0];
      const org = meta && !meta.link_id ? await pickOrganicOwner(meta.origin === 'site' ? 'site' : 'org', tgId) : null;
      const byAc = !org && q.ac ? (await db.query('SELECT id FROM staff WHERE lower(po_campaign) = lower($1) AND active', [q.ac])).rows[0]?.id : null;
      const owner = org ?? byAc ?? (await pickFallbackOwner(tgId));
      if (owner) await db.query('UPDATE leads SET owner_id = $2 WHERE tg_id = $1 AND owner_id IS NULL', [tgId, owner]);
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
      await log(event, q, tgId, newPocket ? 'ok: ещё один Pocket ID лида, добавлен в карточку' : 'дубль, пропущен');
      return { ok: true, duplicate: true };
    }

    // Стримеру сообщаем о новом событии его клиента. Импорт задним числом не в счёт, ручное добавление уведомляет как настоящий постбек
    if (['reg', 'ftd', 'dep', 'wd'].includes(event) && q.imported !== '1') {
      await db
        .query(
          `INSERT INTO lead_notices (staff_id, tg_id, kind)
           SELECT d.owner_id, d.tg_id, $2 FROM leads d JOIN staff s ON s.id = d.owner_id AND s.role = 'streamer' AND s.active
            WHERE d.tg_id = $1 AND coalesce(d.lead_role, 'lead') = 'lead' AND d.removed_at IS NULL`,
          [tgId, event],
        )
        .catch(() => {});
    }

    const cur = lead.rows[0];
    // Лид в «Отвале» из-за блокировки бота: статус воронки считаем по прежнему (FTD, регистрация), а после снова ставим «Отвал»
    const wasBlocked = cur.status === 'churned' && cur.status_before_block;
    if (wasBlocked) {
      await db.query(`UPDATE leads SET status = status_before_block, status_before_block = NULL WHERE tg_id = $1`, [tgId]);
      cur.status = cur.status_before_block;
    }
    if (event === 'reg' && cur.status === 'new') {
      await db.query(`UPDATE leads SET status = 'registered' WHERE tg_id = $1`, [tgId]);
    }
    if (event === 'ftd' || event === 'dep') {
      // Доступ открывается, когда сумма пополнений достигла минимума. Если партнёрка не прислала сумму, проверить нечем, открываем
      const tot = Number((await db.query(`SELECT coalesce(sum(amount), 0) AS s FROM events WHERE tg_id = $1 AND type IN ('ftd','dep')`, [tgId])).rows[0].s);
      // 10% запас: сумма в постбеке может быть чуть меньше из-за курса в Pocket Option
      // Без суммы доверяем только FTD (партнёрка иногда не присылает сумму первого депозита); додеп без суммы доступ не открывает
      const enough = (amount === null && event === 'ftd') || tot >= (await requiredFor(tgId)).required * TOL;
      // «Активный» - только после додепа с суммой: пустой постбек dep (без суммы) статус не повышает
      const depPaid = event === 'dep' && amount !== null;
      if (enough) {
        if (event === 'ftd' || (event === 'dep' && !['ftd', 'active'].includes(cur.status))) {
          // Первый достаточный депозит: открываем анализ. Лид из старого бота приходит сразу с додепом без FTD:
          // он «активный» (его первый депозит был раньше), а не FTD
          // FTD, пришедший позже додепа (события приходят не по порядку), не должен понижать «Активного» до FTD
          const hasDep = event === 'ftd' && (await db.query(`SELECT 1 FROM events WHERE tg_id = $1 AND type = 'dep' AND coalesce(amount, 0) > 0 LIMIT 1`, [tgId])).rowCount;
          await db.query(`UPDATE leads SET status = $2, access = (removed_at IS NULL) WHERE tg_id = $1`, [tgId, (event === 'ftd' && hasDep) || depPaid ? 'active' : 'ftd']);
        } else if (depPaid) {
          await db.query(`UPDATE leads SET status = 'active' WHERE tg_id = $1 AND status = 'ftd'`, [tgId]);
        }
        await markConnected(tgId, tot).catch(() => {});
        // Друг по реферальной ссылке получил доступ первым депозитом: бонус пригласившему и трейдеру
        await accrueReferral(tgId).catch((e) => console.error('Реферальный бонус: сбой', e));
      } else if (cur.status === 'new') {
        await db.query(`UPDATE leads SET status = 'registered' WHERE tg_id = $1`, [tgId]);
      }
    }

    // Комиссия статус и доступ не меняет: «Активный» - только после додепа с суммой после FTD

    if (wasBlocked) await markLeadBlocked(tgId);

    // Пуши по событию (например «Депозит получен») уходят сразу. Сбой пуша не должен ломать постбек
    await processLead(tgId).catch(() => {});
    await log(event, q, tgId, 'ok', Number(ins.rows[0].id));
    return { ok: true };
  };

  app.get('/postback/:event', handler);
  app.post('/postback/:event', handler);
}

/** Разовый пересчёт после исправления правил (ноябрь 2026): лиды, ставшие «Активными» и получившие доступ
 *  за комиссию при FTD меньше нужной суммы, и «Активные» только с пустым (без суммы) постбеком додепа.
 *  Сотрудников, тестовых и клиентов старого бота без депозитов не трогает. Выполняется один раз */
export async function fixLeadStatusesOnce(): Promise<{ downgraded: string[]; toFtd: string[] } | null> {
  const KEY = 'fix_status_2026_11';
  if ((await db.query(`SELECT 1 FROM app_settings WHERE key = $1`, [KEY])).rowCount) return null;
  const rows = (await db.query(
    `SELECT d.tg_id::text AS tg_id, coalesce(d.first_name, d.username, d.tg_id::text) AS name, d.status, d.access,
            coalesce(sum(e.amount) FILTER (WHERE e.type IN ('ftd','dep')), 0)::float AS tot,
            bool_or(e.type = 'ftd' AND e.amount IS NULL) AS ftd_noamount,
            bool_or(e.type = 'dep' AND coalesce(e.amount, 0) > 0) AS dep_paid, bool_or(e.type = 'ftd') AS has_ftd
       FROM leads d JOIN events e ON e.tg_id = d.tg_id AND e.type IN ('ftd','dep')
      WHERE d.removed_at IS NULL AND coalesce(d.lead_role, 'lead') = 'lead' AND NOT coalesce(d.is_tester, FALSE)
        AND d.status IN ('ftd','active')
      GROUP BY d.tg_id`,
  )).rows as { tg_id: string; name: string; status: string; access: boolean; tot: number; ftd_noamount: boolean; dep_paid: boolean; has_ftd: boolean }[];
  const downgraded: string[] = [], toFtd: string[] = [];
  for (const r of rows) {
    const enough = r.ftd_noamount || r.tot >= (await paidRequired(r.tg_id)) * TOL;
    // Закрываем доступ только при настоящем FTD у нас: клиенты из старого бота (одни додепы) не трогаем
    if (!enough && r.has_ftd) {
      await db.query(`UPDATE leads SET status = 'registered', access = FALSE WHERE tg_id = $1`, [r.tg_id]);
      downgraded.push(`${r.name} (${r.tg_id}, $${r.tot})`);
    } else if (r.status === 'active' && !r.dep_paid) {
      await db.query(`UPDATE leads SET status = 'ftd' WHERE tg_id = $1`, [r.tg_id]);
      toFtd.push(`${r.name} (${r.tg_id})`);
    }
  }
  await db.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO NOTHING`, [KEY, JSON.stringify({ downgraded, toFtd })]);
  return { downgraded, toFtd };
}
