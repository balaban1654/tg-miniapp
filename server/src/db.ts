import pg from 'pg';
import { referrerOf } from './referral.js';
import { config } from './config.js';
import { leadLog, staffName } from './leadlog.js';
import { createHash } from 'node:crypto';

/** Хеш IP для сопоставления клика по ссылке и первого входа в Mini App (сам IP не храним) */
export const ipHash = (ip: string | null | undefined): string | null => (ip ? createHash('sha256').update(ip + '|' + config.botToken).digest('hex').slice(0, 32) : null);

export const db = new pg.Pool({ connectionString: config.databaseUrl });

export interface Lead {
  tg_id: string;
  owner_id: number | null;
  status: string;
  access: boolean;
  lang?: string | null;
}

/**
 * Создаёт лида при первом /start и закрепляет его за владельцем ссылки.
 * Повторный заход по чужой ссылке владельца не меняет.
 */
export async function attachLead(
  tgId: number,
  username: string | undefined,
  firstName: string | undefined,
  slug: string | null,
  origin: 'site' | 'ref' | null = null,
  refId: number | null = null,
  via: 'start' | 'app' | 'msg' = 'start',
  ip: string | null = null,
): Promise<{ lead: Lead; isNew: boolean }> {
  // Открыл Mini App без «Старта» (кнопкой «Открыть» в профиле бота): параметр ссылки Telegram в этом случае не передаёт.
  // Ищем переход по ссылке с этого же IP за 30 минут до первого захода — значит, пришёл по ней
  let byIp: { min: number } | null = null;
  if (!slug && !refId && ip) {
    const L0 = (await db.query('SELECT link_id, created_at FROM leads WHERE tg_id = $1', [tgId])).rows[0];
    if (!L0 || (L0.link_id == null && +new Date(L0.created_at) > Date.now() - 86400000)) {
      const c = (await db.query(
        `SELECT l.slug, round(extract(epoch FROM ($2::timestamptz - c.at)) / 60)::int AS min FROM link_clicks c JOIN links l ON l.id = c.link_id
          WHERE c.ip_hash = $1 AND c.at BETWEEN $2::timestamptz - interval '30 minutes' AND $2::timestamptz + interval '2 minutes' ORDER BY c.at DESC LIMIT 1`,
        [ipHash(ip), L0 ? L0.created_at : new Date()])).rows[0];
      if (c) { slug = c.slug; byIp = { min: Math.max(0, c.min) }; }
    }
  }
  // Для журнала лида: откуда пришёл и почему достался этому владельцу
  let how = '';
  let linkSlug: string | null = null;
  // Лид сначала открыл Mini App или написал без «Старта» (его раздали как органику), а потом пришёл по ссылке стримера:
  // переводим его владельцу ссылки, пока он ещё ничей по сути — в течение суток, до регистрации, без ответов команды и ручных смен
  let move = false;
  let linkId: number | null = null;
  let ownerId: number | null = null;
  // Реферальная ссылка: новый лид закрепляется за трейдером пригласившего
  let referrer: number | null = null;
  if (refId && !slug && !(await db.query('SELECT 1 FROM leads WHERE tg_id = $1', [tgId])).rowCount) {
    const r = await referrerOf(refId, tgId);
    if (r) {
      referrer = refId; ownerId = r.owner_id; origin = 'ref'; how = 'по приглашению друга (Telegram ID ' + refId + '), владелец как у пригласившего';
      // Пригласивший пришёл по ссылке «Случайно»: его друга тоже раздаём по очереди из пула этой ссылки.
      // Если пригласил сам стример со своего аккаунта, друг остаётся за ним
      if (!r.staff) {
        const l = (await db.query(
          `SELECT coalesce(l.parent_id, l.id) AS root, coalesce(p.rotate, l.rotate) AS rotate
             FROM leads d JOIN links l ON l.id = d.link_id LEFT JOIN links p ON p.id = l.parent_id WHERE d.tg_id = $1`, [refId])).rows[0];
        if (l?.rotate) { const p = await pickRotationOwner(l.root, tgId); if (p) { ownerId = p; how = 'по приглашению друга, по очереди из списка «Случайно» ссылки пригласившего'; } }
      }
    }
  }
  if (slug) {
    const r = await db.query(
      `SELECT l.id, l.slug, l.owner_id, coalesce(p.rotate, l.rotate) AS rotate, coalesce(l.parent_id, l.id) AS root
         FROM links l LEFT JOIN links p ON p.id = l.parent_id WHERE l.slug = $1 OR l.token = $1`,
      [slug],
    );
    if (r.rows[0]) {
      linkId = r.rows[0].id;
      ownerId = r.rows[0].owner_id;
      linkSlug = r.rows[0].slug;
      how = 'владелец ссылки';
      const cur = (await db.query(
        `SELECT d.owner_id, d.link_id, d.status, d.created_at > now() - interval '24 hours' AS recent,
                EXISTS (SELECT 1 FROM organic_assign a WHERE a.tg_id = d.tg_id) AS organic,
                EXISTS (SELECT 1 FROM messages m WHERE m.tg_id = d.tg_id AND m.direction = 'out' AND m.staff_id IS NOT NULL) AS replied,
                EXISTS (SELECT 1 FROM lead_log g WHERE g.tg_id = d.tg_id AND g.kind = 'owner') AS touched
           FROM leads d WHERE d.tg_id = $1`, [tgId])).rows[0];
      move = !!cur && cur.link_id == null && cur.owner_id != null && cur.organic && cur.recent && !cur.replied && !cur.touched;
      // «Случайно»: владельца выбираем по очереди, только для нового лида, лида без владельца или переводимого из органики
      if (r.rows[0].rotate) {
        if (!cur || cur.owner_id == null || move) { const p = await pickRotationOwner(r.rows[0].root, tgId); if (p) { ownerId = p; how = 'по очереди из списка «Случайно» этой ссылки'; } }
      }
    }
  }
  // Органика: новый лид без ссылки (сам нашёл бота или пришёл с сайта) — владелец по настройкам «Органика» в Office
  const fresh = !(await db.query('SELECT 1 FROM leads WHERE tg_id = $1', [tgId])).rowCount;
  if (!linkId && !referrer && fresh) { ownerId = await pickOrganicOwner(origin === 'site' ? 'site' : 'org', tgId); if (ownerId) how = 'органика: по настройке «Органика» в Office'; }
  // Никто не нашёлся (органика «Не закреплять», пустой пул, пригласивший без трейдера): по очереди всем активным стримерам
  if (fresh && !ownerId) { ownerId = await pickFallbackOwner(tgId); if (ownerId) how = 'никто не был назначен, по общей очереди всем активным стримерам'; }
  const ins = await db.query(
    `INSERT INTO leads (tg_id, username, first_name, link_id, owner_id, origin, referrer_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tg_id) DO NOTHING
     RETURNING *`,
    [tgId, username ?? null, firstName ?? null, linkId, ownerId, linkId ? null : origin, referrer],
  );
  const VIA = { start: 'нажал «Старт» в боте', app: 'открыл Mini App без «Старта»', msg: 'написал боту без «Старта»' };
  const ipNote = byIp ? ` (определено по переходу по ссылке с того же IP${byIp.min ? ' за ' + byIp.min + ' мин до этого' : ''}: «Старт» он не нажимал)` : '';
  const src = linkSlug ? 'по ссылке ' + linkSlug + ipNote : referrer ? 'по реферальной ссылке' : origin === 'site' ? 'с сайта' : 'без ссылки (органика)';
  if (ins.rows[0]) {
    await db.query(`INSERT INTO events (tg_id, type) VALUES ($1,'start')`, [tgId]);
    await leadLog(tgId, 'came', `Пришёл ${src}: ${VIA[via]}. ` + (ownerId ? `Закреплён за ${await staffName(ownerId)} (${how || 'владелец ссылки'})` : 'Не закреплён: заберёт тот, кто ответит первым'));
    return { lead: ins.rows[0], isNew: true };
  }
  // Лид, которого удалили из списка (снят с Mini App), вернулся сам (/start, сообщение, открыл Mini App): снова показываем его в «Лидах»
  // как пришедшего сейчас. Доступ при этом не открывается сам: он закрыт, пока не придёт депозит или его не выдадут вручную
  const back = await db.query('UPDATE leads SET removed_at = NULL, created_at = now() WHERE tg_id = $1 AND removed_at IS NOT NULL', [tgId]);
  if (back.rowCount) await leadLog(tgId, 'back', `Вернулся после удаления из списка: ${VIA[via]}` + (linkSlug ? ' по ссылке ' + linkSlug : ''));
  // Уже есть в базе и пришёл снова по ссылке: пишем, по какой, и что вышло со ссылкой и владельцем
  const was = (await db.query('SELECT link_id, owner_id FROM leads WHERE tg_id = $1', [tgId])).rows[0];
  if (was && move && ownerId && ownerId !== was.owner_id) {
    await db.query('UPDATE leads SET owner_id = $2, link_id = $3, taken_from = NULL WHERE tg_id = $1', [tgId, ownerId, linkId]);
    await leadLog(tgId, 'owner', (byIp ? `Найден переход по ссылке ${linkSlug} с того же IP перед первым заходом` : `Нажал «Старт» по ссылке ${linkSlug}`) + ' вскоре после того, как его раздали как органику: ' +
      `переведён от ${await staffName(was.owner_id)} к ${await staffName(ownerId)} (${how})`);
  } else if (was && linkId && was.link_id !== linkId) {
    await leadLog(tgId, 'restart', (byIp ? `Найден переход по ссылке ${linkSlug} с того же IP перед первым заходом. ` : `Снова нажал «Старт» по ссылке ${linkSlug}. `) +
      (was.link_id == null ? 'Ссылки у него не было — записана эта. ' : 'Ссылка остаётся первой, по которой он пришёл. ') +
      (was.owner_id == null ? (ownerId ? `Владелец: ${await staffName(ownerId)} (${how})` : 'Владельца по-прежнему нет') : `Владелец не меняется: ${await staffName(was.owner_id)}`));
  }
  // Лид мог быть заведён вручную из постбеков (только Telegram ID и Pocket ID): дописываем юзернейм, имя, ссылку и владельца
  await db.query(
    `UPDATE leads SET username = coalesce($2, username), first_name = coalesce($3, first_name), link_id = coalesce(link_id, $4), owner_id = coalesce(owner_id, $5) WHERE tg_id = $1`,
    [tgId, username ?? null, firstName ?? null, linkId, ownerId],
  );
  await db.query(`INSERT INTO events (tg_id, type) SELECT $1, 'start' WHERE NOT EXISTS (SELECT 1 FROM events WHERE tg_id = $1 AND type = 'start')`, [tgId]);
  const cur = await db.query('SELECT * FROM leads WHERE tg_id = $1', [tgId]);
  return { lead: cur.rows[0], isNew: false };
}

