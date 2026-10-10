import { db } from './db.js';
import { config } from './config.js';
import { buildKeyboard, deliver, loadTarget, renderText, type Button } from './push.js';

/** Ответы бота на кнопки и /start. Текст, картинку и кнопки админ правит в Office: Пуши → Ответы бота */
export const REPLY_KEYS = ['acc_ready', 'acc_no', 'acc_yes', 'access_open', 'support'] as const;
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
};

export async function seedReplies(): Promise<void> {
  for (const k of REPLY_KEYS) {
    const d = REPLY_DEFAULTS[k];
    await db.query('INSERT INTO bot_replies (key, text, buttons) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING', [k, d.text, JSON.stringify(d.buttons)]);
  }
}

/** Отправить клиенту ответ из настроек; если строки нет, стандартный */
export async function sendReply(tgId: number, key: ReplyKey): Promise<void> {
  const r = (await db.query('SELECT text, buttons, photo, photo_type FROM bot_replies WHERE key = $1', [key])).rows[0];
  const d = REPLY_DEFAULTS[key];
  const t = await loadTarget(tgId);
  const raw: string = r ? r.text : d.text;
  const text = t ? renderText(raw, t) : raw;
  const kb = t ? buildKeyboard(r ? r.buttons : d.buttons, t) : undefined;
  const res = await deliver(String(tgId), text.replaceAll('{условия}', config.termsUrl), kb, r?.photo ? { data: r.photo, type: r.photo_type } : null);
  if (!res.ok) console.error(`Ответ бота ${key} не ушёл ${tgId}:`, res.error);
}
