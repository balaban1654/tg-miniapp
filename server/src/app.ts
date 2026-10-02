import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db, attachLead } from './db.js';
import { bot } from './bot.js';
import { config } from './config.js';

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

/**
 * Пока настоящих сигналов с итогами нет, показываем пример оформления. Все строки помечены is_test,
 * в приложении это подписано «ТЕСТ» и «тестовые данные».
 * Днём новая строка появляется каждые 5–7 минут, вечером (с 18:00) каждые 2–4 минуты, старая уходит.
 * Пары идут разные, минус редкий. Всё считается от времени, поэтому у всех клиентов одинаково.
 */
function demoPast(preview = false) {
  const pairs = ['EUR/USD', 'GBP/USD', 'AUD/CHF', 'EUR/GBP', 'AUD/USD', 'USD/JPY', 'EUR/JPY', 'GBP/JPY', 'AUD/CAD', 'EUR/CAD', 'CAD/JPY', 'CHF/JPY', 'NZD/USD', 'USD/CAD', 'USD/CHF', 'GBP/CHF', 'EUR/CHF'].map((p) => p + ' OTC');
  const h = (n: number) => {
    let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
    x ^= x >>> 13;
    x = Math.imul(x, 0xc2b2ae35);
    x ^= x >>> 16;
    return x >>> 0;
  };
  const hourFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: config.pushTz });
  const evening = (t: number) => Number(hourFmt.format(new Date(t))) >= 18;
  // Две сетки: на 6 минут (день, интервалы 5–7) и на 3 минуты (вечер, интервалы 2–4). Внутри блока сдвиг 0–1 минута
  const streams = [
    { block: 6 * 60_000, salt: 11, lossMod: 4, when: (t: number) => !evening(t) },
    { block: 3 * 60_000, salt: 29, lossMod: 8, when: (t: number) => evening(t) },
  ];
  const now = Date.now();
  const events: { at: number; loss: boolean }[] = [];
  for (const st of streams) {
    const top = Math.floor(now / st.block) + 1;
    for (let b = top; b > top - 30; b--) {
      const at = b * st.block + (h(b + st.salt * 1000) % 60) * 1000;
      if (!st.when(at) || at > now - 90_000) continue; // сигнал считается завершённым через ~1,5 минуты после входа
      const loss = h(b + st.salt * 7919) % st.lossMod === 0 && h(b - 1 + st.salt * 7919) % st.lossMod !== 0;
      events.push({ at, loss });
    }
  }
  events.sort((x, y) => y.at - x.at);
  const used = new Set<number>(); // голоса в пяти строках не повторяются
  return events.slice(0, 5).map((e) => {
    const slot = Math.floor(e.at / 120_000); // у событий с интервалом от 2 минут слоты разные, пары на 5 соседних строках не повторяются
    // Голоса показываем всем. Утром и днём 20–50, вечером и ночью 20–96 (чаще ближе к верхней границе)
    const hr = Number(hourFmt.format(new Date(e.at)));
    const day = hr >= 6 && hr < 18;
    const [lo, span] = day ? [20, 31] : [20, 77];
    let votes = day ? lo + (h(slot + 5) % span) : lo + Math.max(h(slot + 5) % span, h(slot * 7 + 90001) % span);
    while (used.has(votes)) votes = lo + ((votes - lo + 1) % span);
    used.add(votes);
    return {
      id: -Math.floor(e.at / 1000),
      preview,
      pair: pairs[(slot * 5) % pairs.length],
      direction: h(slot + 1) % 2 ? 'up' : 'down',
      entry_at: new Date(e.at).toISOString(),
      is_test: true,
      wins: e.loss ? 0 : votes,
      losses: e.loss ? votes : 0,
    };
  });
}

