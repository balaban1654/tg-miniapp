import { InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { attachLead, db } from './db.js';
import { buildKeyboard, loadTarget, processLead, toHtml, type Button } from './push.js';
import type { Context } from 'grammy';
import { recordIncoming } from './chat.js';

import { bot } from './tg.js';
export { bot };

/** Из параметра /start вида "s_ivan" берём slug "ivan". */
export function parseStartPayload(payload: string): string | null {
  const m = /^[sb]_([a-zA-Z0-9_-]{1,64})$/.exec(payload.trim());
  return m ? m[1] : null;
}

/** Узнать id чата: нужно один раз, чтобы указать группу для копий базы (BACKUP_TG_CHAT_ID). Работает и в группе. */
bot.command('chatid', async (ctx) => {
  await ctx.reply(`ID этого чата: ${ctx.chat.id}`);
});

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
    await ctx.reply('Доступ открыт. Откройте кабинет: там сделки, тренажёр и материалы команды.', cabinet ? { reply_markup: cabinet } : undefined);
    return;
  }
  // Приветствие берётся из настроек пушей в Office. Если его там нет, шлём короткое
  if (!(await processLead(from.id))) {
    await ctx.reply('Добро пожаловать в Hunter AI. Откройте кабинет, чтобы начать.', cabinet ? { reply_markup: cabinet } : undefined);
  }
});

const REGISTER: Button = { label: 'Зарегистрироваться', type: 'register', style: 'success' };
const SUPPORT: Button = { label: 'Написать в поддержку', type: 'support' };

/** Ответ с простой разметкой (жирный, курсив, ссылки) и без предпросмотра ссылок */
async function say(ctx: Context, text: string, kb?: ReturnType<typeof buildKeyboard>): Promise<void> {
  await ctx.reply(toHtml(text), { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(kb ? { reply_markup: kb } : {}) });
}

// «Всё понятно — регистрация»
bot.callbackQuery('acc_ready', async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = buildKeyboard(
    [{ label: 'Нет, создать', type: 'callback', data: 'acc_no', style: 'success', inline: true }, { label: 'Да, уже есть', type: 'callback', data: 'acc_yes' }, SUPPORT],
    await loadTarget(ctx.from.id),
  );
  await say(ctx, 'Отлично! Для доступа к сигналам нужен новый аккаунт Pocket Option — по нему я открою тебе сигналы.\n\n**У тебя уже есть аккаунт Pocket Option?**', kb);
});

bot.callbackQuery('acc_no', async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = buildKeyboard([REGISTER, { label: 'Не получается — написать в поддержку', type: 'support' }], await loadTarget(ctx.from.id));
  await say(
    ctx,
    `Регистрация займёт 2 минуты:\n\n1. Нажми кнопку ниже и создай аккаунт\n2. Пополни счёт от 50 $ (рекомендуем от 100 $)\n3. Доступ откроется сам — ничего вводить не нужно\n\n__Нажимая «Зарегистрироваться», ты подтверждаешь, что тебе 18+ и понимаешь: торговля связана с риском потери денег.__ [Условия](${config.termsUrl})`,
    kb,
  );
});

bot.callbackQuery('acc_yes', async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = buildKeyboard([REGISTER, { label: 'Написать в поддержку', type: 'support' }], await loadTarget(ctx.from.id));
  await say(ctx, 'Отлично! Чтобы мы видели твой аккаунт и открыли доступ, регистрация должна быть по нашей ссылке. Если ты уже зарегистрирован не по ней, напиши в поддержку: подскажем, как быть.', kb);
});

/** Описание бота (видно до /start) и кнопка меню слева от поля ввода */
export async function setupBotProfile(): Promise<void> {
  try {
    await bot.api.setMyDescription(
      'Что умеет этот бот?\n\nАссистент выдаёт готовые торговые сигналы: пара, направление, точки входа. Тебе остаётся только повторить.\n\nНажми «Старт» — за 1 минуту покажу, как это работает.',
    );
    if (config.miniAppUrl) {
      await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Hunter AI', web_app: { url: config.miniAppUrl } } });
    }
  } catch (e) {
    console.error('Не удалось обновить описание бота:', e);
  }
}

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
  else if (m.animation) [kind, fileId] = ['animation', m.animation.file_id];
  else if (m.document) [kind, fileId] = ['document', m.document.file_id];
  else if (m.voice) [kind, fileId] = ['voice', m.voice.file_id];
  else if (m.audio) [kind, fileId] = ['audio', m.audio.file_id];
  else if (m.video) [kind, fileId] = ['video', m.video.file_id];
  else if (m.video_note) [kind, fileId] = ['video_note', m.video_note.file_id];
  else if (m.sticker) kind = 'sticker';

  const first = await recordIncoming({
    tgId: from.id,
    kind,
    text: m.text ?? m.caption ?? null,
    fileId,
    fileName: m.document?.file_name ?? m.audio?.file_name ?? null,
    tgMessageId: m.message_id,
  });
  if (first) await ctx.reply('Принято. Ответим прямо здесь, в этом чате.');
});