/** Кому отдать лида со ссылки «Случайно». Среди сотрудников ссылки (активных): у кого сегодня (по Киеву) меньше лидов с этой ссылки,
 *  при равенстве — у кого больше часов в эфире за месяц, затем больше FTD за месяц, затем FTD за прошлый месяц. Так за день каждый получает по одному от лучшего
 *  к худшему, потом круг повторяется. Выбор записывается, чтобы очередь знала, кто уже получил */
export async function pickRotationOwner(rootLinkId: number, tgId: number): Promise<number | null> {
  const id = await rankPool(`SELECT staff_id FROM link_pool WHERE link_id = $1`, `SELECT count(*)::int FROM link_assign a WHERE a.link_id = $1 AND a.staff_id = s.id`, rootLinkId);
  if (id) await db.query('INSERT INTO link_assign (link_id, staff_id, tg_id) VALUES ($1,$2,$3)', [rootLinkId, id, tgId]);
  return id;
}

/** Владелец нового лида из органики по настройкам Office: не закреплять, один сотрудник или по очереди из списка */
export async function pickOrganicOwner(kind: 'org' | 'site', tgId: number): Promise<number | null> {
  const st = (await db.query('SELECT mode, owner_id FROM organic_settings WHERE kind = $1', [kind])).rows[0];
  if (!st || st.mode === 'none') return null;
  if (st.mode === 'owner') return (await db.query('SELECT id FROM staff WHERE id = $1 AND active AND deleted_at IS NULL', [st.owner_id])).rows[0]?.id ?? null;
  const id = await rankPool(`SELECT unnest(pool) FROM organic_settings WHERE kind = $1`, `SELECT count(*)::int FROM organic_assign a WHERE a.kind = $1 AND a.staff_id = s.id`, kind);
  if (id) await db.query('INSERT INTO organic_assign (kind, staff_id, tg_id) VALUES ($1,$2,$3)', [kind, id, tgId]);
  return id;
}

