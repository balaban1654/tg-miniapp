import Fastify from 'fastify';
import { config } from './config.js';
import { db } from './db.js';
import { bot, setupBotProfile } from './bot.js';
import cookie from '@fastify/cookie';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrate } from './migrate.js';
import { ensureAdmin } from './auth.js';
import { officeRoutes } from './office.js';
import { postbackRoutes } from './postback.js';
import { appRoutes } from './app.js';
import { seedDefaultRules, startScheduler } from './push.js';

const app = Fastify({ logger: true, trustProxy: true });
await app.register(cookie);

await migrate();
await ensureAdmin();
await seedDefaultRules();

// Интерфейс Hunter Office и его API
const officeHtml = readFileSync(resolve(process.cwd(), 'public/office.html'), 'utf8');
app.get('/office', async (_req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(officeHtml));
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

// Заглушка для корня домена, пока основного сайта нет
const siteHtml = readFileSync(resolve(process.cwd(), 'public/site.html'), 'utf8').replaceAll('{{BOT}}', config.botUsername);
app.get('/site', async (_req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'public, max-age=300').send(siteHtml));
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

// Ссылка стримера или медиабайера: считаем клик и отправляем в бота с параметром
app.get<{ Params: { kind: string; slug: string } }>('/:kind(s|b)/:slug', async (req, reply) => {
  const { kind, slug } = req.params;
  const r = await db.query('UPDATE links SET clicks = clicks + 1 WHERE slug = $1 RETURNING id', [slug]);
  if (!r.rowCount) return reply.code(404).send('Ссылка не найдена');
  return reply.redirect(302, `https://t.me/${config.botUsername}?start=${kind}_${encodeURIComponent(slug)}`);
});

await app.listen({ port: config.port, host: '0.0.0.0' });
if (process.env.DISABLE_BOT !== '1') {
  startScheduler();
  void setupBotProfile();
  bot
    .start({ onStart: (me) => app.log.info(`Бот @${me.username} запущен`) })
    .catch((e) => app.log.error(e, 'Бот не запустился. Проверьте BOT_TOKEN'));
}
