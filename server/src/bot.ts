import { sendPlanReport, setPlanChat } from './planReport.js';
import { InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { attachLead, db } from './db.js';
import { parseRefPayload } from './referral.js';
import { processLead } from './push.js';
import { recordIncoming, notifySupport } from './chat.js';
import { sendReply } from './replies.js';

import { bot } from './tg.js';
import { markLeadAlive, markLeadBlocked } from './leadblock.js';
export { bot };

const BANNED_TEXT = 'Ваш доступ к Hunter AI заблокирован. Если это ошибка, напишите сюда сообщение — поддержка ответит.';
const BANNED_TEXT_EN = 'Your access to Hunter AI is blocked. If this is a mistake, write a message here and support will reply.';
/** Язык клиента: null, пока он не выбрал */
async function leadLang(tgId: number): Promise<string | null> {
  return (await db.query('SELECT lang FROM leads WHERE tg_id = $1', [tgId])).rows[0]?.lang ?? null;
}
const banned = async (tgId: number) => ((await leadLang(tgId)) === 'en' ? BANNED_TEXT_EN : BANNED_TEXT);
// Выбор языка при первом /start. Дальше воронка, пуши и Mini App на выбранном языке
const LANG_ASK = '🌐 Выберите язык / Choose your language';
const langKeyboard = () => new InlineKeyboard().text('🇷🇺 Русский', 'lang:ru').text('🇬🇧 English', 'lang:en');
async function isBanned(tgId: number): Promise<boolean> {
  return ((await db.query('SELECT 1 FROM leads WHERE tg_id = $1 AND banned_at IS NOT NULL', [tgId])).rowCount ?? 0) > 0;
}

/** Из параметра /start вида "s_ivan" берём slug "ivan". */
export function parseStartPayload(payload: string): string | null {
  const m = /^[sb]_([a-zA-Z0-9_-]{1,64})$/.exec(payload.trim());
  return m ? m[1] : null;
}

/** /notify в ветке группы команды: уведомления о новых сообщениях в поддержку будут приходить сюда.
 *  Бот сам запоминает группу и ветку (номер ветки из ссылки легко перепутать с номером сообщения). Только админ группы */
bot.command('notify', async (ctx) => {
  if (ctx.chat.type === 'private') return ctx.reply('Отправьте /notify в нужной ветке группы команды.');
  const m = await ctx.getChatMember(ctx.from!.id).catch(() => null);
  if (!m || !['creator', 'administrator'].includes(m.status)) return ctx.reply('Назначить ветку для уведомлений может только админ группы.');
  const thread = ctx.msg.is_topic_message ? ctx.msg.message_thread_id ?? null : null;
  const save = (k: string, v: string) => db.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [k, v]);
  await save('support_notify_chat', String(ctx.chat.id));
  await save('support_notify_thread', thread ? String(thread) : '');
  await save('support_notify_error', '');
  await ctx.reply('✅ Готово: уведомления о новых сообщениях в поддержку будут приходить сюда.');
});

/** /plan_here в общей группе: сюда каждый день в 12:00 по Киеву приходит «План / факт». Сразу шлём первый отчёт. Только админ группы */
bot.command('plan_here', async (ctx) => {
  if (ctx.chat.type === 'private') return ctx.reply('Отправьте /plan_here в общей группе: туда будет приходить «План / факт».');
  const m = await ctx.getChatMember(ctx.from!.id).catch(() => null);
  if (!m || !['creator', 'administrator'].includes(m.status)) return ctx.reply('Назначить группу для «План / факт» может только админ группы.');
  await setPlanChat(ctx.chat.id, ctx.msg.is_topic_message ? ctx.msg.message_thread_id ?? null : null);
  await ctx.reply('✅ Готово: «План / факт» будет приходить сюда каждый день в 12:00 по Киеву. Первый отчёт ниже.');
  const err = await sendPlanReport();
  if (err) await ctx.reply('Не удалось собрать отчёт: ' + err);
});

/** Узнать id чата: нужно один раз, чтобы указать группу для копий базы (BACKUP_TG_CHAT_ID). Работает и в группе. */
bot.command('chatid', async (ctx) => {
  await ctx.reply(`ID этого чата: ${ctx.chat.id}`);
});

