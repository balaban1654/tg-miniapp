import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db.js';
import { config } from './config.js';
import type { Role } from './auth.js';

/*
 * monobank API (https://api.monobank.ua/docs/): раздел «МоноБанк API» в кабинете, только админ.
 * Админ вводит личный токен, сервер в фоне:
 *  - раз в 5 минут берёт /personal/client-info: счета, банки и их балансы;
 *  - загружает историю операций /personal/statement за выбранный срок (окно до 31 дня + 1 час,
 *    до 500 операций за ответ: если пришло 500, следующий запрос с to = время последней операции);
 *  - потом дозагружает новые операции по кругу и, если включено, принимает их мгновенно через вебхук.
 * Ограничение monobank: client-info и выписка не чаще 1 раза в 60 секунд, поэтому все запросы идут по очереди.
 * Суммы хранятся как в API: в копейках (центах), плюс = пополнение.
 */

// MONO_API_URL и MONO_GAP_MS переопределяются только для проверки на локальной имитации API
const API = process.env.MONO_API_URL || 'https://api.monobank.ua';
const GAP = Number(process.env.MONO_GAP_MS) || 61_000; // пауза между вызовами одной функции API
const WIN = 31 * 86400; // окно выписки (лимит 31 день + 1 час, берём с запасом)
const INFO_EVERY = 5 * 60_000;

type Pre = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
interface Helpers {
  need: (...roles: Role[]) => Pre;
  str: (v: unknown, max?: number) => string;
}

interface Settings {
  token: string | null;
  client_id: string | null;
  client_name: string | null;
  history_days: number;
  use_webhook: boolean;
  hook_secret: string | null;
  webhook_url: string | null;
  webhook_ok: boolean;
  last_info_at: string | null;
  last_error: string | null;
  watch_account: string | null;
}

