import Fastify from 'fastify';
import { config } from './config.js';
import { db } from './db.js';
import { bot } from './bot.js';
import cookie from '@fastify/cookie';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrate } from './migrate.js';
import { ensureAdmin } from './auth.js';
import { officeRoutes } from './office.js';
import { postbackRoutes } from './postback.js';

const app = Fastify({ logger: true, trustProxy: true });
await app.register(cookie);

await migrate();
await ensureAdmin();

// Интерфейс Hunter Office и его API
const officeHtml = readFileSync(resolve(process.cwd(), 'public/office.html'), 'utf8');
app.get('/office', async (_req, reply) => reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(officeHtml));
await app.register(officeRoutes, { prefix: '/api/office' });
await app.register(postbackRoutes);

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
  bot
    .start({ onStart: (me) => app.log.info(`Бот @${me.username} запущен`) })
    .catch((e) => app.log.error(e, 'Бот не запустился. Проверьте BOT_TOKEN'));
}