bot.command('start', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  const payload = (ctx.match ?? '').trim();
  const slug = parseStartPayload(payload);
  // Новый лид с кнопки «Открыть бота» на сайте (?start=site): метка «site» вместо органики и свои настройки владельца
  const { lead } = await attachLead(from.id, from.username, from.first_name, slug, payload === 'site' ? 'site' : null, parseRefPayload(payload));

  // Заблокированный лид: воронки нет, только сообщение (написать в поддержку он может)
  if (await isBanned(from.id) && payload !== 'support') {
    await ctx.reply(await banned(from.id));
    return;
  }
  // Кнопка «Поддержка» в Mini App ведёт сюда
  if (payload === 'support') {
    // Клиент сам нажал «Поддержка»: закрытый чат открываем, его следующее сообщение сразу попадёт в Office
    await db.query('UPDATE leads SET chat_closed_at = NULL, support_ask_at = NULL, chat_notified_at = CASE WHEN chat_closed_at IS NOT NULL THEN NULL ELSE chat_notified_at END WHERE tg_id = $1', [from.id]);
    await sendReply(from.id, 'support');
    return;
  }

  await markLeadAlive(from.id);
  // Язык ещё не выбран: сначала спрашиваем, воронка продолжится после выбора
  if (!lead.lang) {
    await ctx.reply(LANG_ASK, { reply_markup: langKeyboard() });
    return;
  }
  await continueStart(from.id);
});

/** Воронка после /start (или после выбора языка): приветствие из «Автоматических пушей» либо «доступ открыт» */
async function continueStart(tgId: number): Promise<void> {
  const lead = (await db.query('SELECT access, lang FROM leads WHERE tg_id = $1', [tgId])).rows[0];
  if (!lead) return;
  if (lead.access) {
    await sendReply(tgId, 'access_open');
    return;
  }
  // Приветствие берётся из настроек пушей в Office. Если его там нет, шлём короткое
  if (!(await processLead(tgId))) {
    const en = lead.lang === 'en';
    const cabinet = config.miniAppUrl ? new InlineKeyboard().webApp(en ? 'Open the app' : 'Открыть кабинет', config.miniAppUrl) : undefined;
    await bot.api.sendMessage(tgId, en ? 'Welcome to Hunter AI. Open the app to get started.' : 'Добро пожаловать в Hunter AI. Откройте кабинет, чтобы начать.', cabinet ? { reply_markup: cabinet } : undefined);
  }
}

// Клиент выбрал язык: запоминаем и продолжаем воронку на этом языке
bot.callbackQuery(/^lang:(ru|en)$/, async (ctx) => {
  const lang = ctx.match[1];
  // Воронку продолжаем только при первом выборе: повторное нажатие старой кнопки просто меняет язык
  const first = (await leadLang(ctx.from.id)) === null;
  await db.query('UPDATE leads SET lang = $2 WHERE tg_id = $1', [ctx.from.id, lang]);
  await ctx.answerCallbackQuery({ text: lang === 'en' ? 'English selected' : 'Выбран русский' });
  await ctx.editMessageText(lang === 'en' ? '🇬🇧 Language: English' : '🇷🇺 Язык: русский').catch(() => {});
  if (!first) return;
  if (await isBanned(ctx.from.id)) {
    await ctx.reply(await banned(ctx.from.id));
    return;
  }
  await continueStart(ctx.from.id);
});

// Закрытый чат, лид снова написал: «Да, нужна поддержка» - чат открывается в Office (с тем, что он уже написал) и бот просит описать ситуацию;
// «Нет, спасибо» - чат остаётся закрытым
bot.callbackQuery(/^support_(yes|no)$/, async (ctx) => {
  const yes = ctx.match[1] === 'yes';
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  const id = ctx.from.id;
  if (!yes) {
    await db.query('UPDATE leads SET support_ask_at = NULL WHERE tg_id = $1', [id]);
    await sendReply(id, 'support_no');
    return;
  }
  // Чат открыт заново: отметку «группу уже уведомили» сбрасываем, иначе уведомление с его сообщением не уйдёт
  await db.query('UPDATE leads SET chat_closed_at = NULL, support_ask_at = NULL, chat_notified_at = NULL WHERE tg_id = $1', [id]);
  await sendReply(id, 'support_wait');
  const last = (await db.query(`SELECT kind, text FROM messages WHERE tg_id = $1 AND direction = 'in' ORDER BY id DESC LIMIT 1`, [id])).rows[0];
  await notifySupport({ tgId: id, kind: last?.kind ?? 'text', text: last?.text ?? null, fileId: null, tgMessageId: null }).catch(() => {});
});

