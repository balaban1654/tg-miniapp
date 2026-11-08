import { db } from './db.js';
import { config } from './config.js';
import { buildKeyboard, deliver, loadTarget, pickText, renderText, type Button } from './push.js';

/** Ответы бота на кнопки и /start. Текст, картинку и кнопки админ правит в Office: Пуши → Ответы бота */
export const REPLY_KEYS = ['acc_ready', 'acc_no', 'acc_yes', 'access_open', 'support', 'support_ask', 'support_no', 'support_wait'] as const;
export type ReplyKey = (typeof REPLY_KEYS)[number];

const SUPPORT: Button = { label: 'Написать в поддержку', type: 'support' };
const REGISTER: Button = { label: 'Зарегистрироваться', type: 'register', style: 'success' };

export const REPLY_DEFAULTS: Record<ReplyKey, { text: string; buttons: Button[] }> = {
  acc_ready: {
    text: 'Отлично! Для доступа к сигналам нужен новый аккаунт Pocket Option — по нему я открою тебе сигналы.\n\n**У тебя уже есть аккаунт Pocket Option?**',
    buttons: [{ label: 'Нет, создать', type: 'callback', data: 'acc_no', style: 'success', inline: true }, { label: 'Да, уже есть', type: 'callback', data: 'acc_yes' }, SUPPORT],
  },
  acc_no: {
    text: 'Регистрация займёт 2 минуты:\n\n1. Нажми кнопку ниже и создай аккаунт\n2. Пополни счёт от 50 $ (рекомендуем от 100 $)\n3. Доступ откроется сам — ничего вводить не нужно\n\n__Нажимая «Зарегистрироваться», ты подтверждаешь, что тебе 18+ и понимаешь: торговля связана с риском потери денег.__ [Условия]({условия})',
    buttons: [REGISTER, { label: 'Не получается — написать в поддержку', type: 'support' }],
  },
  acc_yes: {
    text: 'Отлично! Чтобы мы видели твой аккаунт и открыли доступ, регистрация должна быть по нашей ссылке. Если ты уже зарегистрирован не по ней, напиши в поддержку: подскажем, как быть.',
    buttons: [REGISTER, SUPPORT],
  },
  access_open: {
    text: 'Доступ открыт. Откройте кабинет: там сделки, тренажёр и материалы команды.',
    buttons: [{ label: 'Открыть кабинет', type: 'miniapp' }],
  },
  support: {
    text: 'Опиши, что случилось, одним сообщением. Можно со скриншотом. Ответим прямо здесь, в этом чате.',
    buttons: [],
  },
  support_ask: {
    text: 'Вам нужна помощь?',
    buttons: [
      { label: 'Да, нужна поддержка', label_en: 'Yes, I need support', type: 'callback', data: 'support_yes', style: 'success', inline: true },
      { label: 'Нет, спасибо', label_en: 'No, thanks', type: 'callback', data: 'support_no' },
    ],
  },
  support_no: {
    text: 'Хорошо! Если понадобится помощь, просто напишите сюда.',
    buttons: [],
  },
  support_wait: {
    text: 'Ожидайте, менеджер ответит вам в ближайшее время. Если есть что дополнить — напишите, пока ждём менеджера.',
    buttons: [],
  },
};

/** Английские тексты стандартных ответов. Используются, пока админ не задал свой английский текст и русский не менялся */
export const REPLY_DEFAULTS_EN: Record<ReplyKey, string> = {
  acc_ready: 'Great! To get signals you need a new Pocket Option account: I will unlock signals for it.\n\n**Do you already have a Pocket Option account?**',
  acc_no: 'Registration takes 2 minutes:\n\n1. Tap the button below and create an account\n2. Top up from $50 (we recommend $100+)\n3. Access unlocks by itself, nothing to enter\n\n__By tapping “Sign up” you confirm you are 18+ and understand that trading involves the risk of losing money.__ [Terms]({условия})',
  acc_yes: 'Great! For us to see your account and unlock access, it must be registered via our link. If you registered without it, write to support and we will help.',
  access_open: 'Access is open. Open the app: trades, the trainer and team materials are there.',
  support: 'Describe what happened in one message. You can add a screenshot. We will reply right here in this chat.',
  support_ask: 'Do you need help?',
  support_no: 'Okay! If you need help, just write here.',
  support_wait: 'Please wait, a manager will reply shortly. If you want to add anything, write it here while you wait.',
};

export async function seedReplies(): Promise<void> {
  for (const k of REPLY_KEYS) {
    const d = REPLY_DEFAULTS[k];
    await db.query('INSERT INTO bot_replies (key, text, buttons) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING', [k, d.text, JSON.stringify(d.buttons)]);
  }
}

/** Отправить клиенту ответ из настроек; если строки нет, стандартный */
export async function sendReply(tgId: number, key: ReplyKey): Promise<void> {
  const r = (await db.query('SELECT text, text_en, buttons, photo, photo_type FROM bot_replies WHERE key = $1', [key])).rows[0];
  const d = REPLY_DEFAULTS[key];
  const t = await loadTarget(tgId);
  const ru: string = r ? r.text : d.text;
  // Английский: свой текст из Office, иначе стандартный перевод, если русский текст не меняли
  const en = r?.text_en || (ru === d.text ? REPLY_DEFAULTS_EN[key] : '');
  const raw: string = pickText(ru, en, t?.lang);
  const text = t ? renderText(raw, t) : raw;
  const kb = t ? buildKeyboard(r ? r.buttons : d.buttons, t) : undefined;
  const res = await deliver(String(tgId), text.replaceAll('{условия}', config.termsUrl), kb, r?.photo ? { data: r.photo, type: r.photo_type } : null);
  if (!res.ok) console.error(`Ответ бота ${key} не ушёл ${tgId}:`, res.error);
}
