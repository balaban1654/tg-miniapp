import { db } from './db.js';

/** Градации лида по сумме всех его депозитов (FTD и додепы) за всё время. За каждую градацию стример может запросить бонус */
export interface DepTier {
  name: string;
  from: number; // сумма депозитов лида от, $
  bonus: number; // бонус стримеру, $
}

export const DEP_TIER_NAMES = ['Бронза', 'Серебро', 'Золото', 'Платина'];
export const DEFAULT_DEP_TIERS: DepTier[] = [
  { name: 'Бронза', from: 50, bonus: 0 },
  { name: 'Серебро', from: 150, bonus: 0 },
  { name: 'Золото', from: 500, bonus: 0 },
  { name: 'Платина', from: 1500, bonus: 0 },
];

export interface DepConfig {
  tiers: DepTier[];
  /** Бонусы действуют для градаций, достигнутых после этой даты (ставится при первом включении бонусов), чтобы не поднимать старых лидов */
  start: string | null;
}

export const normTiers = (raw: unknown): DepTier[] =>
  DEFAULT_DEP_TIERS.map((d, i) => {
    const r = (Array.isArray(raw) ? raw[i] : null) as Partial<DepTier> | null;
    const from = Number(r?.from);
    const bonus = Number(r?.bonus);
    return { name: d.name, from: Number.isFinite(from) && from > 0 ? from : d.from, bonus: Number.isFinite(bonus) && bonus >= 0 ? bonus : d.bonus };
  });

export async function loadDepConfig(): Promise<DepConfig> {
  const row = (await db.query('SELECT data FROM kpi_settings WHERE id = 1')).rows[0];
  const d = (row?.data ?? {}) as { depTiers?: unknown; depStart?: string | null };
  return { tiers: normTiers(d.depTiers), start: d.depStart ?? null };
}

export interface TierState {
  sum: number; // все депозиты лида
  ftd: number; // первый депозит
  reached: number; // самая высокая достигнутая градация 0..4 (по сумме)
  baseline: number; // градация, которую лид взял уже первым депозитом: за неё бонус не платим
  last: number; // самая высокая градация, по которой уже есть запрос (не отклонённый)
  eligible: number; // за какую градацию можно запросить бонус сейчас, 0 если нет
  tiers: { name: string; reached: boolean }[];
}

/** Состояние градаций лида. Бонус платится только за градации выше той, что лид взял первым депозитом, и выше уже запрошенной; если лид перепрыгнул несколько, платим за высшую */
export async function leadTierState(tgId: number, cfg: DepConfig): Promise<TierState> {
  const ev = (await db.query(`SELECT type, amount::float AS amount, created_at FROM events WHERE tg_id = $1 AND type IN ('ftd','dep') ORDER BY created_at, id`, [tgId])).rows as { type: string; amount: number; created_at: Date }[];
  let sum = 0;
  let ftd = 0;
  const at: (Date | null)[] = cfg.tiers.map(() => null);
  for (const e of ev) {
    sum += e.amount || 0;
    if (e.type === 'ftd' && !ftd) ftd = e.amount || 0;
    cfg.tiers.forEach((t, i) => {
      if (!at[i] && sum >= t.from) at[i] = e.created_at;
    });
  }
  if (!ftd && ev.length) ftd = ev[0].amount || 0;
  let reached = 0;
  cfg.tiers.forEach((t, i) => {
    if (sum >= t.from) reached = i + 1;
  });
  let baseline = 0;
  cfg.tiers.forEach((t, i) => {
    if (ftd >= t.from) baseline = i + 1;
  });
  const last = Number((await db.query(`SELECT coalesce(max(tier), 0)::int AS t FROM dep_bonus_requests WHERE tg_id = $1 AND status <> 'rejected'`, [tgId])).rows[0].t);
  const start = cfg.start ? new Date(cfg.start) : null;
  let eligible = 0;
  for (let t = reached; t > Math.max(baseline, last); t--) {
    const tier = cfg.tiers[t - 1];
    const when = at[t - 1];
    if (tier.bonus > 0 && start && when && +when >= +start) {
      eligible = t;
      break;
    }
  }
  return { sum, ftd, reached, baseline, last, eligible, tiers: cfg.tiers.map((t, i) => ({ name: t.name, reached: i < reached })) };
}
