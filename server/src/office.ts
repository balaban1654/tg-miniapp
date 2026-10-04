import QRCode from 'qrcode';
import { newSecret, otpUri, verifyTotp, newRecoveryCodes } from './totp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { InputFile } from 'grammy';
import { db } from './db.js';
import { bot } from './bot.js';
import { config } from './config.js';
import { createBroadcast, segmentWhere, SEGMENTS, type Button } from './push.js';
import { randomInt, randomBytes, createHash } from 'node:crypto';
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
import { accountingRoutes } from './accounting.js';
import { toVoice, toVideoNote } from './media.js';
import {
  type Staff,
  type Role,
  COOKIE,
  createSession,
  destroySession,
  hashPassword,
  loginBlocked,
  TOTP_REQUIRED,
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

/** Способы выплат: позже список переедет в раздел «Бухгалтерия» */
const PAYOUT_METHODS = ['Tippo ID', 'USDT BEP20'];
const STAFF_CARD_COLS = 'id, login, name, role, tg_username, full_name, to_char(birth_date, \'YYYY-MM-DD\') AS birth_date, city, payout_method, payout_wallet';

/** Разбор полей карточки сотрудника: вернёт колонки для UPDATE или текст ошибки */
function cardFields(b: Record<string, unknown>): { cols: Record<string, unknown> } | { error: string } {
  const cols: Record<string, unknown> = {};
  if (b.full_name !== undefined) cols.full_name = str(b.full_name, 120) || null;
  if (b.city !== undefined) cols.city = str(b.city, 80) || null;
  if (b.birth_date !== undefined) {
    const v = str(b.birth_date, 10);
    if (v) {
      const d = new Date(v + 'T00:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(d.getTime()) || d.getTime() > Date.now() || d.getUTCFullYear() < 1900) return { error: 'Дата рождения: укажите корректную дату' };
    }
    cols.birth_date = v || null;
  }
  if (b.payout_method !== undefined) {
    const v = str(b.payout_method, 40);
    if (v && !PAYOUT_METHODS.includes(v)) return { error: 'Неизвестный способ выплаты' };
    cols.payout_method = v || null;
  }
  if (b.payout_wallet !== undefined) cols.payout_wallet = str(b.payout_wallet, 200) || null;
  return { cols };
}

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

// Какие события считать депозитами: стримеру видны только первые (FTD), без додепов
const depTypes = (me: Staff): string => (me.role === 'streamer' ? "('ftd')" : "('ftd','dep')");

export async function officeRoutes(app: FastifyInstance): Promise<void> {
  const need = (...roles: Role[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    const me = await staffFromRequest(req);
    if (!me) return reply.code(401).send({ error: 'Требуется вход' });
    if (roles.length && !roles.includes(me.role)) return reply.code(403).send({ error: 'Нет доступа' });
    req.staff = me;
    // Обязательная 2FA: пока не включена, пускаем только на /me, настройку 2FA и выход
    if (!me.totp && TOTP_REQUIRED.includes(me.role) && !/^\/api\/office\/(me|logout|profile\/2fa)/.test(req.url)) {
      return reply.code(403).send({ error: 'Включите двухфакторную защиту', code: 'totp_setup' });
    }
  };
  const auth = need();

  app.post('/login', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const login = str(body.login, 40);
    const password = typeof body.password === 'string' ? body.password : '';
    const key = `${req.ip}|${login.toLowerCase()}`;
    if (loginBlocked(key)) return reply.code(429).send({ error: 'Слишком много попыток. Подождите 15 минут.' });

    const r = await db.query('SELECT id, password_hash, active, totp_secret FROM staff WHERE lower(login) = lower($1)', [login]);
    const row = r.rows[0];
    // Проверяем пароль даже если пользователя нет, чтобы время ответа не выдавало логины
    const ok = await verifyPassword(password, row?.password_hash ?? 'aa:bb');
    if (!row || !row.active || !ok) {
      loginFailed(key);
      return reply.code(401).send({ error: 'Неверный логин или пароль' });
    }
    if (row.totp_secret) {
      // Пароль верный, нужен второй шаг: код из приложения. Ключ попыток тот же (ip+login), пароль не сбрасывает счётчик
      const ch = randomBytes(24).toString('hex');
      await db.query(`INSERT INTO login_challenges (token_hash, staff_id, expires_at) VALUES ($1,$2, now() + interval '5 minutes')`, [sha256(ch), row.id]);
      await db.query('DELETE FROM login_challenges WHERE expires_at < now()');
      return { need_totp: true, challenge: ch };
    }
    loginOk(key);
    setSessionCookie(reply, await createSession(row.id));
    return { ok: true };
  });

  // Второй шаг входа: код из приложения или резервный код
  app.post('/login/totp', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ch = typeof body.challenge === 'string' ? body.challenge : '';
    const code = str(body.code, 20);
    const bad = () => reply.code(401).send({ error: 'Неверный код' });
    const c = (await db.query(
      `UPDATE login_challenges SET tries = tries + 1 WHERE token_hash = $1 AND expires_at > now() AND tries < 5 RETURNING staff_id`,
      [sha256(ch)],
    )).rows[0];
    if (!c) return reply.code(401).send({ error: 'Время входа истекло, введите логин и пароль заново', restart: true });
    const st = (await db.query('SELECT id, login, active, totp_secret, totp_last, recovery_codes FROM staff WHERE id = $1', [c.staff_id])).rows[0];
    if (!st || !st.active || !st.totp_secret) return bad();
    const key = `${req.ip}|${String(st.login).toLowerCase()}`;
    if (loginBlocked(key)) return reply.code(429).send({ error: 'Слишком много попыток. Подождите 15 минут.' });
    let ok = false;
    const step = verifyTotp(st.totp_secret, code);
    if (step !== null && step > Number(st.totp_last)) {
      // Одноразовость: тот же шаг второй раз не принимаем
      ok = (await db.query('UPDATE staff SET totp_last = $2 WHERE id = $1 AND totp_last < $2', [st.id, step])).rowCount === 1;
    } else if (/^[0-9a-f]{5}-?[0-9a-f]{5}$/i.test(code)) {
      const h = sha256(code.toLowerCase().replace('-', ''));
      ok = (await db.query('UPDATE staff SET recovery_codes = array_remove(recovery_codes, $2) WHERE id = $1 AND $2 = ANY(recovery_codes)', [st.id, h])).rowCount === 1;
    }
    if (!ok) {
      loginFailed(key);
      return bad();
    }
    loginOk(key);
    await db.query('DELETE FROM login_challenges WHERE token_hash = $1', [sha256(ch)]);
    setSessionCookie(reply, await createSession(st.id));
    return { ok: true, recovery_left: st.recovery_codes.length - (step === null ? 1 : 0) };
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await destroySession(token);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', { preHandler: auth }, async (req) => req.staff);

  // Своя карточка: личные данные и реквизиты выплат
  app.get('/profile', { preHandler: auth }, async (req) => {
    const r = await db.query(`SELECT ${STAFF_CARD_COLS} FROM staff WHERE id = $1`, [req.staff!.id]);
    return { ...r.rows[0], payout_methods: PAYOUT_METHODS };
  });
  app.patch('/profile', { preHandler: auth }, async (req, reply) => {
    const f = cardFields((req.body ?? {}) as Record<string, unknown>);
    if ('error' in f) return reply.code(400).send({ error: f.error });
    const keys = Object.keys(f.cols);
    if (!keys.length) return { ok: true };
    await db.query(`UPDATE staff SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [req.staff!.id, ...keys.map((k) => f.cols[k])]);
    return { ok: true };
  });
  // Смена своего пароля: нужен текущий
  app.post('/profile/password', { preHandler: auth }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const cur = typeof b.current_password === 'string' ? b.current_password : '';
    const next = typeof b.new_password === 'string' ? b.new_password : '';
    if (next.length < 8) return reply.code(400).send({ error: 'Новый пароль не короче 8 символов' });
    const row = (await db.query('SELECT password_hash FROM staff WHERE id = $1', [req.staff!.id])).rows[0];
    if (!row || !(await verifyPassword(cur, row.password_hash))) return reply.code(403).send({ error: 'Текущий пароль неверный' });
    await db.query('UPDATE staff SET password_hash = $2 WHERE id = $1', [req.staff!.id, await hashPassword(next)]);
    return { ok: true };
  });
  // 2FA: статус, настройка (секрет + QR), включение по первому коду, отключение, сброс админом
  app.get('/profile/2fa', { preHandler: auth }, async (req) => {
    const r = (await db.query('SELECT totp_secret IS NOT NULL AS on, cardinality(recovery_codes) AS left FROM staff WHERE id = $1', [req.staff!.id])).rows[0];
    return { enabled: r.on, recovery_left: r.left, required: TOTP_REQUIRED.includes(req.staff!.role) };
  });
  app.post('/profile/2fa/setup', { preHandler: auth }, async (req, reply) => {
    if (req.staff!.totp) return reply.code(400).send({ error: 'Двухфакторная защита уже включена' });
    const secret = newSecret();
    await db.query('UPDATE staff SET totp_pending = $2 WHERE id = $1', [req.staff!.id, secret]);
    const uri = otpUri(secret, req.staff!.login);
    return { secret, uri, qr: await QRCode.toString(uri, { type: 'svg', margin: 1, width: 200 }) };
  });
  app.post('/profile/2fa/enable', { preHandler: auth }, async (req, reply) => {
    const code = str(((req.body ?? {}) as Record<string, unknown>).code, 20);
    const st = (await db.query('SELECT totp_pending FROM staff WHERE id = $1', [req.staff!.id])).rows[0];
    if (!st?.totp_pending) return reply.code(400).send({ error: 'Начните настройку заново' });
    const step = verifyTotp(st.totp_pending, code);
    if (step === null) return reply.code(400).send({ error: 'Неверный код. Проверьте время на телефоне и попробуйте ещё раз.' });
    const codes = newRecoveryCodes();
    await db.query(
      `UPDATE staff SET totp_secret = totp_pending, totp_pending = NULL, totp_last = $2, recovery_codes = $3 WHERE id = $1`,
      [req.staff!.id, step, codes.map((c) => sha256(c.replace('-', '')))],
    );
    return { ok: true, recovery_codes: codes };
  });
  app.post('/profile/2fa/disable', { preHandler: auth }, async (req, reply) => {
    if (TOTP_REQUIRED.includes(req.staff!.role)) return reply.code(403).send({ error: 'Для вашей роли двухфакторная защита обязательна' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const st = (await db.query('SELECT password_hash, totp_secret FROM staff WHERE id = $1', [req.staff!.id])).rows[0];
    const pw = typeof b.password === 'string' ? b.password : '';
    if (!st?.totp_secret || !(await verifyPassword(pw, st.password_hash))) return reply.code(403).send({ error: 'Неверный пароль' });
    if (verifyTotp(st.totp_secret, str(b.code, 20)) === null) return reply.code(403).send({ error: 'Неверный код' });
    await db.query(`UPDATE staff SET totp_secret = NULL, totp_pending = NULL, recovery_codes = '{}', totp_last = 0 WHERE id = $1`, [req.staff!.id]);
    return { ok: true };
  });
  // Админ выдаёт сотруднику новый случайный пароль (виден один раз в ответе; в базе остаётся только хэш)
  app.post<{ Params: { id: string } }>('/staff/:id/password/generate', { preHandler: need('admin') }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Неверный id' });
    if (id === req.staff!.id) return reply.code(400).send({ error: 'Свой пароль меняйте в карточке: нужен текущий' });
    const ABC = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const password = Array.from({ length: 12 }, () => ABC[randomInt(ABC.length)]).join('');
    const r = await db.query('UPDATE staff SET password_hash = $2 WHERE id = $1', [id, await hashPassword(password)]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Сотрудник не найден' });
    await db.query('DELETE FROM sessions WHERE staff_id = $1', [id]);
    return { password };
  });
  // Админ сбрасывает 2FA сотруднику, потерявшему телефон: тот при входе настроит её заново
  app.post<{ Params: { id: string } }>('/staff/:id/2fa/reset', { preHandler: need('admin') }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Неверный id' });
    if (id === req.staff!.id) return reply.code(400).send({ error: 'Свою 2FA админ сбрасывает через сервер' });
    await db.query(`UPDATE staff SET totp_secret = NULL, totp_pending = NULL, recovery_codes = '{}', totp_last = 0 WHERE id = $1`, [id]);
    await db.query('DELETE FROM sessions WHERE staff_id = $1', [id]);
    return { ok: true };
  });
  // Карточка любого сотрудника для админа
  app.get<{ Params: { id: string } }>('/staff/:id/card', { preHandler: need('admin') }, async (req, reply) => {
    const r = await db.query(`SELECT ${STAFF_CARD_COLS} FROM staff WHERE id = $1`, [Number(req.params.id)]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Сотрудник не найден' });
    return { ...r.rows[0], payout_methods: PAYOUT_METHODS };
  });

  // Сводка для дашборда
  app.get<{ Querystring: { from?: string; to?: string } }>('/stats', { preHandler: auth }, async (req) => {
    const me = req.staff!;
    // Период (по Киеву): лиды, пришедшие за эти даты, клики и деньги за них. Без периода считаем всё время
    const D = /^\d{4}-\d{2}-\d{2}$/;
    let range: [string, string] | null = null;
    if (D.test(String(req.query.from)) && D.test(String(req.query.to))) {
      range = String(req.query.from) <= String(req.query.to) ? [String(req.query.from), String(req.query.to)] : [String(req.query.to), String(req.query.from)];
    }
    const TZ = 'Europe/Kyiv';
    const leads = await db.query(
      `SELECT status, count(*)::int AS n FROM leads WHERE lead_role = 'lead' AND ${ownerScope(me, 'owner_id')}
         ${range ? `AND (created_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date` : ''} GROUP BY status`,
      (range ?? []) as string[],
    );
    const clicks = range
      ? await db.query(
          `SELECT count(*)::int AS n FROM link_clicks c JOIN links l ON l.id = c.link_id
            WHERE ${ownerScope(me, 'l.owner_id')} AND (c.at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date`,
          range,
        )
      : await db.query(`SELECT coalesce(sum(clicks),0)::int AS n FROM links WHERE ${ownerScope(me, 'owner_id')}`);
    const money = await db.query(
      `SELECT e.type, coalesce(sum(e.amount),0)::float AS s
         FROM events e JOIN leads d ON d.tg_id = e.tg_id
        WHERE e.type IN ('ftd','dep','wd','comm') AND d.lead_role = 'lead' AND ${ownerScope(me, 'd.owner_id')}
          ${range ? `AND (e.created_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date` : ''} GROUP BY e.type`,
      (range ?? []) as string[],
    );
    const m: Record<string, number> = {};
    for (const x of money.rows) m[x.type] = x.s;
    const by: Record<string, number> = {};
    for (const x of leads.rows) by[x.status] = x.n;
    return {
      byStatus: by,
      total: Object.values(by).reduce((a, b) => a + b, 0),
      clicks: clicks.rows[0].n,
      // Стример видит только первые депозиты (без додепов и выводов)
      deposits: (m.ftd ?? 0) + (me.role === 'streamer' ? 0 : (m.dep ?? 0)),
      withdrawals: me.role === 'streamer' ? 0 : (m.wd ?? 0),
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
              po_campaign, po_promo, po_link, po_link_ru, tg_username
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
      const p = await db.query(`SELECT 1 FROM staff WHERE id = $1 AND role IN ('teamlead','admin')`, [parentId]);
      if (!p.rowCount) return reply.code(400).send({ error: 'Тимлидер: админ или тимлидер' });
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
    if (b.parent_id !== undefined) {
      const pid = b.parent_id ? Number(b.parent_id) : null;
      if (pid !== null) {
        if (pid === id) return reply.code(400).send({ error: 'Нельзя назначить сотрудника самому себе' });
        const t = await db.query(`SELECT 1 FROM staff WHERE id = $1 AND role IN ('teamlead','admin')`, [pid]);
        if (!t.rowCount) return reply.code(400).send({ error: 'Тимлидер не найден' });
      }
      add('parent_id', pid);
    }
    const link = (v: unknown): string | null | undefined => {
      if (v === undefined) return undefined;
      const t = str(v, 600);
      if (!t) return null;
      return /^https:\/\/[^\s]+$/.test(t) ? t : undefined;
    };
    const cf = cardFields(b);
    if ('error' in cf) return reply.code(400).send({ error: cf.error });
    for (const [k, v] of Object.entries(cf.cols)) add(k, v);
    if (b.tg_username !== undefined) {
      const u = str(b.tg_username, 40).replace(/^@/, '');
      if (u && !/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(u)) return reply.code(400).send({ error: 'Telegram: юзернейм без ссылки, например daria_manager' });
      add('tg_username', u || null);
    }
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
    const DT = depTypes(me);
    const r = await db.query(
      `SELECT l.id, l.slug, l.source, l.campaign, l.clicks, l.created_at, s.name AS owner_name, l.owner_id,
              (SELECT count(*)::int FROM leads d WHERE d.link_id = l.id AND d.lead_role = 'lead') AS starts,
              (SELECT count(*)::int FROM leads d WHERE d.link_id = l.id AND d.lead_role = 'lead'
                 AND EXISTS (SELECT 1 FROM events e WHERE e.tg_id = d.tg_id AND e.type = 'reg')) AS regs,
              (SELECT count(*)::int FROM leads d WHERE d.link_id = l.id AND d.lead_role = 'lead' AND d.status IN ('ftd','active')) AS ftds,
              coalesce((SELECT sum(e.amount) FROM events e JOIN leads d ON d.tg_id = e.tg_id
                 WHERE d.link_id = l.id AND d.lead_role = 'lead' AND e.type IN ${DT}),0)::float AS deposits,
              coalesce((SELECT sum(e.amount) FROM events e JOIN leads d ON d.tg_id = e.tg_id
                 WHERE d.link_id = l.id AND d.lead_role = 'lead' AND e.type = 'comm' AND ${me.role === 'streamer' ? 'false' : 'true'}),0)::float AS commission
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
    const DT = depTypes(me);
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
              coalesce(sum((SELECT sum(e.amount) FROM events e WHERE e.tg_id = d.tg_id AND e.type IN ${DT})),0)::float AS deposits,
              coalesce(sum((SELECT sum(e.amount) FROM events e WHERE e.tg_id = d.tg_id AND e.type = 'comm' AND ${me.role === 'streamer' ? 'false' : 'true'})),0)::float AS commission
         FROM links l JOIN leads d ON d.link_id = l.id
        WHERE d.lead_role = 'lead' AND ${ownerScope(me, 'l.owner_id')} GROUP BY 1`,
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

  // Ссылки выдаёт только админ (в разделе «Сотрудники»)
  app.post('/links', { preHandler: need('admin') }, async (req, reply) => {
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
        WHERE ${chatScope(me, 'd.owner_id')} AND (d.chat_closed_at IS NULL OR m.created_at > d.chat_closed_at)
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
      `SELECT m.id, m.direction, m.kind, m.text, m.created_at, (m.file_id IS NOT NULL) AS has_file, m.file_name, s.name AS staff_name
         FROM messages m LEFT JOIN staff s ON s.id = m.staff_id WHERE m.tg_id = $1 ORDER BY m.id DESC LIMIT 200`,
      [tgId],
    );
    return { lead: lead.rows[0], messages: msgs.rows.reverse() };
  });

  // Админ закрывает чат (скрывается, пока клиент не напишет) или очищает переписку совсем
  app.post<{ Params: { tgId: string } }>('/chats/:tgId/close', { preHandler: need('admin') }, async (req, reply) => {
    const r = await db.query('UPDATE leads SET chat_closed_at = now() WHERE tg_id = $1', [Number(req.params.tgId)]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Чат не найден' });
    return { ok: true };
  });
  app.delete<{ Params: { tgId: string } }>('/chats/:tgId', { preHandler: need('admin') }, async (req, reply) => {
    const tgId = Number(req.params.tgId);
    if (!Number.isSafeInteger(tgId)) return reply.code(400).send({ error: 'Неверный ID' });
    const r = await db.query('DELETE FROM messages WHERE tg_id = $1', [tgId]);
    await db.query('UPDATE leads SET chat_closed_at = NULL WHERE tg_id = $1', [tgId]);
    return { ok: true, deleted: r.rowCount };
  });

  app.get<{ Params: { tgId: string; msgId: string } }>('/chats/:tgId/file/:msgId', { preHandler: auth }, async (req, reply) => {
    const me = req.staff!;
    const r = await db.query(
      `SELECT m.file_id, m.kind, m.file_name FROM messages m JOIN leads d ON d.tg_id = m.tg_id
        WHERE m.id = $1 AND m.tg_id = $2 AND m.file_id IS NOT NULL AND ${chatScope(me, 'd.owner_id')}`,
      [Number(req.params.msgId), Number(req.params.tgId)],
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'Файл не найден' });
    try {
      const f = await bot.api.getFile(r.rows[0].file_id);
      const resp = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${f.file_path}`);
      if (!resp.ok) throw new Error('telegram');
      const ext = (f.file_path ?? '').split('.').pop()?.toLowerCase() ?? '';
      const types: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
        mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
        ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', flac: 'audio/flac',
        pdf: 'application/pdf',
      };
      const buf = Buffer.from(await resp.arrayBuffer());
      const type = types[ext] ?? 'application/octet-stream';
      const inline = type !== 'application/octet-stream';
      reply
        .header('Cache-Control', 'private, max-age=3600')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Accept-Ranges', 'bytes')
        .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(r.rows[0].file_name || 'file.' + (ext || 'bin'))}`)
        .type(type);
      // Safari и перемотка видео просят Range
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (m && (m[1] || m[2])) {
        const start = m[1] ? Number(m[1]) : Math.max(0, buf.length - Number(m[2]));
        const end = m[1] && m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
        if (start > end || start >= buf.length) return reply.code(416).header('Content-Range', `bytes */${buf.length}`).send();
        return reply.code(206).header('Content-Range', `bytes ${start}-${end}/${buf.length}`).send(buf.subarray(start, end + 1));
      }
      return reply.send(buf);
    } catch {
      return reply.code(502).send({ error: 'Не удалось получить файл из Telegram' });
    }
  });

  // Закрепление клиента за тем, кто ответил первым (админ клиентов не забирает). Возвращает текст ошибки или null
  async function claimLead(me: Staff, tgId: number, ownerId: number | null): Promise<string | null> {
    if (ownerId === null && (me.role === 'streamer' || me.role === 'teamlead')) {
      const claim = await db.query('UPDATE leads SET owner_id = $2 WHERE tg_id = $1 AND owner_id IS NULL RETURNING tg_id', [tgId, me.id]);
      if (!claim.rowCount) {
        const o = await db.query('SELECT o.id, o.name FROM leads d JOIN staff o ON o.id = d.owner_id WHERE d.tg_id = $1', [tgId]);
        if (o.rows[0]?.id !== me.id) return `Этого клиента уже взял ${o.rows[0]?.name ?? 'другой стример'}`;
      }
    }
    return null;
  }

  // Любой файл клиенту: тело запроса это сам файл, остальное в заголовках и адресе (kind=auto|voice|video_note, caption)
  const FILE_LIMIT = 50 * 1024 * 1024; // предел Bot API на отправку
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: FILE_LIMIT + 1024 }, (_req, body, done) => done(null, body));
  app.post<{ Params: { tgId: string }; Querystring: { kind?: string; caption?: string } }>(
    '/chats/:tgId/send-file',
    { preHandler: auth, bodyLimit: FILE_LIMIT + 1024 },
    async (req, reply) => {
      const me = req.staff!;
      const tgId = Number(req.params.tgId);
      let file = Buffer.isBuffer(req.body) ? (req.body as Buffer) : null;
      if (!file || !file.length) return reply.code(400).send({ error: 'Файл пустой' });
      if (file.length > FILE_LIMIT) return reply.code(413).send({ error: 'Файл больше 50 МБ: это предел Telegram для ботов' });
      const decode = (v: unknown) => {
        try {
          return decodeURIComponent(String(v ?? ''));
        } catch {
          return '';
        }
      };
      let name = decode(req.headers['x-file-name']).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'file';
      const mime = decode(req.headers['x-file-type']).toLowerCase().split(';')[0].trim();
      const reqKind = str(req.query.kind, 12);
      const caption = str(req.query.caption, 1024);
      const lead = await db.query(`SELECT d.owner_id FROM leads d WHERE d.tg_id = $1 AND ${chatScope(me, 'd.owner_id')}`, [tgId]);
      if (!lead.rowCount) return reply.code(404).send({ error: 'Чат не найден' });
      const claimErr = await claimLead(me, tgId, lead.rows[0].owner_id);
      if (claimErr) return reply.code(409).send({ error: claimErr });

      const ext = (name.split('.').pop() ?? '').toLowerCase();
      const isImg = /^image\/(jpeg|png|webp)$/.test(mime) && ((file[0] === 0xff && file[1] === 0xd8) || file.subarray(1, 4).toString() === 'PNG' || (file.subarray(0, 4).toString() === 'RIFF' && file.subarray(8, 12).toString() === 'WEBP'));
      type Plan = { kind: string; send: () => Promise<{ id: number; fileId: string | null }> };
      let plan: Plan;
      try {
        if (reqKind === 'voice') {
          file = await toVoice(file);
          name = 'voice.ogg';
          plan = { kind: 'voice', send: async () => { const m = await bot.api.sendVoice(tgId, new InputFile(file!, name), caption ? { caption } : {}); return { id: m.message_id, fileId: m.voice.file_id }; } };
        } else if (reqKind === 'video_note') {
          file = await toVideoNote(file);
          name = 'circle.mp4';
          plan = { kind: 'video_note', send: async () => { const m = await bot.api.sendVideoNote(tgId, new InputFile(file!, name)); return { id: m.message_id, fileId: m.video_note.file_id }; } };
        } else if (isImg && file.length <= 10 * 1024 * 1024) {
          plan = { kind: 'photo', send: async () => { const m = await bot.api.sendPhoto(tgId, new InputFile(file!, name), caption ? { caption } : {}); return { id: m.message_id, fileId: m.photo[m.photo.length - 1]?.file_id ?? null }; } };
        } else if (mime === 'image/gif' || ext === 'gif') {
          plan = { kind: 'animation', send: async () => { const m = await bot.api.sendAnimation(tgId, new InputFile(file!, name), caption ? { caption } : {}); return { id: m.message_id, fileId: m.animation.file_id }; } };
        } else if (/^video\/(mp4|quicktime|x-m4v)$/.test(mime) || ['mp4', 'mov', 'm4v'].includes(ext)) {
          plan = { kind: 'video', send: async () => { const m = await bot.api.sendVideo(tgId, new InputFile(file!, name), { ...(caption ? { caption } : {}), supports_streaming: true }); return { id: m.message_id, fileId: m.video.file_id }; } };
        } else if (/^audio\/(mpeg|mp3|mp4|x-m4a|m4a)$/.test(mime) || ['mp3', 'm4a'].includes(ext)) {
          plan = { kind: 'audio', send: async () => { const m = await bot.api.sendAudio(tgId, new InputFile(file!, name), caption ? { caption } : {}); return { id: m.message_id, fileId: m.audio.file_id }; } };
        } else {
          plan = { kind: 'document', send: async () => { const m = await bot.api.sendDocument(tgId, new InputFile(file!, name), caption ? { caption } : {}); return { id: m.message_id, fileId: m.document.file_id }; } };
        }
      } catch (e) {
        req.log.warn({ err: String(e) }, 'chat: не удалось обработать запись');
        return reply.code(422).send({ error: 'Не удалось обработать запись. Попробуйте записать ещё раз.' });
      }
      let tgMessageId: number | null = null;
      let fileId: string | null = null;
      if (!config.disableBot) {
        try {
          const r = await plan.send();
          tgMessageId = r.id;
          fileId = r.fileId;
        } catch {
          return reply.code(502).send({ error: 'Telegram не принял файл. Возможно, клиент заблокировал бота или формат не подходит.' });
        }
      }
      await db.query(
        `INSERT INTO messages (tg_id, direction, staff_id, kind, text, file_id, tg_message_id, file_name) VALUES ($1,'out',$2,$3,$4,$5,$6,$7)`,
        [tgId, me.id, plan.kind, caption || null, fileId, tgMessageId, plan.kind === 'document' || plan.kind === 'audio' ? name : null],
      );
      return { ok: true };
    },
  );

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
    const claimErr = await claimLead(me, tgId, lead.rows[0].owner_id);
    if (claimErr) return reply.code(409).send({ error: claimErr });

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
      const extra: Partial<Button> = {};
      if (['primary', 'success', 'danger'].includes(str(b.style, 10))) extra.style = str(b.style, 10) as Button['style'];
      if (b.inline === true) extra.inline = true;
      if (type === 'url') {
        const url = str(b.url, 400);
        if (!/^https:\/\/[^\s]+$/.test(url)) return 'Ссылка кнопки должна начинаться с https://';
        out.push({ label, type, url, ...extra });
      } else if (type === 'callback') {
        const data = str(b.data, 20);
        if (!['acc_no', 'acc_yes', 'acc_ready'].includes(data)) return 'Неизвестное действие кнопки';
        out.push({ label, type, data, ...extra });
      } else if (['miniapp', 'support', 'register'].includes(type)) out.push({ label, type: type as Button['type'], ...extra });
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
    return (await db.query('SELECT id, kind, title, subtitle, url, country, contact_url, staff_id, sort, active FROM media_items ORDER BY kind DESC, sort, id')).rows;
  });
  function cleanMedia(b: Record<string, unknown>) {
    const kind = str(b.kind, 10);
    const title = str(b.title, 80);
    const url = str(b.url, 300);
    if (!['trader', 'channel'].includes(kind)) return 'Неверный тип';
    if (!title) return 'Укажите название';
    if (!/^https:\/\/[^\s]+$/.test(url)) return 'Ссылка должна начинаться с https://';
    const country = str(b.country, 2).toUpperCase();
    if (country && !/^[A-Z]{2}$/.test(country)) return 'Неверная страна';
    const contact = str(b.contact_url, 300);
    if (contact && !/^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{3,31}\/?$/.test(contact)) return 'Личка: ссылка вида https://t.me/имя';
    const staffId = Number(b.staff_id);
    return { kind, title, url, subtitle: str(b.subtitle, 80) || null, country: country || null, contact_url: contact || null, staff_id: Number.isInteger(staffId) && staffId > 0 ? staffId : null, sort: Math.trunc(num(b.sort)) };
  }
  app.post('/media', { preHandler: need('admin') }, async (req, reply) => {
    const m = cleanMedia((req.body ?? {}) as Record<string, unknown>);
    if (typeof m === 'string') return reply.code(400).send({ error: m });
    const r = await db.query(
      'INSERT INTO media_items (kind, title, subtitle, url, sort, country, contact_url, staff_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [m.kind, m.title, m.subtitle, m.url, m.sort, m.country, m.contact_url, m.staff_id],
    );
    return { id: r.rows[0].id };
  });
  app.put<{ Params: { id: string } }>('/media/:id', { preHandler: need('admin') }, async (req, reply) => {
    const m = cleanMedia((req.body ?? {}) as Record<string, unknown>);
    if (typeof m === 'string') return reply.code(400).send({ error: m });
    const r = await db.query(
      'UPDATE media_items SET kind=$2, title=$3, subtitle=$4, url=$5, sort=$6, country=$7, contact_url=$8, staff_id=$9 WHERE id=$1',
      [Number(req.params.id), m.kind, m.title, m.subtitle, m.url, m.sort, m.country, m.contact_url, m.staff_id],
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'Запись не найдена' });
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/media/:id', { preHandler: need('admin') }, async (req) => {
    await db.query('DELETE FROM media_items WHERE id = $1', [Number(req.params.id)]);
    return { ok: true };
  });

  // Сигналы. Публикует человек. Случайный режим есть только для тестов и виден только тестовым аккаунтам
  const PAIR = /^[A-Za-z0-9]{2,8}\/[A-Za-z0-9]{2,8}( OTC)?$/;
  const EXPIRY = [1, 2, 3, 5, 10, 15];

  async function publishSignal(o: { pair: string; direction: 'up' | 'down'; expiry: number; enterIn: number; note: string | null; source: 'analyst' | 'test' | 'engine'; isTest: boolean; by: number; push: boolean }) {
    const entryAt = new Date(Date.now() + o.enterIn * 60_000);
    const ins = await db.query(
      `INSERT INTO signals (pair, direction, expiry_min, entry_at, note, source, is_test, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [o.pair, o.direction, o.expiry, entryAt, o.note, o.source, o.isTest, o.by],
    );
    let pushed = 0;
    if (o.push) {
      const text = `${o.isTest ? 'ТЕСТ. Не для торговли.\n' : ''}Новый сигнал: ${o.pair}, ${o.direction === 'up' ? 'вверх' : 'вниз'}, экспирация ${o.expiry} мин.\nВход в {время:${entryAt.getTime()}}. Откройте кабинет.`;
      const r = await createBroadcast({ text, buttons: [{ label: 'Открыть кабинет', type: 'miniapp' }], segment: o.isTest ? 'testers' : 'access', createdBy: o.by });
      pushed = r.total;
    }
    return { id: ins.rows[0].id, pushed };
  }

  app.get('/signals', { preHandler: need('admin', 'analyst') }, async () => {
    const r = await db.query(
      `SELECT s.id, s.pair, s.direction, s.expiry_min, s.expiry_sec, s.requested_by IS NOT NULL AS requested, s.entry_at, s.note, s.source, s.is_test, s.created_at, st.name AS author,
              CASE WHEN s.requested_by IS NOT NULL THEN coalesce(l.lead_role, 'lead')
                   ELSE CASE st.role WHEN 'teamlead' THEN 'moder' WHEN 'admin' THEN 'admin' WHEN 'streamer' THEN 'streamer' WHEN 'buyer' THEN 'buyer' ELSE 'analyst' END END AS source_role,
              (SELECT count(*)::int FROM deals x WHERE x.signal_id = s.id) AS taken,
              (SELECT count(*)::int FROM deals x WHERE x.signal_id = s.id AND x.result = 'win') AS wins,
              (SELECT count(*)::int FROM deals x WHERE x.signal_id = s.id AND x.result = 'loss') AS losses,
              (SELECT coalesce(json_object_agg(t.step + 1, t.c), '{}'::json) FROM (SELECT step, count(*)::int AS c FROM deals x WHERE x.signal_id = s.id AND x.result = 'win' AND x.step IS NOT NULL GROUP BY step) t) AS win_steps
         FROM signals s LEFT JOIN staff st ON st.id = s.created_by LEFT JOIN leads l ON l.tg_id = s.requested_by ORDER BY s.id DESC LIMIT 40`,
    );
    return r.rows;
  });

  // Очистка истории: удаляются сигналы, время входа которых уже наступило. Сделки клиентов остаются, у них просто пропадает привязка к сигналу
  app.delete('/signals', { preHandler: need('admin') }, async () => {
    await db.query('UPDATE deals SET signal_id = NULL WHERE signal_id IN (SELECT id FROM signals WHERE entry_at <= now())');
    const r = await db.query('DELETE FROM signals WHERE entry_at <= now()');
    return { ok: true, removed: r.rowCount };
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

  // Настройка сигналов по запросу клиента: общие параметры, пары и текущее направление по каждой паре
  const PAYOUT_MAX = 100;
  app.get('/signal-config', { preHandler: need('admin', 'analyst') }, async () => {
    const settings = (await db.query('SELECT * FROM signal_settings WHERE id = 1')).rows[0];
    const pairs = (
      await db.query(
        `SELECT p.pair, p.enabled, p.sort, p.auto, p.direction, p.direction_at, st.name AS direction_by,
                (p.direction IS NOT NULL AND p.direction_at > now() - ($1 || ' minutes')::interval) AS fresh
           FROM signal_pairs p LEFT JOIN staff st ON st.id = p.direction_by ORDER BY p.sort, p.pair`,
        [String(settings.direction_ttl_min)],
      )
    ).rows;
    const expiries = (await db.query('SELECT sec FROM signal_expiries ORDER BY sec')).rows.map((x) => x.sec);
    return { settings, pairs, expiries };
  });
  app.put('/signal-config', { preHandler: need('admin') }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const enterIn = Math.trunc(Number(b.enter_in_sec));
    const ttl = Math.trunc(Number(b.direction_ttl_min));
    const cooldown = Math.trunc(Number(b.cooldown_sec));
    if (!(enterIn >= 30 && enterIn <= 600)) return reply.code(400).send({ error: 'Время до входа: 30–600 секунд' });
    if (!(ttl >= 1 && ttl <= 240)) return reply.code(400).send({ error: 'Срок действия направления: 1–240 минут' });
    if (!(cooldown >= 0 && cooldown <= 3600)) return reply.code(400).send({ error: 'Пауза между запросами: 0–3600 секунд' });
    const entrySec = Math.trunc(Number(b.entry_second));
    const gap = Math.trunc(Number(b.overlap_gap_sec));
    const maxEv = Math.trunc(Number(b.max_events));
    const mult = Math.trunc(Number(b.overlap_mult));
    if (!(entrySec >= 0 && entrySec <= 59)) return reply.code(400).send({ error: 'Секунда входа: 0–59' });
    if (!(gap >= 10 && gap <= 300)) return reply.code(400).send({ error: 'Интервал между перекрытиями: 10–300 секунд' });
    if (!(maxEv >= 1 && maxEv <= 6)) return reply.code(400).send({ error: 'Событий всего: 1–6' });
    if (!(mult >= 1 && mult <= 5)) return reply.code(400).send({ error: 'Множитель суммы перекрытия: 1–5' });
    const pocket = str(b.pocket_url, 300);
    if (pocket && !/^https:\/\/[^\s]+$/.test(pocket)) return reply.code(400).send({ error: 'Ссылка Pocket Option должна начинаться с https://' });
    await db.query(
      `UPDATE signal_settings SET enabled=$1, enter_in_sec=$2, direction_ttl_min=$3, cooldown_sec=$4,
              entry_second=$5, overlap_gap_sec=$6, max_events=$7, overlap_mult=$8,
              entry_label=$9, stake_label=$10, warning_text=$11, pocket_url=$12 WHERE id = 1`,
      [Boolean(b.enabled), enterIn, ttl, cooldown, entrySec, gap, maxEv, mult,
        str(b.entry_label, 40), str(b.stake_label, 60), str(b.warning_text, 300), pocket],
    );
    return { ok: true };
  });
  // Загрузка списка пар разом: по строке на пару, после пары можно указать выплату («EUR/USD OTC 92»)
  app.post('/signal-pairs/bulk', { preHandler: need('admin') }, async (req, reply) => {
    const lines = str((req.body as any)?.text, 5000).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (!lines.length || lines.length > 100) return reply.code(400).send({ error: 'Вставьте от 1 до 100 строк' });
    const parsed: { pair: string; payout: number }[] = [];
    for (const line of lines) {
      // Выплату в строке (если вписали по привычке) игнорируем: клиент видит её у брокера
      const m = /^(.+?)(?:\s*[;,\t]\s*|\s+)(\d{1,3})\s*%?$/.exec(line);
      const pair = (m ? m[1] : line).trim().toUpperCase();
      const payout = 92;
      if (!PAIR.test(pair)) return reply.code(400).send({ error: `Не понял строку: ${line}` });
      parsed.push({ pair, payout });
    }
    for (const x of parsed) {
      await db.query(
        `INSERT INTO signal_pairs (pair, payout, sort) VALUES ($1,$2,(SELECT coalesce(max(sort),0)+1 FROM signal_pairs))
         ON CONFLICT (pair) DO UPDATE SET payout = EXCLUDED.payout`,
        [x.pair, x.payout],
      );
    }
    return { ok: true, count: parsed.length };
  });
  app.post('/signal-expiries', { preHandler: need('admin') }, async (req, reply) => {
    const sec = Math.trunc(Number((req.body as any)?.sec));
    if (!(sec >= 3 && sec <= 14400)) return reply.code(400).send({ error: 'Экспирация: от 3 секунд до 4 часов' });
    await db.query('INSERT INTO signal_expiries (sec) VALUES ($1) ON CONFLICT DO NOTHING', [sec]);
    return { ok: true };
  });
  app.delete('/signal-expiries', { preHandler: need('admin') }, async (req) => {
    await db.query('DELETE FROM signal_expiries WHERE sec = $1', [Math.trunc(Number((req.query as any)?.sec))]);
    return { ok: true };
  });
  app.post('/signal-pairs', { preHandler: need('admin') }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const pair = str(b.pair, 20).toUpperCase();
    if (!PAIR.test(pair)) return reply.code(400).send({ error: 'Пара в формате EUR/USD или EUR/USD OTC' });
    await db.query('INSERT INTO signal_pairs (pair, sort) VALUES ($1, (SELECT coalesce(max(sort),0)+1 FROM signal_pairs)) ON CONFLICT DO NOTHING', [pair]);
    return { ok: true };
  });
  app.put('/signal-pairs', { preHandler: need('admin') }, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const r = await db.query('UPDATE signal_pairs SET enabled=$2, sort=$3 WHERE pair=$1', [str(b.pair, 20), Boolean(b.enabled), Math.trunc(num(b.sort))]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Пара не найдена' });
    return { ok: true };
  });
  app.delete('/signal-pairs', { preHandler: need('admin') }, async (req) => {
    await db.query('DELETE FROM signal_pairs WHERE pair = $1', [str((req.query as any)?.pair, 20)]);
    return { ok: true };
  });
  // Аналитик ставит направление по паре (или сбрасывает). Клиент получит именно его, пока оно не устарело
  app.post('/signal-pairs/direction', { preHandler: need('admin', 'analyst') }, async (req, reply) => {
    const d = str((req.body as any)?.direction, 4);
    const pair = str((req.body as any)?.pair, 20);
    if (d && !['up', 'down', 'auto'].includes(d)) return reply.code(400).send({ error: 'Неверное направление' });
    const r = await db.query('UPDATE signal_pairs SET auto = coalesce($2::text = \'auto\', false), direction=CASE WHEN $2::text IN (\'up\',\'down\') THEN $2 END, direction_at=CASE WHEN $2::text IN (\'up\',\'down\') THEN now() END, direction_by=CASE WHEN $2::text IN (\'up\',\'down\') THEN $3::int END WHERE ($1 = \'*\' OR pair = $1)', [pair, d || null, req.staff!.id]); // pair = * — сразу все пары
    if (!r.rowCount) return reply.code(404).send({ error: 'Пара не найдена' });
    return { ok: true };
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

  // Пометить сигнал тестовым (или вернуть обычным): тестовые сигналы видят только тестовые аккаунты
  app.patch<{ Params: { id: string } }>('/signals/:id/test', { preHandler: need('admin') }, async (req, reply) => {
    const on = Boolean((req.body as any)?.is_test);
    const r = await db.query('UPDATE signals SET is_test = $2 WHERE id = $1 RETURNING id', [Number(req.params.id), on]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Сигнал не найден' });
    return { ok: true };
  });

  // Тестовая история для просмотра оформления блока «Прошедшие сигналы». Видят только тестовые аккаунты, везде помечена ТЕСТ
  app.post('/signals/demo-history', { preHandler: need('admin') }, async (req) => {
    const pairs = ['EUR/USD OTC', 'GBP/USD OTC', 'AUD/CHF OTC', 'EUR/GBP OTC', 'AUD/USD OTC', 'USD/JPY OTC'];
    const lossAt = randomInt(5);
    let at = Date.now() - 20 * 60_000;
    for (let i = 0; i < 5; i++) {
      at -= (10 + randomInt(80)) * 60_000;
      await db.query(
        `INSERT INTO signals (pair, direction, expiry_min, entry_at, note, source, is_test, demo_result, created_by) VALUES ($1,$2,1,$3,'Тестовая история. Это не результаты торговли.','test',TRUE,$4,$5)`,
        [pairs[randomInt(pairs.length)], randomInt(2) ? 'up' : 'down', new Date(at), i === lossAt ? 'loss' : 'win', req.staff!.id],
      );
    }
    return { ok: true };
  });

  app.delete('/signals/demo-history', { preHandler: need('admin') }, async () => {
    const r = await db.query(`DELETE FROM signals s WHERE s.demo_result IS NOT NULL AND NOT EXISTS (SELECT 1 FROM deals x WHERE x.signal_id = s.id)`);
    return { removed: r.rowCount };
  });

  app.patch<{ Params: { tgId: string } }>('/leads/:tgId/tester', { preHandler: need('admin') }, async (req, reply) => {
    const on = Boolean((req.body as any)?.value);
    const role = String((req.body as any)?.role ?? 'lead');
    if (on && !['lead', 'moder', 'admin', 'streamer', 'analyst', 'buyer'].includes(role)) return reply.code(400).send({ error: 'Неизвестная роль' });
    const r = await db.query('UPDATE leads SET is_tester = $2, lead_role = $3 WHERE tg_id = $1 RETURNING tg_id', [Number(req.params.tgId), on, on ? role : 'lead']);
    if (!r.rowCount) return reply.code(404).send({ error: 'Лид не найден' });
    return { ok: true };
  });

  // Список Pocket ID из старого бота: по одному в строке (или через запятую/пробел). Дубликаты пропускаются
  app.post('/legacy/bulk', { preHandler: need('admin') }, async (req, reply) => {
    const raw = String((req.body as any)?.text ?? '').slice(0, 200_000);
    const ids = [...new Set(raw.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
    const bad = ids.filter((x) => !/^[A-Za-z0-9_-]{1,40}$/.test(x));
    if (bad.length) return reply.code(400).send({ error: 'Неверный формат: ' + bad.slice(0, 3).join(', ') + (bad.length > 3 ? '…' : '') });
    if (!ids.length) return reply.code(400).send({ error: 'Список пуст' });
    const r = await db.query('INSERT INTO legacy_ids (trader_id) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING', [ids]);
    return { ok: true, added: r.rowCount, skipped: ids.length - (r.rowCount ?? 0) };
  });
  app.get('/legacy', { preHandler: need('admin') }, async () => {
    const r = await db.query('SELECT count(*)::int AS total, count(claimed_by)::int AS claimed FROM legacy_ids');
    return r.rows[0];
  });
  app.delete('/legacy', { preHandler: need('admin') }, async () => {
    const r = await db.query('DELETE FROM legacy_ids WHERE claimed_by IS NULL');
    return { ok: true, removed: r.rowCount };
  });

  // Pocket ID вручную: админ присваивает его лиду сам (пустое значение сбрасывает)
  app.patch<{ Params: { tgId: string } }>('/leads/:tgId/trader', { preHandler: need('admin') }, async (req, reply) => {
    const v = str((req.body as any)?.trader_id, 40);
    if (v && !/^[A-Za-z0-9_-]+$/.test(v)) return reply.code(400).send({ error: 'Pocket ID: только буквы, цифры, - и _' });
    const r = await db.query('UPDATE leads SET trader_id = $2 WHERE tg_id = $1 RETURNING tg_id', [Number(req.params.tgId), v || null]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Лид не найден' });
    return { ok: true };
  });

  // Очистка журнала. Лиды, события и деньги не затрагиваются
  app.delete('/postbacks', { preHandler: need('admin') }, async () => {
    const r = await db.query('DELETE FROM postback_log');
    return { ok: true, deleted: r.rowCount };
  });

  // Карточка лида: откуда пришёл, путь (старт, регистрация, депозиты) и суммы
  app.get<{ Params: { tgId: string } }>('/leads/:tgId', { preHandler: auth }, async (req, reply) => {
    const me = req.staff!;
    const tgId = Number(req.params.tgId);
    if (!Number.isSafeInteger(tgId)) return reply.code(400).send({ error: 'Неверный ID' });
    const r = await db.query(
      `SELECT d.tg_id, d.username, d.first_name, d.status, d.access, d.trader_id, d.is_tester, d.lead_role, d.region, d.tz,
              d.created_at, d.last_seen_at, d.bot_started, d.bot_blocked, d.owner_id,
              o.name AS owner_name, l.slug AS link_slug, l.source AS link_source, l.campaign AS link_campaign
         FROM leads d LEFT JOIN staff o ON o.id = d.owner_id LEFT JOIN links l ON l.id = d.link_id
        WHERE d.tg_id = $1 AND (${ownerScope(me, 'd.owner_id')} OR ${chatScope(me, 'd.owner_id')})`,
      [tgId],
    );
    if (!r.rowCount) return reply.code(404).send({ error: 'Лид не найден' });
    const ev = await db.query(
      `SELECT type, amount, created_at, raw->>'country' AS country, raw->>'promo' AS promo, raw->>'ac' AS ac
         FROM events WHERE tg_id = $1 AND type IN ('start','reg','ftd','dep','wd') ORDER BY created_at, id`,
      [tgId],
    );
    // Стример не видит додепы и выводы
    if (me.role === 'streamer') ev.rows = ev.rows.filter((e) => e.type !== 'dep' && e.type !== 'wd');
    const deposits = ev.rows.filter((e) => e.type === 'ftd' || e.type === 'dep');
    const sum = (rows: any[]) => rows.reduce((t, e) => t + Number(e.amount || 0), 0);
    const last = (k: 'country' | 'promo' | 'ac') => [...ev.rows].reverse().find((e) => e[k])?.[k] ?? null;
    return {
      lead: r.rows[0],
      country: last('country'),
      promo: last('promo'),
      ac: last('ac'),
      events: ev.rows,
      depositsTotal: sum(deposits),
      depositsCount: deposits.length,
      withdrawTotal: sum(ev.rows.filter((e) => e.type === 'wd')),
    };
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
    const DT = depTypes(me);
    const r = await db.query(
      `SELECT d.tg_id, d.trader_id, d.is_tester, d.lead_role, d.username, d.first_name, d.status, d.access, d.created_at, d.owner_id,
              s.name AS owner_name, l.slug AS link_slug,
              coalesce((SELECT sum(amount) FROM events e WHERE e.tg_id = d.tg_id AND e.type IN ${DT}),0) AS deposits,
              coalesce((SELECT sum(amount) FROM events e WHERE e.tg_id = d.tg_id AND e.type = 'comm' AND ${me.role === 'streamer' ? 'false' : 'true'}),0) AS commission
         FROM leads d
         LEFT JOIN staff s ON s.id = d.owner_id
         LEFT JOIN links l ON l.id = d.link_id
        WHERE ${ownerScope(me, 'd.owner_id')}${extra}
        ORDER BY d.created_at DESC LIMIT 300`,
      vals,
    );
    // Сотрудники в списке лидов: владелец и ссылка у них общие (создатель компании), деньги и результаты нулевые
    const main = (
      await db.query(
        `SELECT s.id, s.name, (SELECT slug FROM links WHERE owner_id = s.id ORDER BY id LIMIT 1) AS slug
           FROM staff s WHERE s.role = 'admin' ORDER BY (lower(s.login) = lower($1)) DESC, s.id LIMIT 1`,
        [config.adminLogin ?? ''],
      )
    ).rows[0];
    return r.rows.map((x) =>
      x.lead_role && x.lead_role !== 'lead' ? { ...x, deposits: 0, commission: 0, owner_id: main?.id ?? x.owner_id, owner_name: main?.name ?? x.owner_name, link_slug: main?.slug ?? x.link_slug } : x,
    );
  });

  await accountingRoutes(app, { need, str, num });
}