class MonoError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call(token: string, path: string, init?: RequestInit): Promise<any> {
  const r = await fetch(API + path, { ...init, headers: { 'X-Token': token, 'content-type': 'application/json', ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* не JSON */
  }
  if (!r.ok) {
    const msg =
      r.status === 403 || r.status === 401
        ? 'Токен не подошёл: monobank его не принял. Создайте новый на api.monobank.ua и сохраните здесь'
        : r.status === 429
          ? 'monobank просит подождать (слишком частые запросы), продолжим через минуту'
          : (data?.errorDescription ?? `monobank ответил ошибкой ${r.status}`);
    throw new MonoError(r.status, msg);
  }
  return data;
}

const getSettings = async (): Promise<Settings | null> => (await db.query('SELECT * FROM mono_settings WHERE id = 1')).rows[0] ?? null;
const setError = (msg: string | null) => db.query('UPDATE mono_settings SET last_error = $1, error_at = CASE WHEN $1::text IS NULL THEN NULL ELSE now() END WHERE id = 1', [msg]);

/** Счета и банки из client-info: обновляем балансы, новые счета ставим в очередь на загрузку истории */
async function saveClientInfo(info: any, historyDays: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const since = now - historyDays * 86400;
  const rows: any[] = [
    ...(info.accounts ?? []).map((a: any) => ({
      id: a.id,
      kind: 'account',
      title: null,
      type: a.type ?? null,
      currency_code: a.currencyCode ?? null,
      balance: a.balance ?? 0,
      credit_limit: a.creditLimit ?? 0,
      goal: null,
      masked_pan: (a.maskedPan ?? []).join(', ') || null,
      iban: a.iban ?? null,
    })),
    ...(info.jars ?? []).map((j: any) => ({
      id: j.id,
      kind: 'jar',
      title: j.title ?? null,
      type: 'jar',
      currency_code: j.currencyCode ?? null,
      balance: j.balance ?? 0,
      credit_limit: 0,
      goal: j.goal ?? null,
      masked_pan: null,
      iban: null,
    })),
  ];
  for (const a of rows) {
    await db.query(
      `INSERT INTO mono_accounts (id, kind, title, type, currency_code, balance, credit_limit, goal, masked_pan, iban, bf_since, bf_cursor, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT (id) DO UPDATE SET kind = $2, title = $3, type = $4, currency_code = $5, balance = $6, credit_limit = $7, goal = $8,
         masked_pan = $9, iban = $10, updated_at = now()`,
      [a.id, a.kind, a.title, a.type, a.currency_code, a.balance, a.credit_limit, a.goal, a.masked_pan, a.iban, since, now],
    );
  }
  // Счета, которых больше нет у клиента, убираем из списка (операции остаются в истории)
  await db.query('DELETE FROM mono_accounts WHERE NOT (id = ANY($1::text[]))', [rows.map((a) => a.id)]);
  await db.query('UPDATE mono_settings SET client_id = $1, client_name = $2, last_info_at = now() WHERE id = 1', [info.clientId ?? null, info.name ?? null]);
}

async function saveItem(accountId: string, it: any): Promise<void> {
  if (!it?.id) return;
  await db.query(
    `INSERT INTO mono_tx (id, account_id, time, description, comment, counter_name, amount, operation_amount, currency_code, balance, hold, mcc)
     VALUES ($1,$2,to_timestamp($3),$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (id) DO UPDATE SET hold = EXCLUDED.hold, balance = EXCLUDED.balance, amount = EXCLUDED.amount, description = EXCLUDED.description`,
    [
      String(it.id),
      accountId,
      Number(it.time),
      it.description ?? null,
      it.comment ?? null,
      it.counterName ?? null,
      Number(it.amount) || 0,
      it.operationAmount ?? null,
      it.currencyCode ?? null,
      it.balance ?? null,
      it.hold ?? null,
      it.mcc ?? null,
    ],
  );
}

let lastInfo = 0;
let lastStatement = 0;
let lastHook = 0;
let busy = false;

/** Один шаг фоновой работы: не больше одного вызова каждой функции API в минуту */
export async function monoTick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const s = await getSettings();
    if (!s?.token) return;
    const now = Date.now();
    try {
      // 1. Счета и балансы
      const infoAge = s.last_info_at ? now - Date.parse(s.last_info_at) : Infinity;
      if (infoAge >= INFO_EVERY && now - lastInfo >= GAP) {
        lastInfo = now;
        await saveClientInfo(await call(s.token, '/personal/client-info'), s.history_days);
        await setError(null);
      }
      // 2. Вебхук: мгновенные операции (адрес должен быть https и доступен снаружи)
      const hookUrl = s.hook_secret && /^https:\/\//.test(config.publicUrl) ? `${config.publicUrl.replace(/\/$/, '')}/api/mono/hook/${s.hook_secret}` : null;
      if (s.use_webhook && hookUrl && (!s.webhook_ok || s.webhook_url !== hookUrl) && now - lastHook >= GAP) {
        lastHook = now;
        await call(s.token, '/personal/webhook', { method: 'POST', body: JSON.stringify({ webHookUrl: hookUrl }) });
        await db.query('UPDATE mono_settings SET webhook_ok = TRUE, webhook_url = $1 WHERE id = 1', [hookUrl]);
      }
      // 3. Выписка: сначала история (от новых к старым), потом дозагрузка новых операций по кругу
      if (now - lastStatement < GAP) return;
      const nowS = Math.floor(now / 1000);
      const bf = (await db.query('SELECT id, bf_since, bf_cursor FROM mono_accounts WHERE bf_cursor > bf_since ORDER BY kind, id LIMIT 1')).rows[0];
      if (bf) {
        const to = Number(bf.bf_cursor);
        const from = Math.max(Number(bf.bf_since), to - WIN);
        lastStatement = now;
        const items: any[] = (await call(s.token, `/personal/statement/${bf.id}/${from}/${to}`)) ?? [];
        for (const it of items) await saveItem(bf.id, it);
        let next = from;
        if (items.length >= 500) {
          // Ответ обрезан: продолжаем с времени последней (самой старой) операции
          const oldest = Math.min(...items.map((x) => Number(x.time)));
          next = oldest < to ? oldest : to - 1;
        }
        await db.query('UPDATE mono_accounts SET bf_cursor = $2, synced_to = coalesce(synced_to, $3) WHERE id = $1', [bf.id, next, nowS]);
        return;
      }
      // Дозагрузка: со вебхуком раз в 30 минут на счёт, без него раз в 5 минут.
      // Счёт, за которым следят в плитке «Общий баланс», без вебхука проверяем каждую минуту
      const live = !(s.use_webhook && s.webhook_ok);
      const watched =
        live && s.watch_account
          ? (await db.query('SELECT id, synced_to FROM mono_accounts WHERE id = $1 AND (synced_to IS NULL OR synced_to < $2)', [s.watch_account, nowS - 60])).rows[0]
          : null;
      const every = live ? 300 : 1800;
      const inc =
        watched ??
        (await db.query(`SELECT id, synced_to FROM mono_accounts WHERE synced_to IS NULL OR synced_to < $1 ORDER BY synced_to NULLS FIRST LIMIT 1`, [nowS - every])).rows[0];
      if (!inc) return;
      const from = Math.max(nowS - WIN, Number(inc.synced_to ?? nowS - 86400) - 3600);
      lastStatement = now;
      const items: any[] = (await call(s.token, `/personal/statement/${inc.id}/${from}/${nowS}`)) ?? [];
      for (const it of items) await saveItem(inc.id, it);
      if (items.length >= 500) {
        // Редкий случай: за окно больше 500 операций, догружаем остаток как историю
        const oldest = Math.min(...items.map((x) => Number(x.time)));
        await db.query('UPDATE mono_accounts SET bf_since = $2, bf_cursor = $3 WHERE id = $1', [inc.id, from, oldest]);
      }
      await db.query('UPDATE mono_accounts SET synced_to = $2, synced_at = now() WHERE id = $1', [inc.id, nowS]);
    } catch (e) {
      const err = e as MonoError;
      if (err.status === 403 || err.status === 401) await db.query('UPDATE mono_settings SET webhook_ok = FALSE WHERE id = 1');
      await setError(err.message || 'Не удалось связаться с monobank');
    }
  } finally {
    busy = false;
  }
}