/** Запасной владелец: если ни ссылка, ни «Органика», ни реферал не дали владельца, лид уходит по очереди всем активным стримерам
 *  (кто меньше получил сегодня → больше часов → больше FTD за месяц). Так незакреплённых лидов не остаётся */
export async function pickFallbackOwner(tgId: number): Promise<number | null> {
  const id = await rankPool(`SELECT id FROM staff WHERE $1::text IS NOT NULL`, `SELECT count(*)::int FROM organic_assign a WHERE a.kind = $1 AND a.staff_id = s.id`, 'any');
  if (id) await db.query('INSERT INTO organic_assign (kind, staff_id, tg_id) VALUES ($1,$2,$3)', ['any', id, tgId]);
  return id;
}

/** Очередь: меньше получил сегодня (по Киеву) → больше часов в эфире за месяц → больше FTD за месяц →
 *  больше FTD за прошлый месяц (затем их сумма) → при полном равенстве случайно */
async function rankPool(poolSql: string, todaySql: string, key: unknown): Promise<number | null> {
  const TZ = "'Europe/Kyiv'";
  const r = await db.query(
    `SELECT s.id,
            (${todaySql} AND (a.at AT TIME ZONE ${TZ})::date = (now() AT TIME ZONE ${TZ})::date) AS today,
            (SELECT coalesce(sum(r.approved_min), 0)::int FROM shift_reports r WHERE r.staff_id = s.id AND NOT r.team AND r.status = 'approved'
               AND to_char(r.day, 'YYYY-MM') = to_char(now() AT TIME ZONE ${TZ}, 'YYYY-MM')) AS mins,
            (SELECT count(*)::int FROM events e JOIN leads d ON d.tg_id = e.tg_id WHERE d.owner_id = s.id AND e.type = 'ftd'
               AND to_char(e.created_at AT TIME ZONE ${TZ}, 'YYYY-MM') = to_char(now() AT TIME ZONE ${TZ}, 'YYYY-MM')) AS ftd,
            -- Результат прошлого месяца: решает в начале месяца, когда часов и FTD за новый месяц ещё ни у кого нет
            pm.n AS prev_ftd, pm.s AS prev_sum
       FROM staff s
       CROSS JOIN LATERAL (SELECT count(*)::int AS n, coalesce(sum(e.amount), 0)::float AS s FROM events e JOIN leads d ON d.tg_id = e.tg_id
               WHERE d.owner_id = s.id AND e.type = 'ftd'
                 AND to_char(e.created_at AT TIME ZONE ${TZ}, 'YYYY-MM') = to_char((now() AT TIME ZONE ${TZ}) - interval '1 month', 'YYYY-MM')) pm
      WHERE s.id IN (${poolSql}) AND s.role = 'streamer' AND s.active AND s.deleted_at IS NULL
      ORDER BY today ASC, mins DESC, ftd DESC, prev_ftd DESC, prev_sum DESC, random() LIMIT 1`,
    [key],
  );
  return (r.rows[0]?.id as number | undefined) ?? null;
}
