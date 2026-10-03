-- Люди из команды: админ, тимлидер, стример, медиабайер
CREATE TABLE IF NOT EXISTS staff (
  id          SERIAL PRIMARY KEY,
  login       TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin','teamlead','streamer','buyer','analyst')),
  parent_id   INT REFERENCES staff(id),       -- тимлидер для стримера
  rate_ftd    NUMERIC(12,2) DEFAULT 0,        -- ставка за FTD
  rate_percent NUMERIC(5,2) DEFAULT 0,        -- процент от депозитов
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Реферальные ссылки: /s/<slug> ведёт в бота с параметром s_<slug>
CREATE TABLE IF NOT EXISTS links (
  id        SERIAL PRIMARY KEY,
  slug      TEXT UNIQUE NOT NULL,
  owner_id  INT NOT NULL REFERENCES staff(id),
  source    TEXT,
  campaign  TEXT,
  clicks    INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Лиды: первый закреплённый владелец не меняется сам
CREATE TABLE IF NOT EXISTS leads (
  tg_id      BIGINT PRIMARY KEY,
  username   TEXT,
  first_name TEXT,
  link_id    INT REFERENCES links(id),
  owner_id   INT REFERENCES staff(id),        -- стример или медиабайер
  status     TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','registered','ftd','active','churned')),
  access     BOOLEAN DEFAULT FALSE,           -- открыт ли анализ
  created_at TIMESTAMPTZ DEFAULT now()
);

-- События: старт, регистрация, депозит, вывод. external_id защищает от дублей постбека
CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  tg_id       BIGINT NOT NULL REFERENCES leads(tg_id),
  type        TEXT NOT NULL CHECK (type IN ('start','reg','ftd','dep','wd')),
  amount      NUMERIC(12,2),
  external_id TEXT UNIQUE,
  raw         JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_tg ON events(tg_id, created_at);

-- Сессии входа в Office. В базе хранится только хеш токена
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  staff_id   INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Журнал входящих постбеков для отладки. Секрет в журнал не попадает
CREATE TABLE IF NOT EXISTS postback_log (
  id         BIGSERIAL PRIMARY KEY,
  event      TEXT,
  query      JSONB,
  tg_id      BIGINT,
  result     TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ID трейдера в Pocket Option: приходит с регистрацией, потом по нему находим лида
ALTER TABLE leads ADD COLUMN IF NOT EXISTS trader_id TEXT;
CREATE INDEX IF NOT EXISTS leads_trader ON leads(trader_id);

-- Добавляем тип события comm: комиссия, которую платит Pocket Option
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_type_check;
ALTER TABLE events ADD CONSTRAINT events_type_check CHECK (type IN ('start','reg','ftd','dep','wd','comm'));

-- Своя кампания в Pocket Option у каждого стримера: код (ac), промокод и ссылки регистрации
ALTER TABLE staff ADD COLUMN IF NOT EXISTS po_campaign TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS po_promo    TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS po_link     TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS po_link_ru  TEXT;
-- Telegram-юзернейм менеджера: в профиле клиента это кликабельная ссылка
ALTER TABLE staff ADD COLUMN IF NOT EXISTS tg_username TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS staff_po_campaign ON staff (lower(po_campaign)) WHERE po_campaign IS NOT NULL;

-- Mini App: регион клиента, сделки, прогресс тренажёра, медиа
ALTER TABLE leads ADD COLUMN IF NOT EXISTS region TEXT;  -- 'ru' или 'ww'

CREATE TABLE IF NOT EXISTS deals (
  id         SERIAL PRIMARY KEY,
  tg_id      BIGINT NOT NULL REFERENCES leads(tg_id),
  pair       TEXT NOT NULL,
  direction  TEXT NOT NULL CHECK (direction IN ('up','down')),
  expiry_min INT NOT NULL DEFAULT 1,
  result     TEXT CHECK (result IN ('win','loss','skip')),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deals_tg ON deals(tg_id, created_at);

CREATE TABLE IF NOT EXISTS lesson_progress (
  tg_id   BIGINT NOT NULL REFERENCES leads(tg_id),
  lesson  INT NOT NULL,
  done_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (tg_id, lesson)
);

CREATE TABLE IF NOT EXISTS media_items (
  id       SERIAL PRIMARY KEY,
  kind     TEXT NOT NULL CHECK (kind IN ('trader','channel')),
  title    TEXT NOT NULL,
  subtitle TEXT,
  url      TEXT NOT NULL,
  sort     INT DEFAULT 0,
  active   BOOLEAN DEFAULT TRUE
);

ALTER TABLE media_items ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS contact_url TEXT;

-- Чат поддержки через бота: сообщения клиентов и ответы команды
CREATE TABLE IF NOT EXISTS messages (
  id            BIGSERIAL PRIMARY KEY,
  tg_id         BIGINT NOT NULL REFERENCES leads(tg_id),
  direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
  staff_id      INT REFERENCES staff(id),
  kind          TEXT NOT NULL DEFAULT 'text',
  text          TEXT,
  file_id       TEXT,
  tg_message_id BIGINT,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_tg ON messages(tg_id, id);

-- Пуши: бот может писать только тем, кто нажал /start. last_seen_at нужен для «давно не заходил»
ALTER TABLE leads ADD COLUMN IF NOT EXISTS bot_started BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS bot_blocked BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Автоматические пуши по событиям
CREATE TABLE IF NOT EXISTS push_rules (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  trigger      TEXT NOT NULL CHECK (trigger IN ('start','no_reg','no_deposit','ftd','inactive')),
  delay_min    INT NOT NULL DEFAULT 0,
  text         TEXT NOT NULL,
  buttons      JSONB NOT NULL DEFAULT '[]',
  daytime_only BOOLEAN NOT NULL DEFAULT FALSE,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  sort         INT NOT NULL DEFAULT 0,
  starts_at    TIMESTAMPTZ NOT NULL DEFAULT now(),  -- правило не трогает тех, у кого срок наступил раньше
  created_at   TIMESTAMPTZ DEFAULT now()
);
-- Каждое правило отправляется человеку один раз
CREATE TABLE IF NOT EXISTS push_log (
  rule_id INT NOT NULL REFERENCES push_rules(id) ON DELETE CASCADE,
  tg_id   BIGINT NOT NULL,
  status  TEXT NOT NULL,
  error   TEXT,
  sent_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (rule_id, tg_id)
);
-- Ручные рассылки
CREATE TABLE IF NOT EXISTS broadcasts (
  id         SERIAL PRIMARY KEY,
  text       TEXT NOT NULL,
  buttons    JSONB NOT NULL DEFAULT '[]',
  segment    TEXT NOT NULL,
  owner_id   INT,
  created_by INT REFERENCES staff(id),
  total      INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS broadcast_jobs (
  broadcast_id INT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  tg_id        BIGINT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  error        TEXT,
  PRIMARY KEY (broadcast_id, tg_id)
);
CREATE INDEX IF NOT EXISTS broadcast_jobs_pending ON broadcast_jobs(status) WHERE status = 'pending';

-- Сигналы: их публикует человек (аналитик или админ) либо, позже, подключённый движок котировок.
-- Тестовые сигналы видят только тестовые аккаунты
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_tester BOOLEAN DEFAULT FALSE;
-- Роль аккаунта с выданным доступом: показывается как источник сигнала (lead, moder, admin, streamer, analyst, buyer)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_role TEXT NOT NULL DEFAULT 'lead';
CREATE TABLE IF NOT EXISTS signals (
  id         SERIAL PRIMARY KEY,
  pair       TEXT NOT NULL,
  direction  TEXT NOT NULL CHECK (direction IN ('up','down')),
  expiry_min INT NOT NULL,
  entry_at   TIMESTAMPTZ NOT NULL,
  note       TEXT,
  source     TEXT NOT NULL DEFAULT 'analyst' CHECK (source IN ('analyst','test','engine')),
  is_test    BOOLEAN NOT NULL DEFAULT FALSE,
  created_by INT REFERENCES staff(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE deals ADD COLUMN IF NOT EXISTS signal_id INT REFERENCES signals(id);
CREATE UNIQUE INDEX IF NOT EXISTS deals_signal_once ON deals(tg_id, signal_id) WHERE signal_id IS NOT NULL;

-- Тестовая история для просмотра оформления: только для тестовых аккаунтов, итог хранится прямо в сигнале
ALTER TABLE signals ADD COLUMN IF NOT EXISTS demo_result TEXT CHECK (demo_result IN ('win','loss'));

-- Сигналы по запросу клиента: сигнал виден только тому, кто его запросил
ALTER TABLE signals ADD COLUMN IF NOT EXISTS requested_by BIGINT;
-- Пары для запроса сигнала. Направление ставит человек (аналитик) в Office и оно действует ограниченное время
CREATE TABLE IF NOT EXISTS signal_pairs (
  pair         TEXT PRIMARY KEY,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  sort         INT NOT NULL DEFAULT 0,
  payout       INT NOT NULL DEFAULT 92,
  direction    TEXT CHECK (direction IN ('up','down')),
  direction_at TIMESTAMPTZ,
  direction_by INT REFERENCES staff(id)
);
CREATE TABLE IF NOT EXISTS app_flags (key TEXT PRIMARY KEY, set_at TIMESTAMPTZ DEFAULT now());
-- Стартовый набор пар и экспираций кладём один раз, чтобы удалённые в Office не возвращались при каждом старте
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_flags WHERE key = 'signal_pairs_seeded') THEN
    INSERT INTO signal_pairs (pair, sort) VALUES
      ('EUR/USD OTC',1),('GBP/USD OTC',2),('AUD/CHF OTC',3),('AUD/USD OTC',4),('USD/JPY OTC',5),('EUR/JPY OTC',6)
      ON CONFLICT DO NOTHING;
    INSERT INTO app_flags (key) VALUES ('signal_pairs_seeded');
  END IF;
END $$;
-- Экспирации на выбор клиенту: от 3 секунд до 4 часов, список ведётся в Office
CREATE TABLE IF NOT EXISTS signal_expiries (sec INT PRIMARY KEY CHECK (sec BETWEEN 3 AND 14400));
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_flags WHERE key = 'signal_expiries_seeded') THEN
    INSERT INTO signal_expiries (sec) VALUES (5) ON CONFLICT DO NOTHING;
    INSERT INTO app_flags (key) VALUES ('signal_expiries_seeded');
  END IF;
  -- Пока доступна только экспирация 5 секунд. Остальные добавляются в Office
  IF NOT EXISTS (SELECT 1 FROM app_flags WHERE key = 'signal_expiries_only5') THEN
    DELETE FROM signal_expiries WHERE sec <> 5;
    INSERT INTO signal_expiries (sec) VALUES (5) ON CONFLICT DO NOTHING;
    INSERT INTO app_flags (key) VALUES ('signal_expiries_only5');
  END IF;
END $$;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS expiry_sec INT;
-- На каком шаге зашёл плюс: 0 = со входа, 1..3 = с перекрытия
ALTER TABLE deals ADD COLUMN IF NOT EXISTS step INT;
CREATE TABLE IF NOT EXISTS signal_settings (
  id                INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  expiry_min        INT NOT NULL DEFAULT 1,
  enter_in_sec      INT NOT NULL DEFAULT 120,
  direction_ttl_min INT NOT NULL DEFAULT 10,
  cooldown_sec      INT NOT NULL DEFAULT 0
);
INSERT INTO signal_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
-- Новый анализ можно просить сразу после оценки предыдущего: прежняя пауза 180 сек сбрасывается один раз
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_flags WHERE key = 'signal_cooldown_zero') THEN
    UPDATE signal_settings SET cooldown_sec = 0 WHERE cooldown_sec = 180;
    INSERT INTO app_flags (key) VALUES ('signal_cooldown_zero');
  END IF;
END $$;
-- Расписание по часам: вход на entry_second секунде минуты, перекрытия каждые overlap_gap_sec секунд, всего max_events событий
ALTER TABLE signal_settings ADD COLUMN IF NOT EXISTS entry_second   INT NOT NULL DEFAULT 15;
ALTER TABLE signal_settings ADD COLUMN IF NOT EXISTS overlap_gap_sec INT NOT NULL DEFAULT 30;
ALTER TABLE signal_settings ADD COLUMN IF NOT EXISTS max_events     INT NOT NULL DEFAULT 4;
ALTER TABLE signal_settings ADD COLUMN IF NOT EXISTS trade_sec      INT NOT NULL DEFAULT 5;
ALTER TABLE signal_settings ADD COLUMN IF NOT EXISTS overlap_mult   INT NOT NULL DEFAULT 2;
-- Подписи в карточке сигнала, каждая настраивается отдельно
ALTER TABLE signal_settings ADD COLUMN IF NOT EXISTS entry_label    TEXT NOT NULL DEFAULT 'M5 · 0:45';
ALTER TABLE signal_settings ADD COLUMN IF NOT EXISTS trade_label    TEXT NOT NULL DEFAULT '5 SEC';
ALTER TABLE signal_settings ADD COLUMN IF NOT EXISTS stake_label    TEXT NOT NULL DEFAULT '1–3% от депозита';
ALTER TABLE signal_settings ADD COLUMN IF NOT EXISTS warning_text   TEXT NOT NULL DEFAULT 'Вход на 45 секунде, перекрытия на 15, 45, 15 секундах! Максимум 4 события, дальше не идём.';
ALTER TABLE signal_settings ADD COLUMN IF NOT EXISTS pocket_url     TEXT NOT NULL DEFAULT '';
-- Что клиент отметил по сигналу: вход и перекрытия (step 0..3)
CREATE TABLE IF NOT EXISTS signal_steps (
  signal_id  INT NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  tg_id      BIGINT NOT NULL,
  step       INT NOT NULL,
  result     TEXT NOT NULL CHECK (result IN ('win','loss','skip')),
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (signal_id, tg_id, step)
);

-- Режим «Авто» по паре: направление меняется каждую минуту, сигналы только для тестовых аккаунтов и с пометкой ТЕСТ
ALTER TABLE signal_pairs ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT FALSE;

-- Разовая пометка: все сигналы, созданные до запуска, считаются тестовыми (их можно вернуть кнопкой «Сделать обычным» в Office)
CREATE TABLE IF NOT EXISTS app_flags (key TEXT PRIMARY KEY, set_at TIMESTAMPTZ DEFAULT now());
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_flags WHERE key = 'pre_launch_signals_test') THEN
    UPDATE signals SET is_test = TRUE WHERE source <> 'engine';
    INSERT INTO app_flags (key) VALUES ('pre_launch_signals_test');
  END IF;
END $$;

-- Часовой пояс клиента (из Mini App). Пока он неизвестен, время в пушах показываем по Киеву
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tz TEXT;

-- Pocket ID из старого бота: клиент вводит свой в мини-приложении, получает доступ, ID привязывается к его Telegram ID
CREATE TABLE IF NOT EXISTS legacy_ids (
  trader_id  TEXT PRIMARY KEY,
  claimed_by BIGINT,
  claimed_at TIMESTAMPTZ,
  added_at   TIMESTAMPTZ DEFAULT now()
);

-- Карточка сотрудника: личные данные и реквизиты для выплат
ALTER TABLE staff ADD COLUMN IF NOT EXISTS full_name      TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS birth_date     DATE;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS city           TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS payout_method  TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS payout_wallet  TEXT;
