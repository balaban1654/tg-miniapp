import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { attachLead } from './db.js';
import { recordIncoming } from './chat.js';

export const bot = new Bot(config.botToken);

/** Из параметра /start вида "s_ivan" берём slug "ivan". */
export function parseStartPayload(payload: string): string | null {
  const m = /^[sb]_([a-zA-Z0-9_-]{1,64})$/.exec(payload.trim());
  return m ? m[1] : null;
}

bot.command('start', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  const payload = (ctx.match ?? '').trim();
  const slug = parseStartPayload(payload);
  const { lead } = await attachLead(from.id, from.username, from.first_name, slug);

  // Кнопка «Поддержка» в Mini App ведёт сюда
  if (payload === 'support') {
    await ctx.reply('Опиши, что случилось, одним сообщением. Можно со скриншотом. Ответим прямо здесь, в этом чате.');
    return;
  }

  const text = lead.access
    ? 'Доступ открыт. Откройте кабинет: там сделки, тренажёр и материалы клуба.'
    : 'Добро пожаловать в Hunter AI. Откройте кабинет, чтобы начать.';

  if (config.miniAppUrl) {
    const kb = new InlineKeyboard().webApp('Открыть кабинет', config.miniAppUrl);
    await ctx.reply(text, { reply_markup: kb });
  } else {
    await ctx.reply(text);
  }
});

bot.catch((err) => console.error('Ошибка бота:', err.error));

/** Любое обычное сообщение клиента это обращение в поддержку: сохраняем и показываем команде в Office. */
bot.on('message', async (ctx) => {
  const from = ctx.from;
  if (!from || ctx.chat.type !== 'private') return;
  const m = ctx.message;
  if (m.text?.startsWith('/')) return;
  await attachLead(from.id, from.username, from.first_name, null);

  let kind = 'other';
  let fileId: string | null = null;
  if (m.text) kind = 'text';
  else if (m.photo) [kind, fileId] = ['photo', m.photo[m.photo.length - 1].file_id];
  else if (m.document) [kind, fileId] = ['document', m.document.file_id];
  else if (m.voice) [kind, fileId] = ['voice', m.voice.file_id];
  else if (m.video) [kind, fileId] = ['video', m.video.file_id];
  else if (m.video_note) [kind, fileId] = ['video', m.video_note.file_id];
  else if (m.sticker) kind = 'sticker';

  const first = await recordIncoming({
    tgId: from.id,
    kind,
    text: m.text ?? m.caption ?? null,
    fileId,
    tgMessageId: m.message_id,
  });
  if (first) await ctx.reply('Принято. Ответим прямо здесь, в этом чате.');
});
