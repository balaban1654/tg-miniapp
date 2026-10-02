import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db, attachLead } from './db.js';
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
    title: 'Вход в нужный момент',
    sub: 'как зайти в сделку по сигналу',
    steps: [
      'Откройте терминал и выберите актив из сигнала.',
      'Выставьте время экспирации так же, как в сигнале.',
      'Сумма сделки: не больше 1–2% от вашего депозита. Это правило важнее любого сигнала.',
      'Дождитесь момента входа, который указан в сигнале, и нажмите «Вверх» или «Вниз».',
      'Когда сделка закроется, вернитесь в приложение и отметьте результат в разделе «Сделки».',
    ],
  },
  {
    id: 2,
    title: 'Сделка ушла в минус',
    sub: 'как не усугубить потерю',
    steps: [
      'Минус в серии сделок бывает у всех. Это обычная часть торговли.',
      'Не увеличивайте сумму следующей сделки, чтобы отыграться. Так депозит теряют быстрее всего.',
      'После двух минусов подряд сделайте перерыв и не входите в сделки «на эмоциях».',
      'Заранее решите дневной лимит потерь и остановитесь, когда он достигнут.',
    ],
  },
  {
    id: 3,
    title: 'Цена на уровне входа',
    sub: 'что значит возврат',
    steps: [
      'Если цена закрытия равна цене входа, сделка закрывается без результата.',
      'Обычно в таком случае ставка возвращается. Точные условия уточняйте в правилах платформы.',
      'Такая сделка не засчитывается ни как плюс, ни как минус. В приложении отмечайте её кнопкой «Не входил» или пропустите.',
    ],
  },
];

export async function appRoutes(app: FastifyInstance): Promise<void> {
  const auth = async (req: FastifyRequest, reply: FastifyReply) => {
    const h = String(req.headers.authorization ?? '');
    const initData = h.startsWith('tma ') ? h.slice(4) : '';
    const user = initData ? verifyInitData(initData, config.botToken) : null;
    if (!user) return reply.code(401).send({ error: 'Откройте приложение из Telegram' });
    req.tg = user;
    // Если человек открыл приложение, не нажимая /start, всё равно заводим лида
    await attachLead(user.id, user.username, user.first_name, null);
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

  app.get('/media', { preHandler: auth }, async () => {
    const r = await db.query(`SELECT id, kind, title, subtitle, url FROM media_items WHERE active ORDER BY sort, id`);
    return { traders: r.rows.filter((x) => x.kind === 'trader'), channels: r.rows.filter((x) => x.kind === 'channel') };
  });
}