const photoCache = new Map<number, { until: number; data: Buffer | null; type: string }>();
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
      `SELECT d.status, d.access, d.region, d.created_at, d.trader_id, o.name AS manager,
              o.po_promo, o.po_link, o.po_link_ru
         FROM leads d LEFT JOIN staff o ON o.id = d.owner_id WHERE d.tg_id = $1`,
      [u.id],
    );
    const l = r.rows[0];
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
      tgId: u.id,
      name: u.first_name || u.username || 'Клиент',
      username: u.username ?? null,
      since: l.created_at,
      status: l.status,
      access: l.access,
      pocketId: l.trader_id,
      manager: l.manager,
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
        `SELECT id, pair, direction, expiry_min, result, created_at FROM deals
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
    return {
      deals: rows,
      wins: rows.filter((x) => x.result === 'win').length,
      losses: rows.filter((x) => x.result === 'loss').length,
      total: rows.filter((x) => x.result && x.result !== 'skip').length,
      byDay: by.rows,
    };
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

  // Активный сигнал: обычные видят клиенты с открытым доступом, тестовые только тестовые аккаунты
  const ACTIVE = `now() <= s.entry_at + interval '3 minutes' AND s.created_at > now() - interval '2 hours'
     AND ((NOT s.is_test AND d.access) OR (s.is_test AND d.is_tester))`;
  app.get('/signals/active', { preHandler: auth }, async (req) => {
    const r = await db.query(
      `SELECT s.id, s.pair, s.direction, s.expiry_min, s.entry_at, s.note, s.source, s.is_test,
              EXISTS (SELECT 1 FROM deals x WHERE x.signal_id = s.id AND x.tg_id = d.tg_id) AS taken
         FROM signals s JOIN leads d ON d.tg_id = $1 WHERE ${ACTIVE} ORDER BY s.id DESC LIMIT 1`,
      [req.tg!.id],
    );
    return { signal: r.rows[0] ?? null, now: new Date().toISOString() };
  });

  // Прошедшие сигналы. Показываем ВСЕ завершённые, без отбора. Итог считается по отметкам клиентов
  app.get('/signals/past', { preHandler: auth }, async (req) => {
    // В истории только сигналы, по которым уже есть итоги от клиентов: без отметок результата у сигнала нет
    const r = await db.query(
      `SELECT * FROM (
         SELECT s.id, s.pair, s.direction, s.entry_at, s.is_test,
                (SELECT count(*)::int FROM deals x WHERE x.signal_id = s.id AND x.result = 'win') + coalesce((s.demo_result = 'win')::int, 0) AS wins,
                (SELECT count(*)::int FROM deals x WHERE x.signal_id = s.id AND x.result = 'loss') + coalesce((s.demo_result = 'loss')::int, 0) AS losses
           FROM signals s
          WHERE NOT s.is_test
            AND s.entry_at + (s.expiry_min || ' minutes')::interval < now()
       ) q
        WHERE q.wins + q.losses > 0
        ORDER BY q.entry_at DESC LIMIT 5`,
      [],
    );
    if (r.rowCount) return r.rows;
    const t = await db.query('SELECT is_tester FROM leads WHERE tg_id = $1', [req.tg!.id]);
    return demoPast(Boolean(t.rows[0]?.is_tester));
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
    const r = await db.query(`SELECT id, kind, title, subtitle, url FROM media_items WHERE active ORDER BY sort, id`);
    const rows = r.rows.map((x) => ({ ...x, photo: tgHandle(x.url) ? `/api/app/media/${x.id}/photo` : null }));
    return { traders: rows.filter((x) => x.kind === 'trader'), channels: rows.filter((x) => x.kind === 'channel') };
  });

  // Аватарки каналов и трейдеров берём из Telegram. Картинка публичная, отдаём без авторизации, чтобы работал <img>
  app.get<{ Params: { id: string } }>('/media/:id/photo', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(404).send();
    let hit = photoCache.get(id);
    if (!hit || hit.until < Date.now()) {
      hit = { until: Date.now() + 3600_000, data: null, type: 'image/jpeg' };
      try {
        const m = await db.query('SELECT url FROM media_items WHERE id = $1 AND active', [id]);
        const handle = m.rowCount ? tgHandle(m.rows[0].url) : null;
        if (handle && !config.disableBot) {
          const chat = await bot.api.getChat('@' + handle);
          const fid = chat.photo?.small_file_id;
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
        }
      } catch (e) {
        req.log.warn({ err: String(e) }, 'avatar: ошибка запроса к Telegram');
        hit.until = Date.now() + 300_000;
      }
      photoCache.set(id, hit);
    }
    if (!hit.data) return reply.code(404).send();
    return reply.header('Cache-Control', 'public, max-age=3600').header('X-Content-Type-Options', 'nosniff').type(hit.type).send(hit.data);
  });
}
