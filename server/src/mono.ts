import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db.js';
import { config } from './config.js';
import type { Role } from './auth.js';

/*
 * monobank API (https://api.monobank.ua/docs/): раздел «МоноБанк API» в кабинете, только админ.
 * Вкладки раздела: несколько подключений (свой счёт, жены, мамы...), у каждого свой личный токен.
 * Для каждого подключения сервер в фоне:
 *  - раз в 5 минут берёт /personal/client-info: счета, банки и их балансы;
 *  - загружает историю операций /personal/statement за выбранный срок (окно до 31 дня + 1 час,
 *    до 500 операций за ответ: если пришло 500, следующий запрос с to = время последней операции);
 *  - потом дозагружает новые операции по кругу и, если включено, принимает их мгновенно через вебхук.
 * Ограничение monobank: client-info и выписка не чаще 1 раза в 60 секунд на токен, поэтому запросы идут по очереди.
 * Суммы хранятся как в API: в копейках (центах), плюс = пополнение.
 */

// MONO_API_URL и MONO_GAP_MS переопределяются только для проверки на локальной имитации API
const API = process.env.MONO_API_URL || 'https://api.monobank.ua';
const GAP = Number(process.env.MONO_GAP_MS) || 61_000; // пауза между вызовами одной функции API для одного токена
const WIN = 31 * 86400; // окно выписки (лимит 31 день + 1 час, берём с запасом)
const INFO_EVERY = 5 * 60_000;
const DAYS = [30, 90, 180, 365];

type Pre = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
interface Helpers {
  need: (...roles: Role[]) => Pre;
  str: (v: unknown, max?: number) => string;
}

interface Profile {
  id: number;
  title: string | null;
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

const getProfile = async (id: number): Promise<Profile | null> => (await db.query('SELECT * FROM mono_settings WHERE id = $1', [id])).rows[0] ?? null;
const setError = (pid: number, msg: string | null) =>
  db.query('UPDATE mono_settings SET last_error = $2, error_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END WHERE id = $1', [pid, msg]);
const defaultTitle = (p: Pick<Profile, 'id' | 'title' | 'client_name'>, i: number) => p.title || p.client_name || (i === 0 ? 'Мой счёт' : 'Вкладка ' + (i + 1));

/** Счета и банки из client-info: обновляем балансы, новые счета ставим в очередь на загрузку истории */
async function saveClientInfo(pid: number, info: any, historyDays: number): Promise<void> {
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
      `INSERT INTO mono_accounts (id, profile_id, kind, title, type, currency_code, balance, credit_limit, goal, masked_pan, iban, bf_since, bf_cursor, updated_at)
       VALUES ($1,$13,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
       ON CONFLICT (id) DO UPDATE SET profile_id = $13, kind = $2, title = $3, type = $4, currency_code = $5, balance = $6, credit_limit = $7, goal = $8,
         masked_pan = $9, iban = $10, updated_at = now()`,
      [a.id, a.kind, a.title, a.type, a.currency_code, a.balance, a.credit_limit, a.goal, a.masked_pan, a.iban, since, now, pid],
    );
  }
  // Счета, которых больше нет у клиента, убираем из списка (операции остаются в истории)
  await db.query('DELETE FROM mono_accounts WHERE profile_id = $1 AND NOT (id = ANY($2::text[]))', [pid, rows.map((a) => a.id)]);
  await db.query('UPDATE mono_settings SET client_id = $2, client_name = $3, last_info_at = now() WHERE id = $1', [pid, info.clientId ?? null, info.name ?? null]);
}

