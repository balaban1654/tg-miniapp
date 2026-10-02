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
