import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { db, attachLead } from './db.js';
import { bot } from './bot.js';
import { config } from './config.js';
import { parseReviewPhoto, cleanReviewText, cleanRating } from './reviews.js';

export interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
  language_code?: string;
}

/** Проверка подписи initData по правилам Telegram Mini Apps. */
export function verifyInitData(initData: string, botToken: string, maxAgeSec = 86400): TgUser | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = createHmac('sha256', secret).update(check).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== calc.length || !timingSafeEqual(given, calc)) return null;
  const age = Date.now() / 1000 - Number(params.get('auth_date') ?? 0);
  if (!(age >= 0 || age > -60) || age > maxAgeSec) return null;
  try {
    const u = JSON.parse(params.get('user') ?? '');
    return Number.isSafeInteger(u?.id) ? u : null;
  } catch {
    return null;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    tg?: TgUser;
  }
}

/** Добавляет click_id (Telegram ID клиента) к партнёрской ссылке. */
export function withClickId(url: string, tgId: number | string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    u.searchParams.set('click_id', String(tgId));
    return u.toString();
  } catch {
    return null;
  }
}

export const LESSONS = [
  {
    id: 1,
    title: 'Вход на 0:45',
    sub: 'настроим терминал и зайдём по сигналу',
    steps: [
      'Откройте терминал и выберите актив из сигнала.',
      'Выставьте время экспирации так же, как в сигнале.',
      'Сумма сделки: не больше 1–2% от вашего депозита. Это правило важнее любого сигнала.',
      'Дождитесь, когда таймер свечи покажет 0:45, и нажмите «Вверх» или «Вниз», как в сигнале.',
      'Когда сделка закроется, вернитесь в приложение и отметьте результат в разделе «Сделки».',
    ],
  },
  {
    id: 2,
    title: 'Перекрытие',
    sub: 'что делать, если сделка ушла в минус',
    steps: [
      'Минус в серии сделок бывает у всех. Это обычная часть торговли.',
      'Чтобы перекрыть минус, повторно зайдите на 0:15 и увеличьте сумму в 2 раза: выплата 92% от удвоенной ставки покроет прошлый минус.',
      'Перекрывайте минус только один раз подряд: если и вторая сделка в минус, потери вырастут вдвое. Не «отыгрывайтесь» дальше.',
      'После двух минусов подряд сделайте перерыв и заранее решите дневной лимит потерь.',
    ],
  },
  {
    id: 3,
    title: 'Возврат',
    sub: 'цена закрылась на уровне входа',
    steps: [
      'Если цена закрытия равна цене входа, сделка закрывается без результата, а сумма ставки возвращается на баланс в полном объёме.',
      'Чтобы получить возврат, свеча должна вернуться к точке входа и ненадолго остановиться на ней.',
      'После возврата можно зайти ещё раз на ту же сумму (на 0:15), не увеличивая её. В приложении такую сделку без результата пропустите или отметьте «Не входил».',
    ],
  },
];


/** Название канала и число подписчиков берём из Telegram по ссылке. Кэш на 30 минут, при ошибке пробуем снова через 5 */
const tgInfoCache = new Map<string, { until: number; title: string | null; members: number | null }>();
async function tgInfo(handle: string): Promise<{ title: string | null; members: number | null }> {
  const hit = tgInfoCache.get(handle);
  if (hit && hit.until > Date.now()) return hit;
  let title: string | null = null;
  let members: number | null = null;
  if (!config.disableBot) {
    try {
      const chat = await bot.api.getChat('@' + handle);
      title = 'title' in chat ? (chat.title ?? null) : null;
      members = await bot.api.getChatMemberCount('@' + handle);
    } catch {
      /* бот не видит чат: оставим то, что успели получить */
    }
  }
  const out = { until: Date.now() + (title && members !== null ? 1800_000 : 300_000), title, members };
  tgInfoCache.set(handle, out);
  return out;
}

