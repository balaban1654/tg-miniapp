import { InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { attachLead, db } from './db.js';
import { buildKeyboard, loadTarget, processLead, type Button } from './push.js';
import { recordIncoming } from './chat.js';

import { bot } from './tg.js';
export { bot };

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

  await db.query('UPDATE leads SET bot_started = TRUE, bot_blocked = FALSE, last_seen_at = now() WHERE tg_id = $1', [from.id]);

  const cabinet = config.miniAppUrl ? new InlineKeyboard().webApp('Открыть кабинет', config.miniAppUrl) : undefined;
  if (lead.access) {
    await ctx.reply('Доступ открыт. Откройте кабинет: там сделки, тренажёр и материалы клуба.', cabinet ? { reply_markup: cabinet } : undefined);
    return;
  }
  // Приветствие берётся из настроек пушей в Office. Если его там нет, шлём короткое
  if (!(await processLead(from.id))) {
    await ctx.reply('Добро пожаловать в Hunter AI. Откройте кабинет, чтобы начать.', cabinet ? { reply_markup: cabinet } : undefined);
  }
});

const REGISTER: Button = { label: 'Зарегистрироваться', type: 'register' };
const SUPPORT: Button = { label: 'Написать в поддержку', type: 'support' };

bot.callbackQuery('acc_no', async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = buildKeyboard([REGISTER, SUPPORT], await loadTarget(ctx.from.id));
  await ctx.reply('Отлично, создадим. Нажми «Зарегистрироваться»: регистрация займёт пару минут. Если что-то непонятно, напиши сюда.', kb ? { reply_markup: kb } : undefined);
});

bot.callbackQuery('acc_yes', async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = buildKeyboard([SUPPORT, REGISTER], await loadTarget(ctx.from.id));
  await ctx.reply('Отлично! Чтобы мы видели твой аккаунт и открыли доступ, регистрация должна быть по нашей ссылке. Если ты уже зарегистрирован не по ней, напиши в поддержку: подскажем, как быть.', kb ? { reply_markup: kb } : undefined);
});

bot.catch((err) => console.error('Ошибка бота:', err.error));

/** Любое обычное сообщение клиента это обращение в поддержку: сохраняем и показываем команде в Office. */
bot.on('message', async (ctx) => {
  const from = ctx.from;
  if (!from || ctx.chat.type !== 'private') return;
  const m = ctx.message;
  if (m.text?.startsWith('/')) return;
  await attachLead(from.id, from.username, from.first_name, null);
  await db.query('UPDATE leads SET bot_started = TRUE, bot_blocked = FALSE, last_seen_at = now() WHERE tg_id = $1', [from.id]);

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
