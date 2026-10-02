import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db.js';
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
      `SELECT id, login, name, role, parent_id, rate_ftd, rate_percent, active, created_at
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
    if (typeof b.password === 'string' && b.password) {
      if (b.password.length < 8) return reply.code(400).send({ error: 'Пароль не короче 8 символов' });
      add('password_hash', await hashPassword(b.password));
    }
    if (!sets.length) return reply.code(400).send({ error: 'Нечего менять' });
    vals.push(id);
    const r = await db.query(`UPDATE staff SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id`, vals);
    if (!r.rowCount) return reply.code(404).send({ error: 'Не найден' });
    if (b.active === false || b.password) await db.query('DELETE FROM sessions WHERE staff_id = $1', [id]);
    return { ok: true };
  });

  // Ссылки
  app.get('/links', { preHandler: auth }, async (req) => {
    const me = req.staff!;
    const r = await db.query(
      `SELECT l.id, l.slug, l.source, l.campaign, l.clicks, l.created_at, s.name AS owner_name, l.owner_id,
              (SELECT count(*)::int FROM leads WHERE link_id = l.id) AS starts
         FROM links l JOIN staff s ON s.id = l.owner_id
        WHERE ${ownerScope(me, 'l.owner_id')} ORDER BY l.id DESC`,
    );
    return r.rows;
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

  // Журнал постбеков для админа
  app.get('/postbacks', { preHandler: need('admin') }, async () => {
    const r = await db.query(
      `SELECT id, event, query, tg_id, result, created_at FROM postback_log ORDER BY id DESC LIMIT 100`,
    );
    return r.rows;
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
      `SELECT d.tg_id, d.username, d.first_name, d.status, d.access, d.created_at, d.owner_id,
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