const photoCache = new Map<string, { until: number; data: Buffer | null; type: string }>();
/** Фото профиля, если бот его не видит (личные аккаунты): берём картинку со страницы t.me/имя */
async function scrapeTgPhoto(handle: string): Promise<{ data: Buffer; type: string } | null> {
  const page = await fetch(`https://t.me/${handle}`, { signal: AbortSignal.timeout(5000) });
  if (!page.ok) return null;
  const m = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/.exec(await page.text());
  if (!m) return null;
  const u = new URL(m[1].replaceAll('&amp;', '&'));
  if (u.protocol !== 'https:' || !/(^|\.)(telegram\.org|telesco\.pe|t\.me)$/.test(u.hostname) || u.pathname.includes('/img/t_logo')) return null;
  const img = await fetch(u, { signal: AbortSignal.timeout(5000) });
  if (!img.ok) return null;
  const type = img.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) return null;
  return { data: Buffer.from(await img.arrayBuffer()), type };
}
/** @имя из ссылки https://t.me/имя. Приватные приглашения (+...) и ссылки на посты не подходят */
function tgHandle(url: string): string | null {
  const m = /^https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})\/?(?:\?.*)?$/.exec(url);
  return m ? m[1] : null;
}

export async function appRoutes(app: FastifyInstance): Promise<void> {
  const auth = async (req: FastifyRequest, reply: FastifyReply) => {
    const h = String(req.headers.authorization ?? '');
    const initData = h.startsWith('tma ') ? h.slice(4) : '';
    const user = initData ? verifyInitData(initData, config.botToken) : null;
    if (!user) return reply.code(401).send({ error: 'Откройте приложение из Telegram' });
    req.tg = user;
    // Если человек открыл приложение, не нажимая /start, всё равно заводим лида
    await attachLead(user.id, user.username, user.first_name, null);
    // Часовой пояс устройства клиента: по нему показываем время сигналов в пушах
    const tzHeader = String(req.headers['x-tz'] ?? '');
    if (tzHeader && tzHeader.length < 60) {
      try {
        new Intl.DateTimeFormat('ru-RU', { timeZone: tzHeader });
        await db.query('UPDATE leads SET tz = $2 WHERE tg_id = $1 AND tz IS DISTINCT FROM $2', [user.id, tzHeader]);
      } catch {
        /* неизвестный пояс, игнорируем */
      }
    }
    await db.query(`UPDATE leads SET last_seen_at = now() WHERE tg_id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '10 minutes')`, [user.id]);
  };

  app.get('/me', { preHandler: auth }, async (req) => {
    const u = req.tg!;
    const r = await db.query(
      `SELECT d.status, d.access, d.is_tester, d.lead_role, d.region, d.created_at, d.trader_id, o.name AS manager,
              o.po_promo, o.po_link, o.po_link_ru, o.tg_username AS manager_tg
         FROM leads d LEFT JOIN staff o ON o.id = d.owner_id WHERE d.tg_id = $1`,
      [u.id],
    );
    const l = r.rows[0];
    const dep = await db.query(`SELECT coalesce(sum(amount), 0) AS s, count(*)::int AS c FROM events WHERE tg_id = $1 AND type IN ('ftd','dep')`, [u.id]);
    const st = await db.query(
      `SELECT count(*) FILTER (WHERE result IS NOT NULL AND result <> 'skip')::int AS deals,
              count(*) FILTER (WHERE result = 'win')::int AS wins,
              count(*) FILTER (WHERE result = 'loss')::int AS losses
         FROM deals WHERE tg_id = $1`,
      [u.id],
    );
    const s = st.rows[0];
    const guess = ['ru', 'be', 'kk', 'ky', 'uz', 'tg', 'hy', 'az', 'uk'].includes(u.language_code ?? '') ? 'ru' : 'ww';
    return {
      now: new Date().toISOString(),
      tgId: u.id,
      name: u.first_name || u.username || 'Клиент',
      username: u.username ?? null,
      since: l.created_at,
      status: l.status,
      access: Boolean(l.access || l.is_tester), // тестовый аккаунт: доступ как у обычного клиента
      isTester: Boolean(l.is_tester),
      leadRole: l.lead_role || 'lead',
      pocketId: l.trader_id,
      manager: l.manager,
      managerTg: l.manager_tg ?? null,
      deposited: Number(dep.rows[0].s),
      depositCount: dep.rows[0].c,
      minDeposit: config.minDeposit,
      promo: l.po_promo,
      region: l.region,
      regionGuess: guess,
      registerUrl: {
        ru: withClickId(l.po_link_ru || config.defaultPoLinkRu || l.po_link || config.defaultPoLink, u.id),
        ww: withClickId(l.po_link || config.defaultPoLink || l.po_link_ru || config.defaultPoLinkRu, u.id),
      },
      botUsername: config.botUsername,
      stats: { deals: s.deals, wins: s.wins, losses: s.losses, rate: s.deals ? Math.round((s.wins / s.deals) * 100) : null },
    };
  });

  app.post('/region', { preHandler: auth }, async (req, reply) => {
    const region = String((req.body as any)?.region ?? '');
    if (!['ru', 'ww'].includes(region)) return reply.code(400).send({ error: 'Неверный регион' });
    await db.query('UPDATE leads SET region = $2 WHERE tg_id = $1', [req.tg!.id, region]);
    return { ok: true };
  });

  app.get<{ Querystring: { period?: string } }>('/deals', { preHandler: auth }, async (req) => {
    const days = req.query.period === '30' ? 30 : req.query.period === 'all' ? 36500 : 7;
    const rows = (
      await db.query(
        `SELECT id, pair, direction, expiry_min, coalesce((SELECT s.expiry_sec FROM signals s WHERE s.id = deals.signal_id), expiry_min * 60) AS expiry_sec, result, created_at FROM deals
          WHERE tg_id = $1 AND created_at > now() - ($2 || ' days')::interval ORDER BY id DESC LIMIT 200`,
        [req.tg!.id, String(days)],
      )
    ).rows;
    const by = await db.query(
      `SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
              count(*) FILTER (WHERE result = 'win')::int AS wins,
              count(*) FILTER (WHERE result = 'loss')::int AS losses
         FROM deals WHERE tg_id = $1 AND created_at > now() - interval '7 days' GROUP BY 1 ORDER BY 1`,
      [req.tg!.id],
    );
    // Плюсы по шагам: 0 = вход, 1.. = перекрытия; период тот же, что у списка
    const st = await db.query(
      `SELECT step, count(*)::int AS c FROM deals
        WHERE tg_id = $1 AND result = 'win' AND step IS NOT NULL AND created_at > now() - ($2 || ' days')::interval GROUP BY step`,
      [req.tg!.id, String(days)],
    );
    const maxEv = Number((await db.query('SELECT max_events FROM signal_settings WHERE id = 1')).rows[0]?.max_events) || 4;
    const winSteps = Array.from({ length: maxEv }, (_, i) => Number(st.rows.find((r) => r.step === i)?.c || 0));
    return {
      deals: rows,
      winSteps,
      wins: rows.filter((x) => x.result === 'win').length,
      losses: rows.filter((x) => x.result === 'loss').length,
      total: rows.filter((x) => x.result && x.result !== 'skip').length,
      byDay: by.rows,
    };
  });

  // Перенос из старого бота: клиент вводит свой Pocket ID из загруженного списка. Доступ откроется не сразу, а после постбека с пополнением (от $10)
  const claimTries = new Map<number, { n: number; at: number }>();
  app.post('/legacy/claim', { preHandler: auth }, async (req, reply) => {
    const tgId = req.tg!.id;
    const t = claimTries.get(tgId);
    const fresh = t && Date.now() - t.at < 3_600_000 ? t : { n: 0, at: Date.now() };
    if (fresh.n >= 8) return reply.code(429).send({ error: 'Слишком много попыток. Попробуйте через час или напишите в поддержку' });
    const id = String((req.body as any)?.trader_id ?? '').trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return reply.code(400).send({ error: 'Введите Pocket ID: только буквы и цифры' });
    const fail = (code: number, error: string) => {
      claimTries.set(tgId, { n: fresh.n + 1, at: fresh.at });
      return reply.code(code).send({ error });
    };
    const row = (await db.query('SELECT claimed_by FROM legacy_ids WHERE trader_id = $1', [id])).rows[0];
    if (!row) return fail(404, 'Этого Pocket ID нет в списке старого бота. Проверьте номер или напишите в поддержку');
    if (row.claimed_by && Number(row.claimed_by) !== tgId) return fail(409, 'Этот Pocket ID уже подключён к другому аккаунту');
    const other = await db.query('SELECT 1 FROM leads WHERE trader_id = $1 AND tg_id <> $2 AND access LIMIT 1', [id, tgId]);
    if (other.rowCount) return fail(409, 'Этот Pocket ID уже подключён к другому аккаунту');
    await db.query('UPDATE legacy_ids SET claimed_by = $2, claimed_at = coalesce(claimed_at, now()) WHERE trader_id = $1', [id, tgId]);
    await db.query(`UPDATE leads SET trader_id = $2, status = CASE WHEN status = 'new' THEN 'registered' ELSE status END WHERE tg_id = $1`, [tgId, id]);
    claimTries.delete(tgId);
    return { ok: true };
  });

  // Очистка истории сделок клиента (его статистика обнуляется)
  app.delete('/deals', { preHandler: auth }, async (req) => {
    const r = await db.query('DELETE FROM deals WHERE tg_id = $1', [req.tg!.id]);
    return { ok: true, removed: r.rowCount };
  });

  app.post<{ Params: { id: string } }>('/deals/:id/result', { preHandler: auth }, async (req, reply) => {
    const result = String((req.body as any)?.result ?? '');
    if (!['win', 'loss', 'skip'].includes(result)) return reply.code(400).send({ error: 'Неверный результат' });
    const r = await db.query('UPDATE deals SET result = $3 WHERE id = $1 AND tg_id = $2 AND result IS NULL RETURNING id', [
      Number(req.params.id),
      req.tg!.id,
      result,
    ]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Сделка не найдена или уже отмечена' });
    return { ok: true };
  });

  app.get('/trainer', { preHandler: auth }, async (req) => {
    const done = new Set((await db.query('SELECT lesson FROM lesson_progress WHERE tg_id = $1', [req.tg!.id])).rows.map((x) => x.lesson));
    return LESSONS.map((l) => ({ ...l, done: done.has(l.id) }));
  });

  app.post<{ Params: { id: string } }>('/trainer/:id/done', { preHandler: auth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!LESSONS.some((l) => l.id === id)) return reply.code(404).send({ error: 'Урок не найден' });
    await db.query('INSERT INTO lesson_progress (tg_id, lesson) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.tg!.id, id]);
    return { ok: true };
  });

  // Активные сигналы клиента. Общий (от аналитика) работает так же, как сигнал по запросу: свёрнутая карточка, полный экран с
  // расписанием входа и перекрытий, оценка или «Пропустить». Общий сигнал живёт, пока не пройдут все события расписания плюс 5 минут.
  // Сигнал по запросу остаётся у клиента, пока он его не оценит. Обычные видят все клиенты, тестовые только тестовые аккаунты
  const VIS = `(s.requested_by = d.tg_id
       OR (s.requested_by IS NULL AND s.created_at > now() - interval '2 hours'
           AND s.entry_at + make_interval(secs => (SELECT max_events * overlap_gap_sec + 300 FROM signal_settings WHERE id = 1)) > now()
           AND NOT s.is_test))`;
  const ACTIVE = `${VIS} AND NOT EXISTS (SELECT 1 FROM signal_steps t WHERE t.signal_id = s.id AND t.tg_id = d.tg_id)`;
  app.get('/signals/active', { preHandler: auth }, async (req) => {
    const r = await db.query(
      `SELECT s.id, s.pair, s.direction, s.expiry_min, s.expiry_sec, s.entry_at, s.note, s.source, s.is_test, s.requested_by,
              EXISTS (SELECT 1 FROM deals x WHERE x.signal_id = s.id AND x.tg_id = d.tg_id) AS taken
         FROM signals s JOIN leads d ON d.tg_id = $1 WHERE ${ACTIVE} ORDER BY s.entry_at, s.id LIMIT 6`,
      [req.tg!.id],
    );
    const signals = r.rows;
    const set = (await db.query('SELECT * FROM signal_settings WHERE id = 1')).rows[0];
    return { signal: signals[0] ?? null, signals, steps: [], cfg: cfgOf(set), now: new Date().toISOString() };
  });

  // Прошедшие сигналы. Показываем ВСЕ завершённые, без отбора. Итог считается по отметкам клиентов
  app.get('/signals/past', { preHandler: auth }, async (req) => {
    // В истории: сигналы аналитика с итогами и все реальные сигналы по запросу. Клиентские сигналы по одной паре в одну минуту
    // сводим в одну строку; если исходы разные (и плюс, и минус), публикуем только плюс (positive), минус не показываем
    const r = await db.query(
      `SELECT * FROM (
         SELECT s.id::text AS id, s.pair, s.direction, s.entry_at, s.is_test,
                (SELECT count(*)::int FROM deals x WHERE x.signal_id = s.id AND x.result = 'win') + coalesce((s.demo_result = 'win')::int, 0) AS wins,
                (SELECT count(*)::int FROM deals x WHERE x.signal_id = s.id AND x.result = 'loss') + coalesce((s.demo_result = 'loss')::int, 0) AS losses,
                FALSE AS positive
           FROM signals s
          WHERE NOT s.is_test AND s.requested_by IS NULL
            AND s.entry_at + make_interval(secs => coalesce(s.expiry_sec, s.expiry_min * 60)) < now()
         UNION ALL
         SELECT 'c' || md5(s.pair || s.direction || date_trunc('minute', s.entry_at)::text) AS id, s.pair, s.direction,
                date_trunc('minute', s.entry_at) AS entry_at, FALSE AS is_test,
                count(*) FILTER (WHERE d.result = 'win')::int AS wins,
                count(*) FILTER (WHERE d.result = 'loss')::int AS losses,
                (count(*) FILTER (WHERE d.result = 'win') > 0 AND count(*) FILTER (WHERE d.result = 'loss') > 0) AS positive
           FROM signals s JOIN deals d ON d.signal_id = s.id
          WHERE s.requested_by IS NOT NULL
            AND s.entry_at + make_interval(secs => coalesce(s.expiry_sec, s.expiry_min * 60)) < now()
          GROUP BY s.pair, s.direction, date_trunc('minute', s.entry_at)
       ) q
        WHERE q.wins + q.losses > 0
        ORDER BY q.entry_at DESC LIMIT 5`,
      [],
    );
    if (r.rowCount) return r.rows;
    return [];
  });

  // Сигнал по запросу клиента. Направление берётся из того, что поставил человек в Office, и действует ограниченное время
  /** Что нужно клиенту, чтобы нарисовать карточку и расписание входа с перекрытиями */
  const cfgOf = (set: Record<string, any>) => ({
    gapSec: set.overlap_gap_sec, maxEvents: set.max_events, overlapMult: set.overlap_mult,
    entryLabel: set.entry_label, stakeLabel: set.stake_label, warning: set.warning_text, pocketUrl: set.pocket_url,
  });
  const requestRules = async (tgId: number) => {
    const set = (await db.query('SELECT * FROM signal_settings WHERE id = 1')).rows[0];
    const lead = (await db.query('SELECT access, is_tester FROM leads WHERE tg_id = $1', [tgId])).rows[0];
    const allowed = Boolean(lead && (lead.access || lead.is_tester) && set.enabled);
    // Пропущенный сигнал паузу не включает: можно сразу запросить новый
    const last = (await db.query(`SELECT extract(epoch FROM now() - created_at)::int AS ago FROM signals s WHERE requested_by = $1 AND NOT EXISTS (SELECT 1 FROM signal_steps t WHERE t.signal_id = s.id AND t.tg_id = $1 AND t.result = 'skip') ORDER BY id DESC LIMIT 1`, [tgId])).rows[0];
    const cooldownLeft = last ? Math.max(0, set.cooldown_sec - last.ago) : 0;
    const open = (await db.query('SELECT 1 FROM signals s WHERE s.requested_by = $1 AND NOT EXISTS (SELECT 1 FROM signal_steps t WHERE t.signal_id = s.id AND t.tg_id = $1) LIMIT 1', [tgId])).rowCount;
    return { set, lead, allowed, cooldownLeft, open: Boolean(open) };
  };

  app.get('/signals/request', { preHandler: auth }, async (req) => {
    const { set, lead, allowed, cooldownLeft } = await requestRules(req.tg!.id);
    if (!allowed) return { enabled: false, pairs: [], cooldownLeft: 0, enterInSec: set.enter_in_sec, expiryMin: set.expiry_min, cfg: cfgOf(set) };
    const pairs = (
      await db.query(
        `SELECT pair, (direction IS NOT NULL AND direction_at > now() - ($1 || ' minutes')::interval) AS available
           FROM signal_pairs WHERE enabled
          ORDER BY (SELECT count(*) FROM signals q WHERE q.pair = signal_pairs.pair AND q.requested_by IS NOT NULL AND q.created_at > now() - interval '30 days') DESC, sort, pair`,
        [String(set.direction_ttl_min)],
      )
    ).rows;
    const expiries = (await db.query('SELECT sec FROM signal_expiries ORDER BY sec')).rows.map((x) => x.sec);
    return { enabled: true, pairs, expiries, cooldownLeft, enterInSec: set.enter_in_sec, cfg: cfgOf(set) };
  });

  app.post<{ Body: { pair?: string; expiry_sec?: number } }>('/signals/request', { preHandler: auth }, async (req, reply) => {
    const { set, lead, allowed, cooldownLeft, open } = await requestRules(req.tg!.id);
    if (!allowed) return reply.code(403).send({ error: 'Сигналы по запросу пока недоступны' });
    if (open) return reply.code(409).send({ error: 'Сначала оцените предыдущий сигнал' });
    if (cooldownLeft > 0) return reply.code(429).send({ error: `Следующий сигнал можно получить через ${cooldownLeft} сек.`, cooldownLeft });
    const p = (
      await db.query(
        `SELECT pair, direction, direction_by FROM signal_pairs
          WHERE pair = $1 AND enabled AND direction IS NOT NULL AND direction_at > now() - ($2 || ' minutes')::interval`,
        [String(req.body?.pair ?? ''), String(set.direction_ttl_min)],
      )
    ).rows[0];
    if (!p) return reply.code(409).send({ error: 'По этой паре сейчас нет подходящего входа. Попробуйте другую пару или чуть позже.' });
    const expirySec = Math.trunc(Number(req.body?.expiry_sec));
    const okExp = await db.query('SELECT 1 FROM signal_expiries WHERE sec = $1', [expirySec]);
    if (!okExp.rowCount) return reply.code(400).send({ error: 'Выберите время экспирации из списка' });
    // Вход: ближайший момент не раньше «через enter_in_sec», когда секундная стрелка стоит на entry_second (например 23:42:15)
    const es = set.entry_second * 1000;
    const entryMs = Math.ceil((Date.now() + set.enter_in_sec * 1000 - es) / 60_000) * 60_000 + es;
    const ins = await db.query(
      `INSERT INTO signals (pair, direction, expiry_min, expiry_sec, entry_at, note, source, is_test, created_by, requested_by)
       VALUES ($1,$2,$3,$4,$5,NULL,'analyst',FALSE,$6,$7) RETURNING id, pair, direction, expiry_min, expiry_sec, entry_at, is_test, source, requested_by`,
      [p.pair, p.direction, Math.max(1, Math.ceil(expirySec / 60)), expirySec, new Date(entryMs), p.direction_by, req.tg!.id],
    );
    return { signal: { ...ins.rows[0], taken: false }, steps: [], cfg: cfgOf(set), now: new Date().toISOString() };
  });

  // Пропустить сигнал: доступно всем. Сигнал закрывается без оценки и без статистики, можно запросить новый
  app.post<{ Params: { id: string } }>('/signals/:id/skip', { preHandler: auth }, async (req, reply) => {
    const id = Number(req.params.id);
    const sg = (await db.query(`SELECT s.id FROM signals s JOIN leads d ON d.tg_id = $2 WHERE s.id = $1 AND ${VIS}`, [id, req.tg!.id])).rows[0];
    if (!sg) return reply.code(404).send({ error: 'Сигнал не найден' });
    if ((await db.query('SELECT 1 FROM signal_steps WHERE signal_id = $1 AND tg_id = $2 LIMIT 1', [id, req.tg!.id])).rowCount) return reply.code(409).send({ error: 'Сигнал уже закрыт' });
    await db.query(`INSERT INTO signal_steps (signal_id, tg_id, step, result) VALUES ($1,$2,0,'skip') ON CONFLICT DO NOTHING`, [id, req.tg!.id]);
    return { ok: true };
  });

  // Клиент оценивает сигнал: минус, либо плюс с номером шага (1 = со входа, 2..4 = с перекрытия). Идёт в статистику
  app.post<{ Params: { id: string } }>('/signals/:id/rate', { preHandler: auth }, async (req, reply) => {
    const id = Number(req.params.id);
    const result = String((req.body as any)?.result ?? '');
    const step = Math.trunc(Number((req.body as any)?.step)); // 1..max
    const set = (await db.query('SELECT max_events FROM signal_settings WHERE id = 1')).rows[0];
    if (!['win', 'loss'].includes(result)) return reply.code(400).send({ error: 'Неверная оценка' });
    if (result === 'win' && !(step >= 1 && step <= set.max_events)) return reply.code(400).send({ error: 'Укажите, с какого шага зашёл плюс' });
    const sg = (await db.query(`SELECT s.id, s.pair, s.direction, s.expiry_min, s.entry_at <= now() AS started FROM signals s JOIN leads d ON d.tg_id = $2 WHERE s.id = $1 AND ${VIS}`, [id, req.tg!.id])).rows[0];
    if (!sg) return reply.code(404).send({ error: 'Сигнал не найден' });
    if (!sg.started) return reply.code(409).send({ error: 'Оценить можно после времени входа' });
    if ((await db.query('SELECT 1 FROM signal_steps WHERE signal_id = $1 AND tg_id = $2 LIMIT 1', [id, req.tg!.id])).rowCount) return reply.code(409).send({ error: 'Сигнал уже оценён' });
    // Минусы на всех шагах до плюса и сам плюс. Минус: все шаги в минус
    const last = result === 'win' ? step : set.max_events;
    for (let i = 1; i <= last; i++) {
      const r = result === 'win' && i === last ? 'win' : 'loss';
      await db.query('INSERT INTO signal_steps (signal_id, tg_id, step, result) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id, req.tg!.id, i - 1, r]);
    }
    await db.query(
      `INSERT INTO deals (tg_id, pair, direction, expiry_min, signal_id, result, step) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tg_id, signal_id) WHERE signal_id IS NOT NULL DO UPDATE SET result = EXCLUDED.result, step = EXCLUDED.step WHERE deals.result IS NULL`,
      [req.tg!.id, sg.pair, sg.direction, sg.expiry_min, id, result, result === 'win' ? step - 1 : null],
    );
    return { ok: true };
  });

  // Клиент отмечает, что вошёл в сделку по сигналу. Дальше он отмечает итог
  app.post<{ Params: { id: string } }>('/signals/:id/take', { preHandler: auth }, async (req, reply) => {
    const r = await db.query(
      `SELECT s.id, s.pair, s.direction, s.expiry_min FROM signals s JOIN leads d ON d.tg_id = $1
        WHERE s.id = $2 AND ${ACTIVE}`,
      [req.tg!.id, Number(req.params.id)],
    );
    const sig = r.rows[0];
    if (!sig) return reply.code(404).send({ error: 'Сигнал уже неактуален' });
    await db.query(
      `INSERT INTO deals (tg_id, pair, direction, expiry_min, signal_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [req.tg!.id, sig.pair, sig.direction, sig.expiry_min, sig.id],
    );
    return { ok: true };
  });

  app.get('/media', { preHandler: auth }, async () => {
    // live: ссылка на эфир, пока у привязанного стримера идёт смена
    const r = await db.query(
      `SELECT m.id, m.kind, m.title, m.subtitle, m.url, m.country, m.contact_url,
              (SELECT s.stream_url FROM shift_reports s WHERE s.staff_id = m.staff_id AND s.status = 'live' ORDER BY s.id DESC LIMIT 1) AS live_url
         FROM media_items m WHERE m.active ORDER BY m.sort, m.id`,
    );
    const rows = await Promise.all(
      r.rows.map(async (x) => {
        const handle = tgHandle(x.url);
        const info = handle ? await Promise.race([tgInfo(handle), new Promise<null>((ok) => setTimeout(() => ok(null), 3000))]) : null;
        const contact = x.contact_url ? tgHandle(x.contact_url) : null;
        // Аватарка трейдера: его личный аккаунт, если ссылка указана, иначе канал
        return { ...x, contact_url: undefined, live_url: undefined, live: /^https?:\/\//i.test(x.live_url ?? '') ? x.live_url : null, contact: contact ? { handle: contact, url: x.contact_url } : null, photo: handle || contact ? `/api/app/media/${x.id}/photo?v=${contact ?? handle}` : null, channelTitle: info?.title ?? null, members: info?.members ?? null };
      }),
    );
    return { traders: rows.filter((x) => x.kind === 'trader'), channels: rows.filter((x) => x.kind === 'channel') };
  });

  // Отзывы. Видны опубликованные и свои на проверке. Фото отдаётся по случайному ключу (для <img> без заголовков)
  app.get('/reviews', { preHandler: auth }, async (req) => {
    const r = await db.query(
      `SELECT id, author, rating, body, status, created_at, photo_key, (tg_id = $1) AS mine
         FROM reviews WHERE status = 'published' OR (tg_id = $1 AND status = 'pending')
        ORDER BY created_at DESC, id DESC LIMIT 100`,
      [req.tg!.id],
    );
    const rows = r.rows.map((x) => ({ ...x, photo_key: undefined, photo: x.photo_key ? `/api/app/reviews/photo/${x.photo_key}` : null }));
    const stats = (await db.query(`SELECT count(*)::int AS n, coalesce(round(avg(rating)::numeric, 1), 0)::float AS avg FROM reviews WHERE status = 'published'`)).rows[0];
    return { items: rows, count: stats.n, avg: stats.avg };
  });
  app.get<{ Params: { key: string } }>('/reviews/photo/:key', async (req, reply) => {
    if (!/^[0-9a-f]{24}$/.test(req.params.key)) return reply.code(404).send();
    const r = (await db.query('SELECT photo, photo_type FROM reviews WHERE photo_key = $1', [req.params.key])).rows[0];
    if (!r?.photo) return reply.code(404).send();
    return reply.type(r.photo_type).header('Cache-Control', 'public, max-age=86400').send(r.photo);
  });
  app.post('/reviews', { preHandler: auth, bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const rating = cleanRating(b.rating);
    const body = cleanReviewText(b.body);
    if (!rating) return reply.code(400).send({ error: 'Поставьте оценку от 1 до 5 звёзд' });
    if (body.length < 5) return reply.code(400).send({ error: 'Напишите хотя бы пару слов' });
    const ph = parseReviewPhoto(b.photo);
    if (typeof ph === 'string') return reply.code(400).send({ error: ph });
    const recent = (await db.query(`SELECT count(*)::int AS n FROM reviews WHERE tg_id = $1 AND created_at > now() - interval '1 day'`, [req.tg!.id])).rows[0].n;
    if (recent >= 3) return reply.code(429).send({ error: 'Сегодня вы уже оставили несколько отзывов. Попробуйте завтра' });
    const lead = (await db.query('SELECT first_name, username FROM leads WHERE tg_id = $1', [req.tg!.id])).rows[0];
    const author = (lead?.first_name || lead?.username || 'Клиент').slice(0, 60);
    await db.query(
      `INSERT INTO reviews (tg_id, author, rating, body, photo, photo_type, photo_key, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')`,
      [req.tg!.id, author, rating, body, ph?.data ?? null, ph?.type ?? null, ph?.key ?? null],
    );
    return { ok: true };
  });

  // Аватарки каналов и трейдеров берём из Telegram. Картинка публичная, отдаём без авторизации, чтобы работал <img>
  app.get<{ Params: { id: string } }>('/media/:id/photo', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(404).send();
    const m = await db.query('SELECT url, contact_url FROM media_items WHERE id = $1 AND active', [id]);
    const handle = m.rowCount ? (m.rows[0].contact_url ? tgHandle(m.rows[0].contact_url) : null) ?? tgHandle(m.rows[0].url) : null;
    const key = `${id}:${handle}`;
    let hit = photoCache.get(key);
    if (!hit || hit.until < Date.now()) {
      hit = { until: Date.now() + 3600_000, data: null, type: 'image/jpeg' };
      try {
        if (handle && !config.disableBot) {
          const chat = await bot.api.getChat('@' + handle).catch(() => null);
          const fid = chat?.photo?.small_file_id;
          if (!fid) req.log.warn({ handle }, 'avatar: у чата нет фото или бот его не видит');
          if (fid) {
            const f = await bot.api.getFile(fid);
            const resp = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${f.file_path}`);
            if (!resp.ok) req.log.warn({ handle, status: resp.status }, 'avatar: Telegram не отдал файл');
            if (resp.ok) {
              hit.data = Buffer.from(await resp.arrayBuffer());
              if (f.file_path?.endsWith('.png')) hit.type = 'image/png';
            }
          }
          if (!hit.data) {
            const s = await scrapeTgPhoto(handle);
            if (s) {
              hit.data = s.data;
              hit.type = s.type;
            } else req.log.warn({ handle }, 'avatar: на t.me/имя нет фото (возможно скрыто настройками приватности)');
          }
        }
      } catch (e) {
        req.log.warn({ err: String(e) }, 'avatar: ошибка запроса к Telegram');
        hit.until = Date.now() + 300_000;
      }
      photoCache.set(key, hit);
    }
    if (!hit.data) return reply.code(404).send();
    return reply.header('Cache-Control', 'public, max-age=3600').header('X-Content-Type-Options', 'nosniff').type(hit.type).send(hit.data);
  });
}
