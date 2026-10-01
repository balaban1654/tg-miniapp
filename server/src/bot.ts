import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { attachLead } from './db.js';

export const bot = new Bot(config.botToken);

/** Из параметра /start вида "s_ivan" берём slug "ivan". */
export function parseStartPayload(payload: string): string | null {
  const m = /^[sb]_([a-zA-Z0-9_-]{1,64})$/.exec(payload.trim());
  return m ? m[1] : null;
}

bot.command('start', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  const slug = parseStartPayload(ctx.match ?? '');
  const { lead } = await attachLead(from.id, from.username, from.first_name, slug);

  const text = lead.access
    ? 'Доступ открыт. Откройте кабинет и запустите анализ.'
    : 'Добро пожаловать в Hunter AI. Откройте кабинет, чтобы начать.';

  if (config.miniAppUrl) {
    const kb = new InlineKeyboard().webApp('Открыть кабинет', config.miniAppUrl);
    await ctx.reply(text, { reply_markup: kb });
  } else {
    await ctx.reply(text);
  }
});

bot.catch((err) => console.error('Ошибка бота:', err.error));
