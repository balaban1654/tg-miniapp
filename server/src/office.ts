import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { InputFile } from 'grammy';
import { db } from './db.js';
import { bot } from './bot.js';
import { config } from './config.js';
import { createBroadcast, segmentWhere, SEGMENTS, type Button } from './push.js';
import { randomInt } from 'node:crypto';
import {
  type Staff,
  type Role,
  COOKIE,
  createSession,
  destroySession,
  hashPassword,
  loginBlocked,
  loginFailed,
  loginOk,
  setSessionCookie,
  staffFromRequest,
  verifyPassword,
} from './auth.js';

const ROLES: Role[] = ['admin', 'teamlead', 'streamer', 'buyer', 'analyst'];
const SLUG = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const LOGIN = /^[a-zA-Z0-9._-]{3,40}$/;

declare module 'fastify' {
  interface FastifyRequest {
    staff?: Staff;
  }
}

/** Условие видимости лидов и ссылок по роли. Возвращает SQL-фрагмент для колонки owner. */
function ownerScope(me: Staff, col: string): string {
  if (me.role === 'admin') return 'TRUE';
  if (me.role === 'teamlead') {
    return `(${col} = ${me.id} OR ${col} IN (SELECT id FROM staff WHERE parent_id = ${me.id}))`;
  }
  if (me.role === 'analyst') return 'FALSE';
  return `${col} = ${me.id}`;
}

/** Чаты видят: админ все; тимлидер и стример неразобранные и свои (тимлидер ещё и команды). */
function chatScope(me: Staff, col: string): string {
  if (me.role === 'admin') return 'TRUE';
  if (me.role === 'teamlead') {
    return `(${col} IS NULL OR ${col} = ${me.id} OR ${col} IN (SELECT id FROM staff WHERE parent_id = ${me.id}))`;
  }
  if (me.role === 'streamer') return `(${col} IS NULL OR ${col} = ${me.id})`;
  return 'FALSE';
}

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