// Ответы на кнопки воронки: тексты и кнопки настраиваются в Office (Пуши → Ответы бота)
for (const key of ['acc_ready', 'acc_no', 'acc_yes'] as const) {
  bot.callbackQuery(key, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (await isBanned(ctx.from.id)) {
      await ctx.reply(await banned(ctx.from.id));
      return;
    }
    await sendReply(ctx.from.id, key);
  });
}

/** Описание бота (видно до /start) и кнопка меню слева от поля ввода */
export async function setupBotProfile(): Promise<void> {
  try {
    await bot.api.setMyDescription(
      // Заголовок «Что умеет этот бот?» Telegram добавляет сам
      'Ассистент выдаёт готовые торговые сигналы: пара, направление, точки входа. Тебе остаётся только повторить.\n\nНажми «Старт» — за 1 минуту покажу, как это работает.',
    );
    // Для Telegram на английском языке
    await bot.api.setMyDescription(
      'The assistant gives ready-made trading signals: pair, direction, entry points. All you need to do is follow them.\n\nTap “Start” and in 1 minute I will show you how it works.',
      { language_code: 'en' },
    );
    if (config.miniAppUrl) {
      await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Hunter AI', web_app: { url: config.miniAppUrl } } });
    }
  } catch (e) {
    console.error('Не удалось обновить описание бота:', e);
  }
}

// Клиент заблокировал бота или разблокировал его: Telegram сообщает об этом сразу
bot.on('my_chat_member', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  const st = ctx.myChatMember.new_chat_member.status;
  if (st === 'kicked') await markLeadBlocked(ctx.chat.id);
  else if (st === 'member') await markLeadAlive(ctx.chat.id);
});

bot.catch((err) => console.error('Ошибка бота:', err.error));

/** Любое обычное сообщение клиента это обращение в поддержку: сохраняем и показываем команде в Office. */
bot.on('message', async (ctx) => {
  const from = ctx.from;
  if (!from || ctx.chat.type !== 'private') return;
  const m = ctx.message;
  if (m.text?.startsWith('/')) return;
  await attachLead(from.id, from.username, from.first_name, null);
  await markLeadAlive(from.id);

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

  // Чат закрыт в Office (после закрытия от клиента ничего не было): сообщение сохраняем, но чат не открываем,
  // а спрашиваем, нужна ли поддержка (не чаще раза в 10 минут). Откроет чат кнопка «Да, нужна поддержка»
  const st = (await db.query(
    `SELECT d.chat_closed_at IS NOT NULL AND coalesce((SELECT max(created_at) FROM messages WHERE tg_id = d.tg_id), '-infinity') <= d.chat_closed_at AS closed,
            (d.support_ask_at IS NULL OR d.support_ask_at < now() - interval '10 minutes') AS can_ask
       FROM leads d WHERE d.tg_id = $1`, [from.id])).rows[0];
  const inc = { tgId: from.id, kind, text: m.text ?? m.caption ?? null, fileId, fileName: m.document?.file_name ?? m.audio?.file_name ?? null, tgMessageId: m.message_id };
  if (st?.closed) {
    await recordIncoming(inc, true);
    await db.query('UPDATE leads SET chat_closed_at = now() WHERE tg_id = $1', [from.id]);
    if (st.can_ask) {
      await db.query('UPDATE leads SET support_ask_at = now() WHERE tg_id = $1', [from.id]);
      await sendReply(from.id, 'support_ask');
    }
    return;
  }
  const first = await recordIncoming(inc);
  // Первое сообщение за 10 минут: «Ожидайте, менеджер ответит…» (текст в Office: Пуши → Ответы бота)
  if (first) await sendReply(from.id, 'support_wait');
});