async function saveItem(pid: number, accountId: string, it: any): Promise<void> {
  if (!it?.id) return;
  await db.query(
    `INSERT INTO mono_tx (id, profile_id, account_id, time, description, comment, counter_name, amount, operation_amount, currency_code, balance, hold, mcc)
     VALUES ($1,$13,$2,to_timestamp($3),$4,$5,$6,$7,$8,$9,$10,$11,$12)
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
      pid,
    ],
  );
}

/** Когда в последний раз вызывали функции API по токену подключения (лимит monobank: раз в 60 секунд) */
const calls = new Map<number, { info: number; statement: number; hook: number }>();
const callsOf = (pid: number) => {
  let c = calls.get(pid);
  if (!c) calls.set(pid, (c = { info: 0, statement: 0, hook: 0 }));
  return c;
};
let busy = false;

/** Один шаг фоновой работы для одного подключения: не больше одного вызова каждой функции API в минуту */
async function tickProfile(s: Profile): Promise<void> {
  if (!s.token) return;
  const pid = s.id;
  const c = callsOf(pid);
  const now = Date.now();
  try {
    // 1. Счета и балансы
    const infoAge = s.last_info_at ? now - Date.parse(s.last_info_at) : Infinity;
    if (infoAge >= INFO_EVERY && now - c.info >= GAP) {
      c.info = now;
      await saveClientInfo(pid, await call(s.token, '/personal/client-info'), s.history_days);
      await setError(pid, null);
    }
    // 2. Вебхук: мгновенные операции (адрес должен быть https и доступен снаружи)
    const hookUrl = s.hook_secret && /^https:\/\//.test(config.publicUrl) ? `${config.publicUrl.replace(/\/$/, '')}/api/mono/hook/${s.hook_secret}` : null;
    if (s.use_webhook && hookUrl && (!s.webhook_ok || s.webhook_url !== hookUrl) && now - c.hook >= GAP) {
      c.hook = now;
      await call(s.token, '/personal/webhook', { method: 'POST', body: JSON.stringify({ webHookUrl: hookUrl }) });
      await db.query('UPDATE mono_settings SET webhook_ok = TRUE, webhook_url = $2 WHERE id = $1', [pid, hookUrl]);
    }
    // 3. Выписка: сначала история (от новых к старым), потом дозагрузка новых операций по кругу
    if (now - c.statement < GAP) return;
    const nowS = Math.floor(now / 1000);
    const bf = (await db.query('SELECT id, bf_since, bf_cursor FROM mono_accounts WHERE profile_id = $1 AND bf_cursor > bf_since ORDER BY kind, id LIMIT 1', [pid])).rows[0];
    if (bf) {
      const to = Number(bf.bf_cursor);
      const from = Math.max(Number(bf.bf_since), to - WIN);
      c.statement = now;
      const items: any[] = (await call(s.token, `/personal/statement/${bf.id}/${from}/${to}`)) ?? [];
      for (const it of items) await saveItem(pid, bf.id, it);
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
        ? (await db.query('SELECT id, synced_to FROM mono_accounts WHERE id = $1 AND profile_id = $2 AND (synced_to IS NULL OR synced_to < $3)', [s.watch_account, pid, nowS - 60]))
            .rows[0]
        : null;
    const every = live ? 300 : 1800;
    const inc =
      watched ??
      (
        await db.query(`SELECT id, synced_to FROM mono_accounts WHERE profile_id = $1 AND (synced_to IS NULL OR synced_to < $2) ORDER BY synced_to NULLS FIRST LIMIT 1`, [
          pid,
          nowS - every,
        ])
      ).rows[0];
    if (!inc) return;
    const from = Math.max(nowS - WIN, Number(inc.synced_to ?? nowS - 86400) - 3600);
    c.statement = now;
    const items: any[] = (await call(s.token, `/personal/statement/${inc.id}/${from}/${nowS}`)) ?? [];
    for (const it of items) await saveItem(pid, inc.id, it);
    if (items.length >= 500) {
      // Редкий случай: за окно больше 500 операций, догружаем остаток как историю
      const oldest = Math.min(...items.map((x) => Number(x.time)));
      await db.query('UPDATE mono_accounts SET bf_since = $2, bf_cursor = $3 WHERE id = $1', [inc.id, from, oldest]);
    }
    await db.query('UPDATE mono_accounts SET synced_to = $2, synced_at = now() WHERE id = $1', [inc.id, nowS]);
  } catch (e) {
    const err = e as MonoError;
    if (err.status === 403 || err.status === 401) await db.query('UPDATE mono_settings SET webhook_ok = FALSE WHERE id = $1', [pid]);
    await setError(pid, err.message || 'Не удалось связаться с monobank');
  }
}

export async function monoTick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const list = (await db.query('SELECT * FROM mono_settings WHERE token IS NOT NULL ORDER BY id')).rows as Profile[];
    for (const p of list) await tickProfile(p);
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

export async function monoRoutes(app: FastifyInstance, h: Helpers): Promise<void> {
  const admin = h.need('admin');
  // Вкладка из адреса: /mono/:pid/...
  const prof = async (req: FastifyRequest, reply: FastifyReply): Promise<Profile | null> => {
    const p = await getProfile(Number((req.params as any).pid));
    if (!p) {
      reply.code(404).send({ error: 'Вкладка не найдена' });
      return null;
    }
    return p;
  };
  const listProfiles = async () => {
    // Первая вкладка есть всегда, даже пустая
    if (!(await db.query('SELECT 1 FROM mono_settings LIMIT 1')).rowCount) await db.query('INSERT INTO mono_settings DEFAULT VALUES');
    const rows = (await db.query('SELECT id, title, client_name, token IS NOT NULL AS connected, last_error FROM mono_settings ORDER BY id')).rows;
    return rows.map((p, i) => ({ id: p.id, title: defaultTitle(p, i), connected: p.connected, error: !!p.last_error }));
  };

  // Вкладки и курсы валют (курсы публичные, видны и без токена)
  app.get('/mono', { preHandler: admin }, async () => {
    const rx = await loadRates();
    // Курсы для шапки раздела: доллар, евро, злотый, фунт
    const rates = [840, 978, 985, 826].map((c) => rx.list.find((x) => x.code === c)).filter(Boolean);
    return { rates, profiles: await listProfiles() };
  });
  // Новая вкладка: пустое подключение, токен вводится в ней
  app.post('/mono/profiles', { preHandler: admin }, async (req) => {
    const title = h.str(((req.body ?? {}) as Record<string, unknown>).title, 40) || null;
    const n = Number((await db.query('SELECT count(*) AS n FROM mono_settings')).rows[0].n);
    const r = await db.query('INSERT INTO mono_settings (title) VALUES ($1) RETURNING id', [title ?? 'Вкладка ' + (n + 1)]);
    return { ok: true, id: r.rows[0].id };
  });
  // Переименовать вкладку
  app.patch<{ Params: { pid: string } }>('/mono/profiles/:pid', { preHandler: admin }, async (req, reply) => {
    const title = h.str(((req.body ?? {}) as Record<string, unknown>).title, 40);
    if (!title) return reply.code(400).send({ error: 'Введите название вкладки' });
    const r = await db.query('UPDATE mono_settings SET title = $2 WHERE id = $1 RETURNING id', [Number(req.params.pid), title]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Вкладка не найдена' });
    return { ok: true };
  });
  // Удалить вкладку целиком: токен, счета и операции этого подключения. Последнюю вкладку не удаляем, её можно только отключить
  app.delete<{ Params: { pid: string } }>('/mono/profiles/:pid', { preHandler: admin }, async (req, reply) => {
    const pid = Number(req.params.pid);
    if (Number((await db.query('SELECT count(*) AS n FROM mono_settings')).rows[0].n) <= 1) return reply.code(400).send({ error: 'Это единственная вкладка: её можно только отключить' });
    const r = await db.query('DELETE FROM mono_settings WHERE id = $1 RETURNING id', [pid]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Вкладка не найдена' });
    await db.query('DELETE FROM mono_accounts WHERE profile_id = $1', [pid]);
    await db.query('DELETE FROM mono_tx WHERE profile_id = $1', [pid]);
    calls.delete(pid);
    return { ok: true };
  });

  // Состояние вкладки: подключение, счета и банки, общий баланс
  app.get<{ Params: { pid: string } }>('/mono/:pid', { preHandler: admin }, async (req, reply) => {
    const s = await prof(req, reply);
    if (!s) return;
    const accounts = (await db.query(`SELECT * FROM mono_accounts WHERE profile_id = $1 ORDER BY kind, currency_code, id`, [s.id])).rows;
    const rates = accounts.length ? (await loadRates()).rates : new Map<number, number>();
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
    const t = s.token ?? '';
    return {
      id: s.id,
      connected: !!t,
      tokenMask: t ? '••••' + t.slice(-4) : null,
      clientName: s.client_name ?? null,
      historyDays: s.history_days ?? 90,
      useWebhook: s.use_webhook ?? true,
      webhookOk: !!s.webhook_ok,
      webhookPossible: /^https:\/\//.test(config.publicUrl),
      lastInfoAt: s.last_info_at ?? null,
      lastError: s.last_error ?? null,
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
      watchAccount: s.watch_account ?? null,
      totals: { byCurrency: [...byCur].map(([currency, amount]) => ({ currency, amount })), uah: Math.round(uah * 100) / 100, uahExact },
    };
  });

  // Сохранить токен вкладки (и настройки). Токен сразу проверяем запросом client-info
  app.put<{ Params: { pid: string } }>('/mono/:pid/token', { preHandler: admin }, async (req, reply) => {
    const s = await prof(req, reply);
    if (!s) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const token = h.str(b.token, 200);
    const days = DAYS.includes(Number(b.historyDays)) ? Number(b.historyDays) : 90;
    const useWebhook = b.useWebhook !== false;
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return reply.code(400).send({ error: 'Вставьте токен целиком (его выдаёт api.monobank.ua)' });
    const c = callsOf(s.id);
    if (Date.now() - c.info < GAP) return reply.code(429).send({ error: 'monobank разрешает проверять токен раз в минуту. Подождите немного и сохраните снова' });
    let info: any;
    try {
      c.info = Date.now();
      info = await call(token, '/personal/client-info');
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    // Один и тот же клиент monobank не подключаем в двух вкладках
    const dup = info.clientId ? (await db.query('SELECT id, title, client_name FROM mono_settings WHERE client_id = $1 AND id <> $2 AND token IS NOT NULL', [info.clientId, s.id])).rows[0] : null;
    if (dup) return reply.code(409).send({ error: `Этот клиент monobank уже подключён во вкладке «${dup.title || dup.client_name || dup.id}»` });
    // Другой владелец токена: прежние счета и операции вкладки убираем, историю грузим заново
    if (s.client_id && info.clientId && s.client_id !== info.clientId) {
      await db.query('DELETE FROM mono_accounts WHERE profile_id = $1', [s.id]);
      await db.query('DELETE FROM mono_tx WHERE profile_id = $1', [s.id]);
      await db.query('UPDATE mono_settings SET watch_account = NULL WHERE id = $1', [s.id]);
    }
    await db.query(
      `UPDATE mono_settings SET token = $2, history_days = $3, use_webhook = $4, hook_secret = coalesce(hook_secret, $5), webhook_ok = FALSE,
         updated_at = now(), updated_by = $6, last_error = NULL, error_at = NULL WHERE id = $1`,
      [s.id, token, days, useWebhook, randomBytes(18).toString('hex'), req.staff!.id],
    );
    await saveClientInfo(s.id, info, days);
    setImmediate(() => void monoTick());
    return { ok: true, clientName: info.name ?? null };
  });

  // Срок истории и вебхук без смены токена. Больший срок: догружаем недостающее
  app.put<{ Params: { pid: string } }>('/mono/:pid/settings', { preHandler: admin }, async (req, reply) => {
    const s = await prof(req, reply);
    if (!s) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const days = DAYS.includes(Number(b.historyDays)) ? Number(b.historyDays) : null;
    if (!days) return reply.code(400).send({ error: 'Выберите срок истории' });
    if (!s.token) return reply.code(400).send({ error: 'Сначала сохраните токен' });
    await db.query('UPDATE mono_settings SET history_days = $2, use_webhook = $3, webhook_ok = CASE WHEN $3 THEN webhook_ok ELSE FALSE END WHERE id = $1', [
      s.id,
      days,
      b.useWebhook !== false,
    ]);
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    // Загрузка идёт от новых к старым: если новый срок длиннее, продолжаем с того места, где остановились
    await db.query('UPDATE mono_accounts SET bf_since = $2 WHERE profile_id = $1 AND (bf_since IS NULL OR $2 < bf_since)', [s.id, since]);
    setImmediate(() => void monoTick());
    return { ok: true };
  });

  // Скрыть или снова показать счёт в списке (в общем балансе он остаётся)
  app.patch<{ Params: { pid: string; id: string } }>('/mono/:pid/accounts/:id', { preHandler: admin }, async (req, reply) => {
    const hidden = !!((req.body ?? {}) as Record<string, unknown>).hidden;
    const r = await db.query('UPDATE mono_accounts SET hidden = $3 WHERE id = $1 AND profile_id = $2 RETURNING id', [req.params.id, Number(req.params.pid), hidden]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Счёт не найден' });
    return { ok: true };
  });
  // Счёт, за которым следим в плитке «Общий баланс» (null: не следим)
  app.put<{ Params: { pid: string } }>('/mono/:pid/watch', { preHandler: admin }, async (req, reply) => {
    const s = await prof(req, reply);
    if (!s) return;
    const id = ((req.body ?? {}) as Record<string, unknown>).account;
    const acc = id ? String(id) : null;
    if (acc && !(await db.query('SELECT 1 FROM mono_accounts WHERE id = $1 AND profile_id = $2', [acc, s.id])).rowCount) return reply.code(404).send({ error: 'Счёт не найден' });
    await db.query('UPDATE mono_settings SET watch_account = $2 WHERE id = $1', [s.id, acc]);
    return { ok: true };
  });
  // Окно наблюдения: баланс выбранного счёта и последние пополнения на него
  // ?account=: окно наблюдения открыто за этим счётом, запоминаем его, чтобы без вебхука проверять счёт каждую минуту
  app.get<{ Params: { pid: string }; Querystring: { account?: string } }>('/mono/:pid/watch', { preHandler: admin }, async (req, reply) => {
    const s = await prof(req, reply);
    if (!s) return;
    const want = req.query.account ? String(req.query.account) : s.watch_account;
    if (!want) return { account: null };
    const a = (await db.query('SELECT * FROM mono_accounts WHERE id = $1 AND profile_id = $2', [want, s.id])).rows[0];
    if (a && a.id !== s.watch_account) await db.query('UPDATE mono_settings SET watch_account = $2 WHERE id = $1', [s.id, a.id]);
    if (!a) return { account: null };
    const tx = (
      await db.query(`SELECT id, time, description, comment, counter_name, amount, hold FROM mono_tx WHERE account_id = $1 AND amount > 0 ORDER BY time DESC LIMIT 12`, [a.id])
    ).rows.map((t) => ({ ...t, amount: Number(t.amount) }));
    const today = (
      await db.query(
        `SELECT coalesce(sum(amount), 0)::bigint AS s, count(*)::int AS n FROM mono_tx
          WHERE account_id = $1 AND amount > 0 AND (time AT TIME ZONE 'Europe/Kyiv')::date = (now() AT TIME ZONE 'Europe/Kyiv')::date`,
        [a.id],
      )
    ).rows[0];
    return {
      account: {
        id: a.id,
        kind: a.kind,
        title: a.title,
        type: a.type,
        currency: a.currency_code,
        balance: Number(a.balance) - Number(a.credit_limit || 0),
        maskedPan: a.masked_pan,
        goal: a.goal === null ? null : Number(a.goal),
      },
      today: { amount: Number(today.s), n: today.n },
      tx,
      live: !!(s.use_webhook && s.webhook_ok),
      now: new Date().toISOString(),
    };
  });

  // Отключить вкладку: токен и все загруженные данные удаляются, сама вкладка остаётся
  app.delete<{ Params: { pid: string } }>('/mono/:pid', { preHandler: admin }, async (req, reply) => {
    const s = await prof(req, reply);
    if (!s) return;
    await db.query(
      `UPDATE mono_settings SET token = NULL, client_id = NULL, client_name = NULL, webhook_ok = FALSE, webhook_url = NULL, last_info_at = NULL,
         last_error = NULL, error_at = NULL, watch_account = NULL WHERE id = $1`,
      [s.id],
    );
    await db.query('DELETE FROM mono_accounts WHERE profile_id = $1', [s.id]);
    await db.query('DELETE FROM mono_tx WHERE profile_id = $1', [s.id]);
    return { ok: true };
  });

  // Пополнения вкладки за период (по Киеву): список и сумма по валютам
  app.get<{ Params: { pid: string }; Querystring: { from?: string; to?: string; account?: string } }>('/mono/:pid/incoming', { preHandler: admin }, async (req) => {
    const D = /^\d{4}-\d{2}-\d{2}$/;
    const from = D.test(String(req.query.from)) ? String(req.query.from) : null;
    const to = D.test(String(req.query.to)) ? String(req.query.to) : null;
    const acc = req.query.account ? String(req.query.account) : null;
    const where = `t.profile_id = $4 AND t.amount > 0 AND ($1::date IS NULL OR (t.time AT TIME ZONE 'Europe/Kyiv')::date >= $1::date)
      AND ($2::date IS NULL OR (t.time AT TIME ZONE 'Europe/Kyiv')::date <= $2::date) AND ($3::text IS NULL OR t.account_id = $3)`;
    const args = [from, to, acc, Number(req.params.pid)];
    const rows = (
      await db.query(
        `SELECT t.id, t.account_id, t.time, t.description, t.comment, t.counter_name, t.amount, t.currency_code, t.hold,
                a.kind, a.title, a.masked_pan, a.currency_code AS acc_currency
           FROM mono_tx t LEFT JOIN mono_accounts a ON a.id = t.account_id WHERE ${where} ORDER BY t.time DESC LIMIT 500`,
        args,
      )
    ).rows;
    const sums = (
      await db.query(
        `SELECT coalesce(a.currency_code, t.currency_code) AS currency, sum(t.amount)::bigint AS amount, count(*)::int AS n
           FROM mono_tx t LEFT JOIN mono_accounts a ON a.id = t.account_id WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`,
        args,
      )
    ).rows;
    return {
      rows: rows.map((r) => ({ ...r, amount: Number(r.amount), currency: r.acc_currency ?? r.currency_code })),
      sums: sums.map((x) => ({ currency: x.currency, amount: Number(x.amount), n: x.n })),
    };
  });
}

/** Вебхук monobank: GET для проверки адреса (нужен ответ 200), POST с новой операцией. Подключение находим по секрету в адресе */
export async function monoHookRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { secret: string } }>('/api/mono/hook/:secret', async (_req, reply) => reply.code(200).send('ok'));
  app.post<{ Params: { secret: string } }>('/api/mono/hook/:secret', async (req, reply) => {
    const p = (await db.query('SELECT id FROM mono_settings WHERE hook_secret = $1 AND token IS NOT NULL', [req.params.secret])).rows[0];
    if (!p) return reply.code(200).send('ok');
    const b = (req.body ?? {}) as any;
    if (b.type === 'StatementItem' && b.data?.account && b.data?.statementItem) {
      const acc = String(b.data.account);
      const it = b.data.statementItem;
      await saveItem(p.id, acc, it).catch(() => {});
      if (it.balance !== undefined)
        await db.query('UPDATE mono_accounts SET balance = $3, updated_at = now() WHERE id = $1 AND profile_id = $2', [acc, p.id, Number(it.balance)]).catch(() => {});
    }
    return reply.code(200).send('ok');
  });
}

export function startMonoWorker(log: { error: (o: unknown, m: string) => void }): void {
  setInterval(() => void monoTick().catch((e) => log.error(e, 'monobank: ошибка фоновой загрузки')), Math.min(15_000, GAP));
}