export async function officeRoutes(app: FastifyInstance): Promise<void> {
  const need = (...roles: Role[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    const me = await staffFromRequest(req);
    if (!me) return reply.code(401).send({ error: 'Требуется вход' });
    if (roles.length && !roles.includes(me.role)) return reply.code(403).send({ error: 'Нет доступа' });
    req.staff = me;
  };
  const auth = need();

  app.post('/login', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const login = str(body.login, 40);
    const password = typeof body.password === 'string' ? body.password : '';
    const key = `${req.ip}|${login.toLowerCase()}`;
    if (loginBlocked(key)) return reply.code(429).send({ error: 'Слишком много попыток. Подождите 15 минут.' });

    const r = await db.query('SELECT id, password_hash, active FROM staff WHERE lower(login) = lower($1)', [login]);
    const row = r.rows[0];
    // Проверяем пароль даже если пользователя нет, чтобы время ответа не выдавало логины
    const ok = await verifyPassword(password, row?.password_hash ?? 'aa:bb');
    if (!row || !row.active || !ok) {
      loginFailed(key);
      return reply.code(401).send({ error: 'Неверный логин или пароль' });
    }
    loginOk(key);
    setSessionCookie(reply, await createSession(row.id));
    return { ok: true };
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await destroySession(token);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', { preHandler: auth }, async (req) => req.staff);

  // Сводка для дашборда
  app.get('/stats', { preHandler: auth }, async (req) => {
    const me = req.staff!;
    const leads = await db.query(
      `SELECT status, count(*)::int AS n FROM leads WHERE ${ownerScope(me, 'owner_id')} GROUP BY status`,
    );
    const clicks = await db.query(`SELECT coalesce(sum(clicks),0)::int AS n FROM links WHERE ${ownerScope(me, 'owner_id')}`);
    const money = await db.query(
      `SELECT e.type, coalesce(sum(e.amount),0)::float AS s
         FROM events e JOIN leads d ON d.tg_id = e.tg_id
        WHERE e.type IN ('ftd','dep','wd','comm') AND ${ownerScope(me, 'd.owner_id')} GROUP BY e.type`,
    );
    const m: Record<string, number> = {};
    for (const x of money.rows) m[x.type] = x.s;
    const by: Record<string, number> = {};
    for (const x of leads.rows) by[x.status] = x.n;
    return {
      byStatus: by,
      total: Object.values(by).reduce((a, b) => a + b, 0),
      clicks: clicks.rows[0].n,
      deposits: (m.ftd ?? 0) + (m.dep ?? 0),
      withdrawals: m.wd ?? 0,
      // Комиссия партнёрки видна только админу
      commission: me.role === 'admin' ? (m.comm ?? 0) : null,
    };
  });

  // Люди команды
  app.get('/staff', { preHandler: auth }, async (req) => {
    const me = req.staff!;
    const scope =
      me.role === 'admin' ? 'TRUE' : me.role === 'teamlead' ? `(id = ${me.id} OR parent_id = ${me.id})` : `id = ${me.id}`;
    const r = await db.query(
      `SELECT id, login, name, role, parent_id, rate_ftd, rate_percent, active, created_at,
              po_campaign, po_promo, po_link, po_link_ru
         FROM staff WHERE ${scope} ORDER BY id`,
    );
    return r.rows;
  });

  app.post('/staff', { preHandler: need('admin', 'teamlead') }, async (req, reply) => {
    const me = req.staff!;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const login = str(b.login, 40);
    const password = typeof b.password === 'string' ? b.password : '';
    const name = str(b.name, 80);
    let role = str(b.role, 20) as Role;
    let parentId: number | null = b.parent_id ? Number(b.parent_id) : null;

    if (!LOGIN.test(login)) return reply.code(400).send({ error: 'Логин: 3–40 символов, латиница, цифры, . _ -' });
    if (password.length < 8) return reply.code(400).send({ error: 'Пароль не короче 8 символов' });
    if (!name) return reply.code(400).send({ error: 'Укажите имя' });
    if (!ROLES.includes(role)) return reply.code(400).send({ error: 'Неизвестная роль' });

    if (me.role === 'teamlead') {
      role = 'streamer';
      parentId = me.id;
    } else if (parentId !== null) {
      const p = await db.query(`SELECT 1 FROM staff WHERE id = $1 AND role = 'teamlead'`, [parentId]);
      if (!p.rowCount) return reply.code(400).send({ error: 'Родитель должен быть тимлидером' });
    }

    try {
      const r = await db.query(
        `INSERT INTO staff (login, password_hash, name, role, parent_id, rate_ftd, rate_percent)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [login, await hashPassword(password), name, role, parentId, num(b.rate_ftd), num(b.rate_percent)],
      );
      return { id: r.rows[0].id };
    } catch (e: any) {
      if (e.code === '23505') return reply.code(409).send({ error: 'Такой логин уже есть' });
      throw e;
    }
  });

  app.patch<{ Params: { id: string } }>('/staff/:id', { preHandler: need('admin') }, async (req, reply) => {
    const id = Number(req.params.id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (b.name !== undefined) add('name', str(b.name, 80));
    if (b.active !== undefined) add('active', Boolean(b.active));
    if (b.rate_ftd !== undefined) add('rate_ftd', num(b.rate_ftd));
    if (b.rate_percent !== undefined) add('rate_percent', num(b.rate_percent));
    if (b.parent_id !== undefined) add('parent_id', b.parent_id ? Number(b.parent_id) : null);
    const link = (v: unknown): string | null | undefined => {
      if (v === undefined) return undefined;
      const t = str(v, 600);
      if (!t) return null;
      return /^https:\/\/[^\s]+$/.test(t) ? t : undefined;
    };
    if (b.po_campaign !== undefined) {
      const c = str(b.po_campaign, 40);
      if (c && !/^[a-zA-Z0-9_-]{1,40}$/.test(c)) return reply.code(400).send({ error: 'Код кампании: латиница, цифры, - и _' });
      add('po_campaign', c || null);
    }
    if (b.po_promo !== undefined) {
      const c = str(b.po_promo, 30);
      if (c && !/^[a-zA-Z0-9]{1,30}$/.test(c)) return reply.code(400).send({ error: 'Промокод: латиница и цифры' });
      add('po_promo', c || null);
    }
    for (const k of ['po_link', 'po_link_ru'] as const) {
      const v = link(b[k]);
      if (b[k] !== undefined && v === undefined) return reply.code(400).send({ error: 'Ссылка должна начинаться с https://' });
      if (v !== undefined) add(k, v);
    }
    if (typeof b.password === 'string' && b.password) {
      if (b.password.length < 8) return reply.code(400).send({ error: 'Пароль не короче 8 символов' });
      add('password_hash', await hashPassword(b.password));
    }
    if (!sets.length) return reply.code(400).send({ error: 'Нечего менять' });
    vals.push(id);
    let r;
    try {
      r = await db.query(`UPDATE staff SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id`, vals);
    } catch (e: any) {
      if (e.code === '23505') return reply.code(409).send({ error: 'Такой код кампании уже у другого человека' });
      throw e;
    }
    if (!r.rowCount) return reply.code(404).send({ error: 'Не найден' });
    if (b.active === false || b.password) await db.query('DELETE FROM sessions WHERE staff_id = $1', [id]);
    return { ok: true };
  });

  // Ссылки с результатами по каждой
  app.get('/links', { preHandler: auth }, async (req) => {
    const me = req.staff!;
    const r = await db.query(
      `SELECT l.id, l.slug, l.source, l.campaign, l.clicks, l.created_at, s.name AS owner_name, l.owner_id,
              (SELECT count(*)::int FROM leads d WHERE d.link_id = l.id) AS starts,
              (SELECT count(*)::int FROM leads d WHERE d.link_id = l.id
                 AND EXISTS (SELECT 1 FROM events e WHERE e.tg_id = d.tg_id AND e.type = 'reg')) AS regs,
              (SELECT count(*)::int FROM leads d WHERE d.link_id = l.id AND d.status IN ('ftd','active')) AS ftds,
              coalesce((SELECT sum(e.amount) FROM events e JOIN leads d ON d.tg_id = e.tg_id
                 WHERE d.link_id = l.id AND e.type IN ('ftd','dep')),0)::float AS deposits,
              coalesce((SELECT sum(e.amount) FROM events e JOIN leads d ON d.tg_id = e.tg_id
                 WHERE d.link_id = l.id AND e.type = 'comm'),0)::float AS commission
         FROM links l JOIN staff s ON s.id = l.owner_id
        WHERE ${ownerScope(me, 'l.owner_id')} ORDER BY l.id DESC`,
    );
    // Комиссия партнёрки видна только админу
    if (me.role !== 'admin') for (const x of r.rows) x.commission = null;
    return r.rows;
  });

  // Итоги по источникам: все ссылки с одним и тем же источником складываются вместе
  app.get('/sources', { preHandler: auth }, async (req) => {
    const me = req.staff!;
    const r = await db.query(
      `SELECT coalesce(nullif(l.source,''), 'Без источника') AS source,
              count(DISTINCT l.id)::int AS links,
              coalesce(sum(l.clicks),0)::int AS clicks
         FROM links l WHERE ${ownerScope(me, 'l.owner_id')} GROUP BY 1`,
    );
    const res = await db.query(
      `SELECT coalesce(nullif(l.source,''), 'Без источника') AS source,
              count(d.tg_id)::int AS starts,
              count(d.tg_id) FILTER (WHERE EXISTS (SELECT 1 FROM events e WHERE e.tg_id = d.tg_id AND e.type = 'reg'))::int AS regs,
              count(d.tg_id) FILTER (WHERE d.status IN ('ftd','active'))::int AS ftds,
              coalesce(sum((SELECT sum(e.amount) FROM events e WHERE e.tg_id = d.tg_id AND e.type IN ('ftd','dep'))),0)::float AS deposits,
              coalesce(sum((SELECT sum(e.amount) FROM events e WHERE e.tg_id = d.tg_id AND e.type = 'comm')),0)::float AS commission
         FROM links l JOIN leads d ON d.link_id = l.id
        WHERE ${ownerScope(me, 'l.owner_id')} GROUP BY 1`,
    );
    const byS = new Map(res.rows.map((x) => [x.source, x]));
    const out = r.rows.map((x) => ({
      ...x,
      starts: byS.get(x.source)?.starts ?? 0,
      regs: byS.get(x.source)?.regs ?? 0,
      ftds: byS.get(x.source)?.ftds ?? 0,
      deposits: byS.get(x.source)?.deposits ?? 0,
      commission: me.role === 'admin' ? (byS.get(x.source)?.commission ?? 0) : null,
    }));
    return out.sort((a, b) => b.deposits - a.deposits || b.clicks - a.clicks);
  });

  app.post('/links', { preHandler: need('admin', 'teamlead', 'streamer', 'buyer') }, async (req, reply) => {
    const me = req.staff!;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const slug = str(b.slug, 40).toLowerCase();
    if (!SLUG.test(slug)) return reply.code(400).send({ error: 'Адрес ссылки: 2–40 символов, a-z, 0-9, - и _' });

    let ownerId = me.id;
    if (b.owner_id && Number(b.owner_id) !== me.id) {
      const allowed = await db.query(
        `SELECT 1 FROM staff WHERE id = $1 AND ${me.role === 'admin' ? 'TRUE' : `parent_id = ${me.id}`}`,
        [Number(b.owner_id)],
      );
      if (!allowed.rowCount) return reply.code(403).send({ error: 'Нельзя создать ссылку для этого человека' });
      ownerId = Number(b.owner_id);
    }
    try {
      const r = await db.query(
        `INSERT INTO links (slug, owner_id, source, campaign) VALUES ($1,$2,$3,$4) RETURNING id`,
        [slug, ownerId, str(b.source, 60) || null, str(b.campaign, 60) || null],
      );
      return { id: r.rows[0].id };
    } catch (e: any) {
      if (e.code === '23505') return reply.code(409).send({ error: 'Такой адрес уже занят' });
      throw e;
    }
  });

  // Чаты поддержки
  app.get('/chats', { preHandler: auth }, async (req) => {
    const me = req.staff!;
    const r = await db.query(
      `SELECT d.tg_id, d.username, d.first_name, d.owner_id, o.name AS owner_name,
              m.direction AS last_dir, m.kind AS last_kind, m.text AS last_text, m.created_at AS last_at
         FROM leads d
         JOIN LATERAL (SELECT direction, kind, text, created_at FROM messages WHERE tg_id = d.tg_id ORDER BY id DESC LIMIT 1) m ON TRUE
         LEFT JOIN staff o ON o.id = d.owner_id
        WHERE ${chatScope(me, 'd.owner_id')}
        ORDER BY (m.direction = 'in') DESC, m.created_at DESC LIMIT 200`,
    );
    return r.rows.map((x) => ({ ...x, waiting: x.last_dir === 'in' }));
  });

  app.get<{ Params: { tgId: string } }>('/chats/:tgId', { preHandler: auth }, async (req, reply) => {
    const me = req.staff!;
    const tgId = Number(req.params.tgId);
    const lead = await db.query(
      `SELECT d.tg_id, d.username, d.first_name, d.owner_id, d.status, d.trader_id, o.name AS owner_name
         FROM leads d LEFT JOIN staff o ON o.id = d.owner_id WHERE d.tg_id = $1 AND ${chatScope(me, 'd.owner_id')}`,
      [tgId],
    );
    if (!lead.rowCount) return reply.code(404).send({ error: 'Чат не найден' });
    const msgs = await db.query(
      `SELECT m.id, m.direction, m.kind, m.text, m.created_at, (m.file_id IS NOT NULL) AS has_file, s.name AS staff_name
         FROM messages m LEFT JOIN staff s ON s.id = m.staff_id WHERE m.tg_id = $1 ORDER BY m.id DESC LIMIT 200`,
      [tgId],
    );
    return { lead: lead.rows[0], messages: msgs.rows.reverse() };
  });

  app.get<{ Params: { tgId: string; msgId: string } }>('/chats/:tgId/file/:msgId', { preHandler: auth }, async (req, reply) => {
    const me = req.staff!;
    const r = await db.query(
      `SELECT m.file_id, m.kind FROM messages m JOIN leads d ON d.tg_id = m.tg_id
        WHERE m.id = $1 AND m.tg_id = $2 AND m.file_id IS NOT NULL AND ${chatScope(me, 'd.owner_id')}`,
      [Number(req.params.msgId), Number(req.params.tgId)],
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'Файл не найден' });
    try {
      const f = await bot.api.getFile(r.rows[0].file_id);
      const resp = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${f.file_path}`);
      if (!resp.ok) throw new Error('telegram');
      const ext = (f.file_path ?? '').split('.').pop()?.toLowerCase() ?? '';
      const types: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', pdf: 'application/pdf' };
      return reply
        .header('Cache-Control', 'private, max-age=3600')
        .header('X-Content-Type-Options', 'nosniff')
        .type(types[ext] ?? 'application/octet-stream')
        .send(Buffer.from(await resp.arrayBuffer()));
    } catch {
      return reply.code(502).send({ error: 'Не удалось получить файл из Telegram' });
    }
  });

  app.post<{ Params: { tgId: string } }>('/chats/:tgId/reply', { preHandler: auth, bodyLimit: 9 * 1024 * 1024 }, async (req, reply) => {
    const me = req.staff!;
    const tgId = Number(req.params.tgId);
    const text = str((req.body as any)?.text, 4000);
    // Скриншот приходит как base64; принимаем только настоящие jpg/png/webp до 6 МБ
    let photo: Buffer | null = null;
    const rawPhoto = (req.body as any)?.photo;
    if (typeof rawPhoto === 'string' && rawPhoto) {
      const b = Buffer.from(rawPhoto.replace(/^data:[^,]*,/, ''), 'base64');
      const ok = b.length > 12 && ((b[0] === 0xff && b[1] === 0xd8) || b.subarray(1, 4).toString() === 'PNG' || (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP'));
      if (!ok) return reply.code(400).send({ error: 'Прикрепите картинку JPG, PNG или WebP' });
      if (b.length > 6 * 1024 * 1024) return reply.code(400).send({ error: 'Картинка больше 6 МБ' });
      photo = b;
    }
    if (!text && !photo) return reply.code(400).send({ error: 'Введите сообщение' });
    if (photo && text.length > 1024) return reply.code(400).send({ error: 'Подпись к картинке не длиннее 1024 символов' });
    const lead = await db.query(`SELECT d.owner_id FROM leads d WHERE d.tg_id = $1 AND ${chatScope(me, 'd.owner_id')}`, [tgId]);
    if (!lead.rowCount) return reply.code(404).send({ error: 'Чат не найден' });

    // Кто первым ответил, тот и забирает лида. Админ лидов не забирает.
    if (lead.rows[0].owner_id === null && (me.role === 'streamer' || me.role === 'teamlead')) {
      const claim = await db.query('UPDATE leads SET owner_id = $2 WHERE tg_id = $1 AND owner_id IS NULL RETURNING tg_id', [tgId, me.id]);
      if (!claim.rowCount) {
        const o = await db.query('SELECT o.id, o.name FROM leads d JOIN staff o ON o.id = d.owner_id WHERE d.tg_id = $1', [tgId]);
        if (o.rows[0]?.id !== me.id) return reply.code(409).send({ error: `Этого клиента уже взял ${o.rows[0]?.name ?? 'другой стример'}` });
      }
    }

    let tgMessageId: number | null = null;
    let fileId: string | null = null;
    if (!config.disableBot) {
      try {
        if (photo) {
          const sent = await bot.api.sendPhoto(tgId, new InputFile(photo, 'image'), text ? { caption: text } : {});
          tgMessageId = sent.message_id;
          fileId = sent.photo[sent.photo.length - 1]?.file_id ?? null;
        } else {
          tgMessageId = (await bot.api.sendMessage(tgId, text)).message_id;
        }
      } catch {
        return reply.code(502).send({ error: 'Telegram не принял сообщение. Возможно, клиент заблокировал бота.' });
      }
    }
    await db.query(`INSERT INTO messages (tg_id, direction, staff_id, kind, text, file_id, tg_message_id) VALUES ($1,'out',$2,$3,$4,$5,$6)`, [tgId, me.id, photo ? 'photo' : 'text', text || null, fileId, tgMessageId]);
    return { ok: true };
  });

  // Пуши и рассылки (только админ)
  const TRIGGERS = ['start', 'no_reg', 'no_deposit', 'ftd', 'inactive'];
  function cleanButtons(v: unknown): Button[] | string {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > 4) return 'Кнопок не больше четырёх';
    const out: Button[] = [];
    for (const raw of v) {
      const b = (raw ?? {}) as Record<string, unknown>;
      const label = str(b.label, 40);
      const type = str(b.type, 12);
      if (!label) return 'У кнопки нужна подпись';
      if (type === 'url') {
        const url = str(b.url, 400);
        if (!/^https:\/\/[^\s]+$/.test(url)) return 'Ссылка кнопки должна начинаться с https://';
        out.push({ label, type, url });
      } else if (type === 'callback') {
        const data = str(b.data, 20);
        if (!['acc_no', 'acc_yes'].includes(data)) return 'Неизвестное действие кнопки';
        out.push({ label, type, data });
      } else if (['miniapp', 'support', 'register'].includes(type)) out.push({ label, type: type as Button['type'] });
      else return 'Неизвестный тип кнопки';
    }
    return out;
  }

  app.get('/push/rules', { preHandler: need('admin') }, async () => {
    const r = await db.query(
      `SELECT r.id, r.name, r.trigger, r.delay_min, r.text, r.buttons, r.daytime_only, r.enabled,
              (SELECT count(*)::int FROM push_log l WHERE l.rule_id = r.id AND l.status = 'sent') AS sent,
              (SELECT count(*)::int FROM push_log l WHERE l.rule_id = r.id AND l.status = 'failed') AS failed
         FROM push_rules r ORDER BY r.sort, r.id`,
    );
    return r.rows;
  });

  async function readRule(b: Record<string, unknown>, partial: boolean) {
    const out: Record<string, unknown> = {};
    if (!partial || b.name !== undefined) {
      out.name = str(b.name, 80);
      if (!out.name) return { error: 'Укажите название' };
    }
    if (!partial || b.trigger !== undefined) {
      out.trigger = str(b.trigger, 20);
      if (!TRIGGERS.includes(out.trigger as string)) return { error: 'Неизвестный триггер' };
    }
    if (!partial || b.delay_min !== undefined) {
      const d = Math.trunc(Number(b.delay_min));
      if (!Number.isFinite(d) || d < 0 || d > 43200) return { error: 'Задержка от 0 до 30 дней' };
      out.delay_min = d;
    }
    if (!partial || b.text !== undefined) {
      out.text = str(b.text, 4000);
      if (!out.text) return { error: 'Введите текст' };
    }
    if (!partial || b.buttons !== undefined) {
      const bt = cleanButtons(b.buttons);
      if (typeof bt === 'string') return { error: bt };
      out.buttons = JSON.stringify(bt);
    }
    if (b.daytime_only !== undefined) out.daytime_only = Boolean(b.daytime_only);
    if (b.enabled !== undefined) out.enabled = Boolean(b.enabled);
    return { values: out };
  }

  app.post('/push/rules', { preHandler: need('admin') }, async (req, reply) => {
    const r = await readRule((req.body ?? {}) as Record<string, unknown>, false);
    if (r.error) return reply.code(400).send({ error: r.error });
    const v = r.values!;
    const ins = await db.query(
      `INSERT INTO push_rules (name, trigger, delay_min, text, buttons, daytime_only, sort)
       VALUES ($1,$2,$3,$4,$5,$6,(SELECT coalesce(max(sort),0)+1 FROM push_rules)) RETURNING id`,
      [v.name, v.trigger, v.delay_min, v.text, v.buttons ?? '[]', v.daytime_only ?? false],
    );
    return { id: ins.rows[0].id };
  });

  app.patch<{ Params: { id: string } }>('/push/rules/:id', { preHandler: need('admin') }, async (req, reply) => {
    const r = await readRule((req.body ?? {}) as Record<string, unknown>, true);
    if (r.error) return reply.code(400).send({ error: r.error });
    const v = r.values!;
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, val] of Object.entries(v)) {
      vals.push(val);
      sets.push(`${k} = $${vals.length}`);
    }
    if (!sets.length) return reply.code(400).send({ error: 'Нечего менять' });
    // Любое изменение срока или включение правила начинает отсчёт заново, чтобы не разослать его по старой базе
    if (v.enabled === true || v.trigger !== undefined || v.delay_min !== undefined) sets.push('starts_at = now()');
    vals.push(Number(req.params.id));
    const u = await db.query(`UPDATE push_rules SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id`, vals);
    if (!u.rowCount) return reply.code(404).send({ error: 'Не найдено' });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/push/rules/:id', { preHandler: need('admin') }, async (req) => {
    await db.query('DELETE FROM push_rules WHERE id = $1', [Number(req.params.id)]);
    return { ok: true };
  });

  app.get<{ Querystring: { owner_id?: string } }>('/push/segments', { preHandler: need('admin') }, async (req) => {
    const owner = req.query.owner_id ? Number(req.query.owner_id) : null;
    const out: Record<string, number> = {};
    for (const k of Object.keys(SEGMENTS)) {
      const w = segmentWhere(k, owner);
      out[k] = (await db.query(`SELECT count(*)::int AS n FROM leads d WHERE ${w.sql}`, w.params)).rows[0].n;
    }
    return out;
  });

  app.post('/push/broadcast', { preHandler: need('admin') }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const text = str(b.text, 4000);
    const segment = str(b.segment, 20);
    const buttons = cleanButtons(b.buttons);
    if (!text) return reply.code(400).send({ error: 'Введите текст' });
    if (!(segment in SEGMENTS)) return reply.code(400).send({ error: 'Неизвестный сегмент' });
    if (typeof buttons === 'string') return reply.code(400).send({ error: buttons });
    const res = await createBroadcast({ text, buttons, segment, ownerId: b.owner_id ? Number(b.owner_id) : null, createdBy: req.staff!.id });
    if (!res.total) return reply.code(400).send({ error: 'В этом сегменте нет получателей' });
    return res;
  });

  app.get('/push/broadcasts', { preHandler: need('admin') }, async () => {
    const r = await db.query(
      `SELECT b.id, b.text, b.segment, b.total, b.created_at,
              count(*) FILTER (WHERE j.status = 'sent')::int AS sent,
              count(*) FILTER (WHERE j.status = 'failed')::int AS failed,
              count(*) FILTER (WHERE j.status = 'pending')::int AS pending
         FROM broadcasts b LEFT JOIN broadcast_jobs j ON j.broadcast_id = b.id
        GROUP BY b.id ORDER BY b.id DESC LIMIT 30`,
    );
    return r.rows;
  });

  // Журнал постбеков для админа
  app.get('/postbacks', { preHandler: need('admin') }, async () => {
    const r = await db.query(
      `SELECT id, event, query, tg_id, result, created_at FROM postback_log ORDER BY id DESC LIMIT 100`,
    );
    return r.rows;
  });

  // Медиа для Mini App: трейдеры и каналы
  app.get('/media', { preHandler: need('admin') }, async () => {
    return (await db.query('SELECT id, kind, title, subtitle, url, sort, active FROM media_items ORDER BY kind DESC, sort, id')).rows;
  });
  app.post('/media', { preHandler: need('admin') }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = str(b.kind, 10);
    const title = str(b.title, 80);
    const url = str(b.url, 300);
    if (!['trader', 'channel'].includes(kind)) return reply.code(400).send({ error: 'Неверный тип' });
    if (!title) return reply.code(400).send({ error: 'Укажите название' });
    if (!/^https:\/\/[^\s]+$/.test(url)) return reply.code(400).send({ error: 'Ссылка должна начинаться с https://' });
    const r = await db.query(
      'INSERT INTO media_items (kind, title, subtitle, url, sort) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [kind, title, str(b.subtitle, 80) || null, url, Math.trunc(num(b.sort))],
    );
    return { id: r.rows[0].id };
  });
  app.delete<{ Params: { id: string } }>('/media/:id', { preHandler: need('admin') }, async (req) => {
    await db.query('DELETE FROM media_items WHERE id = $1', [Number(req.params.id)]);
    return { ok: true };
  });

  // Сигналы. Публикует человек. Случайный режим есть только для тестов и виден только тестовым аккаунтам
  const PAIR = /^[A-Za-z0-9]{2,8}\/[A-Za-z0-9]{2,8}( OTC)?$/;
  const EXPIRY = [1, 2, 3, 5, 10, 15];
  const tfmt = (d: Date) => new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: config.pushTz }).format(d);

  async function publishSignal(o: { pair: string; direction: 'up' | 'down'; expiry: number; enterIn: number; note: string | null; source: 'analyst' | 'test' | 'engine'; isTest: boolean; by: number; push: boolean }) {
    const entryAt = new Date(Date.now() + o.enterIn * 60_000);
    const ins = await db.query(
      `INSERT INTO signals (pair, direction, expiry_min, entry_at, note, source, is_test, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [o.pair, o.direction, o.expiry, entryAt, o.note, o.source, o.isTest, o.by],
    );
    let pushed = 0;
    if (o.push) {
      const text = `${o.isTest ? 'ТЕСТ. Не для торговли.\n' : ''}Новый сигнал: ${o.pair}, ${o.direction === 'up' ? 'вверх' : 'вниз'}, экспирация ${o.expiry} мин.\nВход в ${tfmt(entryAt)} (МСК). Откройте кабинет.`;
      const r = await createBroadcast({ text, buttons: [{ label: 'Открыть кабинет', type: 'miniapp' }], segment: o.isTest ? 'testers' : 'access', createdBy: o.by });
      pushed = r.total;
    }
    return { id: ins.rows[0].id, pushed };
  }

  app.get('/signals', { preHandler: need('admin', 'analyst') }, async () => {
    const r = await db.query(
      `SELECT s.id, s.pair, s.direction, s.expiry_min, s.entry_at, s.note, s.source, s.is_test, s.created_at, st.name AS author,
              (SELECT count(*)::int FROM deals x WHERE x.signal_id = s.id) AS taken,
              (SELECT count(*)::int FROM deals x WHERE x.signal_id = s.id AND x.result = 'win') AS wins,
              (SELECT count(*)::int FROM deals x WHERE x.signal_id = s.id AND x.result = 'loss') AS losses
         FROM signals s LEFT JOIN staff st ON st.id = s.created_by ORDER BY s.id DESC LIMIT 40`,
    );
    return r.rows;
  });

  app.post('/signals', { preHandler: need('admin', 'analyst') }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const pair = str(b.pair, 20).toUpperCase();
    const direction = str(b.direction, 4);
    const expiry = Number(b.expiry_min);
    const enterIn = b.enter_in_min === undefined || b.enter_in_min === '' ? 2 : Math.trunc(Number(b.enter_in_min));
    if (!PAIR.test(pair)) return reply.code(400).send({ error: 'Пара в формате EUR/USD или EUR/USD OTC' });
    if (!['up', 'down'].includes(direction)) return reply.code(400).send({ error: 'Выберите направление' });
    if (!EXPIRY.includes(expiry)) return reply.code(400).send({ error: 'Экспирация: 1, 2, 3, 5, 10 или 15 минут' });
    if (!Number.isFinite(enterIn) || enterIn < 0 || enterIn > 60) return reply.code(400).send({ error: 'Вход через 0–60 минут' });
    return publishSignal({ pair, direction: direction as 'up' | 'down', expiry, enterIn, note: str(b.note, 200) || null, source: 'analyst', isTest: Boolean(b.is_test), by: req.staff!.id, push: b.push !== false });
  });

  // Случайный сигнал только для проверки бота: всегда помечен ТЕСТ и уходит только тестовым аккаунтам
  app.post('/signals/test', { preHandler: need('admin') }, async (req) => {
    const pairs = ['EUR/USD OTC', 'GBP/USD OTC', 'USD/JPY OTC', 'AUD/CAD OTC', 'EUR/GBP OTC'];
    return publishSignal({
      pair: pairs[randomInt(pairs.length)],
      direction: randomInt(2) ? 'up' : 'down',
      expiry: 1,
      enterIn: 1,
      note: 'Тестовый сигнал для проверки бота. Это не торговая рекомендация.',
      source: 'test',
      isTest: true,
      by: req.staff!.id,
      push: true,
    });
  });

  app.patch<{ Params: { tgId: string } }>('/leads/:tgId/tester', { preHandler: need('admin') }, async (req, reply) => {
    const r = await db.query('UPDATE leads SET is_tester = $2 WHERE tg_id = $1 RETURNING tg_id', [Number(req.params.tgId), Boolean((req.body as any)?.value)]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Лид не найден' });
    return { ok: true };
  });

  // Очистка журнала. Лиды, события и деньги не затрагиваются
  app.delete('/postbacks', { preHandler: need('admin') }, async () => {
    const r = await db.query('DELETE FROM postback_log');
    return { ok: true, deleted: r.rowCount };
  });

  // Лиды
  app.get<{ Querystring: { status?: string } }>('/leads', { preHandler: auth }, async (req) => {
    const me = req.staff!;
    const status = str(req.query.status, 20);
    const vals: unknown[] = [];
    let extra = '';
    if (status) {
      vals.push(status);
      extra = ` AND d.status = $1`;
    }
    const r = await db.query(
      `SELECT d.tg_id, d.trader_id, d.is_tester, d.username, d.first_name, d.status, d.access, d.created_at, d.owner_id,
              s.name AS owner_name, l.slug AS link_slug,
              coalesce((SELECT sum(amount) FROM events e WHERE e.tg_id = d.tg_id AND e.type IN ('ftd','dep')),0) AS deposits,
              coalesce((SELECT sum(amount) FROM events e WHERE e.tg_id = d.tg_id AND e.type = 'comm'),0) AS commission
         FROM leads d
         LEFT JOIN staff s ON s.id = d.owner_id
         LEFT JOIN links l ON l.id = d.link_id
        WHERE ${ownerScope(me, 'd.owner_id')}${extra}
        ORDER BY d.created_at DESC LIMIT 300`,
      vals,
    );
    return r.rows;
  });
}
