import Fastify from 'fastify';
import { config } from './config.js';
import { db } from './db.js';
import { bot } from './bot.js';

const app = Fastify({ logger: true });

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
bot.start({ onStart: (me) => app.log.info(`Бот @${me.username} запущен`) });