/** Курсы monobank (публичные, кэш 5 минут): для пересчёта баланса в гривны */
type Rate = { code: number; buy: number | null; sell: number | null; cross: number | null; date: number };
let ratesCache: { at: number; rates: Map<number, number>; list: Rate[] } | null = null;
async function loadRates(): Promise<{ rates: Map<number, number>; list: Rate[] }> {
  if (ratesCache && Date.now() - ratesCache.at < 5 * 60_000) return ratesCache;
  const m = new Map<number, number>([[980, 1]]);
  const list: Rate[] = [];
  try {
    const r = await fetch(API + '/bank/currency', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(String(r.status));
    for (const x of (await r.json()) as any[]) {
      if (x.currencyCodeB !== 980) continue;
      m.set(x.currencyCodeA, Number(x.rateCross ?? x.rateBuy ?? 0) || 0);
      list.push({ code: x.currencyCodeA, buy: x.rateBuy ?? null, sell: x.rateSell ?? null, cross: x.rateCross ?? null, date: x.date });
    }
    ratesCache = { at: Date.now(), rates: m, list };
  } catch {
    if (ratesCache) return ratesCache;
  }
  return { rates: m, list };
}
const uahRates = async () => (await loadRates()).rates;

export async function monoRoutes(app: FastifyInstance, h: Helpers): Promise<void> {
  const admin = h.need('admin');

  // Состояние: подключение, счета и банки, общий баланс
  app.get('/mono', { preHandler: admin }, async () => {
    const s = await getSettings();
    const accounts = (await db.query(`SELECT * FROM mono_accounts ORDER BY kind, currency_code, id`)).rows;
    const rx = await loadRates();
    const rates = rx.rates;
    // Курсы для шапки раздела: доллар, евро, злотый, фунт (публичные курсы monobank, без токена)
    const shown = [840, 978, 985, 826].map((c) => rx.list.find((x) => x.code === c)).filter(Boolean);
    const byCur = new Map<number, number>();
    let uah = 0;
    let uahExact = true;
    for (const a of accounts) {
      // Свои средства: у кредитной карты баланс включает кредитный лимит
      const own = Number(a.balance) - Number(a.credit_limit || 0);
      byCur.set(a.currency_code, (byCur.get(a.currency_code) ?? 0) + own);
      const rate = rates.get(a.currency_code);
      if (rate) uah += (own / 100) * rate;
      else uahExact = false;
    }
    const pending = accounts.filter((a) => Number(a.bf_cursor) > Number(a.bf_since));
    const left = pending.reduce((acc, a) => acc + Math.ceil((Number(a.bf_cursor) - Number(a.bf_since)) / WIN), 0);
    const t = s?.token ?? '';
    return {
      rates: shown,
      connected: !!t,
      tokenMask: t ? '••••' + t.slice(-4) : null,
      clientName: s?.client_name ?? null,
      historyDays: s?.history_days ?? 90,
      useWebhook: s?.use_webhook ?? true,
      webhookOk: !!s?.webhook_ok,
      webhookPossible: /^https:\/\//.test(config.publicUrl),
      lastInfoAt: s?.last_info_at ?? null,
      lastError: s?.last_error ?? null,
      historyLeftMin: left, // примерно минут до конца загрузки истории (1 запрос в минуту)
      accounts: accounts.map((a) => ({
        id: a.id,
        kind: a.kind,
        title: a.title,
        type: a.type,
        currency: a.currency_code,
        balance: Number(a.balance),
        creditLimit: Number(a.credit_limit || 0),
        goal: a.goal === null ? null : Number(a.goal),
        maskedPan: a.masked_pan,
        iban: a.iban,
        loading: Number(a.bf_cursor) > Number(a.bf_since),
        hidden: !!a.hidden,
      })),
      watchAccount: s?.watch_account ?? null,
      totals: { byCurrency: [...byCur].map(([currency, amount]) => ({ currency, amount })), uah: Math.round(uah * 100) / 100, uahExact },
    };
  });

  // Сохранить токен (и настройки). Токен сразу проверяем запросом client-info
  app.put('/mono/token', { preHandler: admin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const token = h.str(b.token, 200);
    const days = [30, 90, 180, 365].includes(Number(b.historyDays)) ? Number(b.historyDays) : 90;
    const useWebhook = b.useWebhook !== false;
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return reply.code(400).send({ error: 'Вставьте токен целиком (его выдаёт api.monobank.ua)' });
    if (Date.now() - lastInfo < GAP) return reply.code(429).send({ error: 'monobank разрешает проверять токен раз в минуту. Подождите немного и сохраните снова' });
    let info: any;
    try {
      lastInfo = Date.now();
      info = await call(token, '/personal/client-info');
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const prev = await getSettings();
    // Другой владелец токена: прежние счета и операции убираем, историю грузим заново
    if (prev?.client_id && info.clientId && prev.client_id !== info.clientId) {
      await db.query('DELETE FROM mono_accounts');
      await db.query('DELETE FROM mono_tx');
    }
    await db.query(
      `INSERT INTO mono_settings (id, token, history_days, use_webhook, hook_secret, webhook_ok, updated_at, updated_by, last_error)
       VALUES (1, $1, $2, $3, $4, FALSE, now(), $5, NULL)
       ON CONFLICT (id) DO UPDATE SET token = $1, history_days = $2, use_webhook = $3, hook_secret = coalesce(mono_settings.hook_secret, $4),
         webhook_ok = FALSE, updated_at = now(), updated_by = $5, last_error = NULL, error_at = NULL`,
      [token, days, useWebhook, randomBytes(18).toString('hex'), req.staff!.id],
    );
    await saveClientInfo(info, days);
    setImmediate(() => void monoTick());
    return { ok: true, clientName: info.name ?? null };
  });

  // Срок истории и вебхук без смены токена. Больший срок: догружаем недостающее
  app.put('/mono/settings', { preHandler: admin }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const days = [30, 90, 180, 365].includes(Number(b.historyDays)) ? Number(b.historyDays) : null;
    if (!days) return reply.code(400).send({ error: 'Выберите срок истории' });
    const s = await getSettings();
    if (!s?.token) return reply.code(400).send({ error: 'Сначала сохраните токен' });
    await db.query('UPDATE mono_settings SET history_days = $1, use_webhook = $2, webhook_ok = CASE WHEN $2 THEN webhook_ok ELSE FALSE END WHERE id = 1', [days, b.useWebhook !== false]);
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    // Загрузка идёт от новых к старым: если новый срок длиннее, продолжаем с того места, где остановились
    await db.query('UPDATE mono_accounts SET bf_since = $1 WHERE bf_since IS NULL OR $1 < bf_since', [since]);
    setImmediate(() => void monoTick());
    return { ok: true };
  });

  // Скрыть или снова показать счёт в списке (в общем балансе он остаётся)
  app.patch<{ Params: { id: string } }>('/mono/accounts/:id', { preHandler: admin }, async (req, reply) => {
    const hidden = !!((req.body ?? {}) as Record<string, unknown>).hidden;
    const r = await db.query('UPDATE mono_accounts SET hidden = $2 WHERE id = $1 RETURNING id', [req.params.id, hidden]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Счёт не найден' });
    return { ok: true };
  });
  // Счёт, за которым следим в плитке «Общий баланс» (null: не следим)
  app.put('/mono/watch', { preHandler: admin }, async (req, reply) => {
    const id = ((req.body ?? {}) as Record<string, unknown>).account;
    const acc = id ? String(id) : null;
    if (acc && !(await db.query('SELECT 1 FROM mono_accounts WHERE id = $1', [acc])).rowCount) return reply.code(404).send({ error: 'Счёт не найден' });
    await db.query('UPDATE mono_settings SET watch_account = $1 WHERE id = 1', [acc]);
    return { ok: true };
  });
  // Живая плитка: баланс выбранного счёта и последние пополнения на него
  app.get('/mono/watch', { preHandler: admin }, async () => {
    const s = await getSettings();
    if (!s?.watch_account) return { account: null };
    const a = (await db.query('SELECT * FROM mono_accounts WHERE id = $1', [s.watch_account])).rows[0];
    if (!a) return { account: null };
    const tx = (
      await db.query(
        `SELECT id, time, description, comment, counter_name, amount, hold FROM mono_tx WHERE account_id = $1 AND amount > 0 ORDER BY time DESC LIMIT 12`,
        [a.id],
      )
    ).rows.map((t) => ({ ...t, amount: Number(t.amount) }));
    const today = (
      await db.query(
        `SELECT coalesce(sum(amount), 0)::bigint AS s, count(*)::int AS n FROM mono_tx
          WHERE account_id = $1 AND amount > 0 AND (time AT TIME ZONE 'Europe/Kyiv')::date = (now() AT TIME ZONE 'Europe/Kyiv')::date`,
        [a.id],
      )
    ).rows[0];
    return {
      account: { id: a.id, kind: a.kind, title: a.title, type: a.type, currency: a.currency_code, balance: Number(a.balance) - Number(a.credit_limit || 0), maskedPan: a.masked_pan, goal: a.goal === null ? null : Number(a.goal) },
      today: { amount: Number(today.s), n: today.n },
      tx,
      live: !!(s.use_webhook && s.webhook_ok),
      now: new Date().toISOString(),
    };
  });

  // Отключить: токен и все загруженные данные удаляются
  app.delete('/mono', { preHandler: admin }, async () => {
    await db.query('DELETE FROM mono_settings');
    await db.query('DELETE FROM mono_accounts');
    await db.query('DELETE FROM mono_tx');
    return { ok: true };
  });

  // Пополнения за период (по Киеву): список и сумма по валютам
  app.get<{ Querystring: { from?: string; to?: string; account?: string } }>('/mono/incoming', { preHandler: admin }, async (req) => {
    const D = /^\d{4}-\d{2}-\d{2}$/;
    const from = D.test(String(req.query.from)) ? String(req.query.from) : null;
    const to = D.test(String(req.query.to)) ? String(req.query.to) : null;
    const acc = req.query.account ? String(req.query.account) : null;
    const where = `t.amount > 0 AND ($1::date IS NULL OR (t.time AT TIME ZONE 'Europe/Kyiv')::date >= $1::date)
      AND ($2::date IS NULL OR (t.time AT TIME ZONE 'Europe/Kyiv')::date <= $2::date) AND ($3::text IS NULL OR t.account_id = $3)`;
    const rows = (
      await db.query(
        `SELECT t.id, t.account_id, t.time, t.description, t.comment, t.counter_name, t.amount, t.currency_code, t.hold,
                a.kind, a.title, a.masked_pan, a.currency_code AS acc_currency
           FROM mono_tx t LEFT JOIN mono_accounts a ON a.id = t.account_id WHERE ${where} ORDER BY t.time DESC LIMIT 500`,
        [from, to, acc],
      )
    ).rows;
    const sums = (
      await db.query(
        `SELECT coalesce(a.currency_code, t.currency_code) AS currency, sum(t.amount)::bigint AS amount, count(*)::int AS n
           FROM mono_tx t LEFT JOIN mono_accounts a ON a.id = t.account_id WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`,
        [from, to, acc],
      )
    ).rows;
    return {
      rows: rows.map((r) => ({ ...r, amount: Number(r.amount), currency: r.acc_currency ?? r.currency_code })),
      sums: sums.map((x) => ({ currency: x.currency, amount: Number(x.amount), n: x.n })),
    };
  });
}

/** Вебхук monobank: GET для проверки адреса (нужен ответ 200), POST с новой операцией */
export async function monoHookRoutes(app: FastifyInstance): Promise<void> {
  const ok = async (secret: string) => {
    const s = await getSettings();
    return !!s?.token && !!s.hook_secret && s.hook_secret === secret;
  };
  app.get<{ Params: { secret: string } }>('/api/mono/hook/:secret', async (_req, reply) => reply.code(200).send('ok'));
  app.post<{ Params: { secret: string } }>('/api/mono/hook/:secret', async (req, reply) => {
    if (!(await ok(req.params.secret))) return reply.code(200).send('ok');
    const b = (req.body ?? {}) as any;
    if (b.type === 'StatementItem' && b.data?.account && b.data?.statementItem) {
      const acc = String(b.data.account);
      const it = b.data.statementItem;
      await saveItem(acc, it).catch(() => {});
      if (it.balance !== undefined) await db.query('UPDATE mono_accounts SET balance = $2, updated_at = now() WHERE id = $1', [acc, Number(it.balance)]).catch(() => {});
    }
    return reply.code(200).send('ok');
  });
}

export function startMonoWorker(log: { error: (o: unknown, m: string) => void }): void {
  setInterval(() => void monoTick().catch((e) => log.error(e, 'monobank: ошибка фоновой загрузки')), Math.min(15_000, GAP));
}
