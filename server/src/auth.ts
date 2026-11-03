import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db.js';
import { config } from './config.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type Role = 'admin' | 'teamlead' | 'streamer' | 'buyer' | 'analyst';

export interface Staff {
  id: number;
  login: string;
  name: string;
  role: Role;
  parent_id: number | null;
  totp: boolean;
  streams: boolean;
  nav_layout: unknown;
}

/** Роли, которым 2FA обязательна: без неё доступны только настройка 2FA и выход */
export const TOTP_REQUIRED: Role[] = ['admin', 'teamlead'];

export const COOKIE = 'hunter_session';
const SESSION_DAYS = 14;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createSession(staffId: number): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO sessions (token_hash, staff_id, expires_at) VALUES ($1,$2, now() + ($3 || ' days')::interval)`,
    [sha(token), staffId, String(SESSION_DAYS)],
  );
  return token;
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(COOKIE, token, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 3600,
  });
}

// ----- Доверенное устройство («Запомнить меня»): после выхода вход по одному коду 2FA -----
export const DEVICE_COOKIE = 'hunter_device';
const DEVICE_DAYS = 30;
const deviceFp = (passwordHash: string, totpSecret: string) => sha(`${passwordHash}|${totpSecret}`);

export async function rememberDevice(reply: FastifyReply, staffId: number): Promise<void> {
  const st = (await db.query('SELECT password_hash, totp_secret FROM staff WHERE id = $1', [staffId])).rows[0];
  if (!st?.totp_secret) return; // без 2FA вход «по коду» невозможен: запоминаем только логин (в браузере)
  const token = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO trusted_devices (token_hash, staff_id, fp, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' days')::interval)`,
    [sha(token), staffId, deviceFp(st.password_hash, st.totp_secret), String(DEVICE_DAYS)]);
  await db.query('DELETE FROM trusted_devices WHERE expires_at < now()');
  reply.setCookie(DEVICE_COOKIE, token, { httpOnly: true, secure: config.secureCookies, sameSite: 'strict', path: '/api/office', maxAge: DEVICE_DAYS * 24 * 3600 });
}

/** Сотрудник запомненного устройства, если ключ действует, пароль и 2FA не менялись и учётка активна */
export async function deviceStaff(token: string | undefined): Promise<{ id: number; login: string; name: string; role: Role; totp_secret: string } | null> {
  if (!token) return null;
  const r = (await db.query(
    `SELECT s.id, s.login, s.name, s.role, s.password_hash, s.totp_secret, d.fp FROM trusted_devices d JOIN staff s ON s.id = d.staff_id
      WHERE d.token_hash = $1 AND d.expires_at > now() AND s.active AND s.deleted_at IS NULL`, [sha(token)])).rows[0];
  if (!r || !r.totp_secret || r.fp !== deviceFp(r.password_hash, r.totp_secret)) return null;
  return { id: r.id, login: r.login, name: r.name, role: r.role, totp_secret: r.totp_secret };
}

export async function forgetDevice(reply: FastifyReply, token: string | undefined): Promise<void> {
  if (token) await db.query('DELETE FROM trusted_devices WHERE token_hash = $1', [sha(token)]);
  reply.clearCookie(DEVICE_COOKIE, { path: '/api/office' });
}

export async function destroySession(token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]);
}

export async function staffFromRequest(req: FastifyRequest): Promise<Staff | null> {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  const r = await db.query(
    `SELECT s.id, s.login, s.name, s.role, s.parent_id, (s.totp_secret IS NOT NULL) AS totp, s.streams, s.nav_layout
       FROM sessions x JOIN staff s ON s.id = x.staff_id
      WHERE x.token_hash = $1 AND x.expires_at > now() AND s.active`,
    [sha(token)],
  );
  return r.rows[0] ?? null;
}

/** Простой ограничитель попыток входа: 10 неудач за 15 минут на пару ip+login. */
const fails = new Map<string, number[]>();
const WINDOW = 15 * 60_000;
export function loginBlocked(key: string): boolean {
  const now = Date.now();
  const list = (fails.get(key) ?? []).filter((t) => now - t < WINDOW);
  fails.set(key, list);
  return list.length >= 10;
}
export function loginFailed(key: string): void {
  fails.set(key, [...(fails.get(key) ?? []), Date.now()]);
}
export function loginOk(key: string): void {
  fails.delete(key);
}

export async function ensureAdmin(): Promise<void> {
  // Имя по умолчанию «Администратор» заменяем на «Николай»: меняется один раз, дальше имя можно править как угодно
  if (config.adminLogin) await db.query(`UPDATE staff SET name = 'Николай' WHERE role = 'admin' AND login = $1 AND name = 'Администратор'`, [config.adminLogin]);
  if (!config.adminLogin || !config.adminPassword) return;
  const r = await db.query(`SELECT 1 FROM staff WHERE role = 'admin' LIMIT 1`);
  if (r.rowCount) return;
  await db.query(
    `INSERT INTO staff (login, password_hash, name, role) VALUES ($1,$2,'Николай','admin')`,
    [config.adminLogin, await hashPassword(config.adminPassword)],
  );
}
