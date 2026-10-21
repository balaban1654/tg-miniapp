import { InlineKeyboard } from 'grammy';
import { db } from './db.js';
import { bot } from './bot.js';

/*
 * Розыгрыш в Mini App (только админ). Победителя выбирает сервер случайно среди клиентов выбранных групп,
 * исключая тех, кто уже выпадал в этом розыгрыше. Победителю бот шлёт сообщение с кнопкой «Забрать бонус»,
 * на нажатие 15 секунд: время считает сервер, поэтому у админа и у победителя оно одно.
 */
export const CLAIM_SEC = 15;
// Группы для админа названы иначе, чтобы не показывать настоящие статусы: newbie «Ещё не в команде», ftd «Новенький», active «Профессионал»
export const GROUPS: Record<string, string[]> = { newbie: ['new', 'registered'], ftd: ['ftd'], active: ['active'] };

/** Кто может участвовать: клиенты выбранных групп, бот у них запущен и не заблокирован, без бана и без служебных аккаунтов */
export function poolWhere(groups: string[]): { sql: string; statuses: string[] } {
  const statuses = groups.flatMap((g) => GROUPS[g] ?? []);
  return {
    sql: `d.lead_role = 'lead' AND d.status = ANY($1::text[]) AND d.bot_started AND NOT coalesce(d.bot_blocked, FALSE)
          AND d.banned_at IS NULL AND NOT coalesce(d.is_tester, FALSE)`,
    statuses,
  };
}

/** Состояние выпавшего победителя: выпал, сообщение отправлено, забрал или время вышло */
export function drawState(d: { sent_at: Date | null; deadline: Date | null; claimed_at: Date | null }): 'drawn' | 'sent' | 'claimed' | 'expired' {
  if (d.claimed_at) return 'claimed';
  if (!d.sent_at) return 'drawn';
  return Date.now() > +new Date(d.deadline!) ? 'expired' : 'sent';
}

export async function sendClaim(drawId: number): Promise<{ deadline: Date } | { error: string }> {
  const d = (await db.query('SELECT id, tg_id, place, prize, sent_at FROM giveaway_draws WHERE id = $1', [drawId])).rows[0];
  if (!d) return { error: 'Победитель не найден' };
  if (d.sent_at) return { error: 'Сообщение уже отправлено' };
  const prize = Number(d.prize).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  const text =
    `🎁 Поздравляем! Вы победили в розыгрыше Hunter AI: ${d.place} место, бонус $${prize}.\n\n` +
    `Нажмите «Забрать бонус» в течение ${CLAIM_SEC} секунд, иначе приз перейдёт другому участнику.`;
  try {
    const m = await bot.api.sendMessage(Number(d.tg_id), text, { reply_markup: new InlineKeyboard().text('🎁 Забрать бонус', `gw:${d.id}`) });
    // Время пошло с момента отправки
    const r = await db.query(`UPDATE giveaway_draws SET sent_at = now(), deadline = now() + make_interval(secs => $2), msg_id = $3 WHERE id = $1 RETURNING deadline`, [
      d.id,
      CLAIM_SEC,
      m.message_id,
    ]);
    return { deadline: r.rows[0].deadline };
  } catch {
    return { error: 'Не удалось отправить: клиент мог заблокировать бота. Выберите другого победителя' };
  }
}

// Победитель нажал «Забрать бонус»: успел за 15 секунд — бонус его, иначе время вышло
bot.callbackQuery(/^gw:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const r = await db.query(
    `UPDATE giveaway_draws SET claimed_at = now() WHERE id = $1 AND tg_id = $2 AND claimed_at IS NULL AND sent_at IS NOT NULL AND now() <= deadline + interval '1 second'
     RETURNING prize, place`,
    [id, ctx.from.id],
  );
  if (r.rowCount) {
    const prize = Number(r.rows[0].prize).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    await ctx.answerCallbackQuery({ text: 'Бонус ваш! 🎉' });
    await ctx.editMessageText(`🎉 Бонус $${prize} ваш (${r.rows[0].place} место)! Менеджер свяжется с вами, чтобы его начислить.`).catch(() => {});
    return;
  }
  const d = (await db.query('SELECT claimed_at FROM giveaway_draws WHERE id = $1 AND tg_id = $2', [id, ctx.from.id])).rows[0];
  await ctx.answerCallbackQuery({ text: d?.claimed_at ? 'Бонус уже ваш' : 'Время вышло, приз перешёл другому участнику', show_alert: !d?.claimed_at });
  if (d && !d.claimed_at) await ctx.editMessageText('⏱ Время вышло: бонус не был забран за 15 секунд и перешёл другому участнику.').catch(() => {});
});
