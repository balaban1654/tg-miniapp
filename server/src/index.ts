import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { db } from './db.js';
import { bot, setupBotProfile } from './bot.js';
import cookie from '@fastify/cookie';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrate } from './migrate.js';
import { ensureAdmin } from './auth.js';
import { officeRoutes } from './office.js';
import { autoCloseMonth } from './accounting.js';
import { postbackRoutes } from './postback.js';
import { appRoutes } from './app.js';
import { seedDefaultRules, startScheduler } from './push.js';
import { seedTemplates } from './templates.js';
import { parseClick } from './clicks.js';
import { RESERVED_SLUGS, SITE_URL } from './reserved.js';

const app = Fastify({ logger: true, trustProxy: true });
await app.register(cookie);

await migrate();
await ensureAdmin();
await seedDefaultRules();
await seedTemplates();

// Интерфейс Hunter Office и его API
const officeHtml = readFileSync(resolve(process.cwd(), 'public/office.html'), 'utf8');
app.get('/crm', async (_req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(officeHtml));
// Установка Office как приложения (PWA): манифест и сервис-воркер
const manifest = JSON.stringify({
  name: 'Hunter Office',
  short_name: 'Office',
  description: 'Кабинет команды Hunter AI',
  lang: 'ru',
  id: '/crm',
  start_url: '/crm',
  scope: '/crm',
  display: 'standalone',
  orientation: 'any',
  background_color: '#0b0614',
  theme_color: '#0d0817',
  icons: [
    { src: '/img/office-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
    { src: '/img/office-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
});
app.get('/office.webmanifest', async (_req, reply) => reply.type('application/manifest+json; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(manifest));
const swJs = readFileSync(resolve(process.cwd(), 'public/office-sw.js'), 'utf8');
app.get('/office-sw.js', async (_req, reply) => reply.type('text/javascript; charset=utf-8').header('Cache-Control', 'no-cache').send(swJs));
await app.register(officeRoutes, { prefix: '/api/office' });
await app.register(postbackRoutes);

// Шрифт Montserrat отдаём со своего сервера, чтобы он не зависел от Google
const fontsDir = resolve(process.cwd(), 'public/fonts');
const fonts = new Map(readdirSync(fontsDir).filter((f) => f.endsWith('.woff2')).map((f) => [f, readFileSync(resolve(fontsDir, f))]));
app.get<{ Params: { name: string } }>('/fonts/:name', async (req, reply) => {
  const f = fonts.get(req.params.name);
  if (!f) return reply.code(404).send('Не найдено');
  return reply.type('font/woff2').header('Cache-Control', 'public, max-age=31536000, immutable').send(f);
});

// Картинки сайта (логотип), только из белого списка
const imgDir = resolve(process.cwd(), 'public/img');
const imgs = new Map(readdirSync(imgDir).map((f) => [f, readFileSync(resolve(imgDir, f))]));
app.get<{ Params: { name: string } }>('/img/:name', async (req, reply) => {
  const f = imgs.get(req.params.name);
  if (!f) return reply.code(404).send('Не найдено');
  return reply.type(req.params.name.endsWith('.png') ? 'image/png' : 'image/webp').header('Cache-Control', 'public, max-age=86400').send(f);
});

// Браузеры сами просят /favicon.ico на любой странице и на любом поддомене: отдаём ту же круглую иконку
app.get('/favicon.ico', async (_req, reply) => reply.type('image/png').header('Cache-Control', 'public, max-age=86400').send(imgs.get('favicon.png')));

// Заглушка для корня домена, пока основного сайта нет
const siteHtml = readFileSync(resolve(process.cwd(), 'public/site.html'), 'utf8').replaceAll('{{BOT}}', config.botUsername);
app.get('/site', async (_req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'public, max-age=60').send(siteHtml));
const termsHtml = readFileSync(resolve(process.cwd(), 'public/terms.html'), 'utf8');
app.get('/terms', async (_req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'public, max-age=300').send(termsHtml));

// Клиентский Mini App
const appHtml = readFileSync(resolve(process.cwd(), 'public/app.html'), 'utf8');
app.get('/app', async (_req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(appHtml));
await app.register(appRoutes, { prefix: '/api/app' });

app.get('/health', async () => {
  await db.query('SELECT 1');
  return { ok: true };
});

// Ссылки: hunterai.space/liza и hunterai.space/liza/<код>. Считаем клик и отправляем в бота с параметром.
// Прежние формы (/s/liza, /b/liza, go.hunterai.space) больше не работают. Неизвестный адрес ведёт на заглушку сайта
async function goLink(req: FastifyRequest, reply: FastifyReply, slug: string, token?: string) {
  if (/^(go|api|crm|app)\./i.test(req.hostname)) return reply.redirect(302, SITE_URL + '/');
  const key = token ? `${slug}/${token}` : slug;
  const r = await db.query(
    `UPDATE links l SET clicks = clicks + 1 FROM staff o WHERE l.slug = $1 AND o.id = l.owner_id RETURNING l.id, l.token, o.role AS owner_role`,
    [key],
  );
  if (!r.rowCount) return reply.redirect(302, SITE_URL + '/');
  const row = r.rows[0];
  // Журнал кликов для дашборда по периодам. Ошибка журнала не должна ломать переход
  const ci = parseClick(req.headers);
  void db.query('INSERT INTO link_clicks (link_id, country, city, device, os, browser, referrer) VALUES ($1,$2,$3,$4,$5,$6,$7)', [row.id, ci.country, ci.city, ci.device, ci.os, ci.browser, ci.referrer]).catch(() => {});
  const kind = row.owner_role === 'buyer' ? 'b' : 's';
  // В параметре старта у случайной ссылки её код: слэш Telegram не допускает
  return reply.redirect(302, `https://t.me/${config.botUsername}?start=${kind}_${encodeURIComponent(row.token ?? slug)}`);
}
const SEG = '^[a-z0-9][a-z0-9_-]{1,39}$';
const TOK = '^[a-z0-9_-]{2,40}$';
app.get<{ Params: { a: string } }>(`/:a(${SEG})`, async (req, reply) => {
  if (RESERVED_SLUGS.has(req.params.a)) return reply.redirect(302, SITE_URL + '/');
  return goLink(req, reply, req.params.a);
});
app.get<{ Params: { a: string; b: string } }>(`/:a(${SEG})/:b(${TOK})`, async (req, reply) => {
  const { a, b } = req.params;
  if (RESERVED_SLUGS.has(a)) return reply.code(404).send({ error: 'Не найдено' });
  return goLink(req, reply, a, b);
});

await app.listen({ port: config.port, host: '0.0.0.0' });
// Автозакрытие прошлого месяца: проверяем каждые 10 минут, закрывает после 03:00 первого числа
const closeTick = () => void autoCloseMonth().then((p) => p && app.log.info(`Месяц ${p} закрыт автоматически`)).catch((e) => app.log.error(e, 'Ошибка автозакрытия месяца'));
setInterval(closeTick, 10 * 60_000);
setTimeout(closeTick, 30_000);
if (process.env.DISABLE_BOT !== '1') {
  startScheduler();
  void setupBotProfile();
  bot
    .start({ onStart: (me) => app.log.info(`Бот @${me.username} запущен`) })
    .catch((e) => app.log.error(e, 'Бот не запустился. Проверьте BOT_TOKEN'));
}
