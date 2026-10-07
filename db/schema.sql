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

-- Случайные ссылки под основной: hunterai.space/liza/jhj725hc159n. У такой ссылки свой счётчик и своя статистика, владелец и источник общие
ALTER TABLE links ADD COLUMN IF NOT EXISTS parent_id INT REFERENCES links(id) ON DELETE CASCADE;
ALTER TABLE links ADD COLUMN IF NOT EXISTS token TEXT;
-- Обнуление статистики ссылки: старше этой даты лиды и деньги в «Ссылках» не считаются
ALTER TABLE links ADD COLUMN IF NOT EXISTS reset_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS links_token_uq ON links (token) WHERE token IS NOT NULL;

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
-- Стример, чей эфир показываем на аватарке трейдера (красное кольцо и переход на эфир, пока идёт его смена)
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS staff_id INT REFERENCES staff(id) ON DELETE SET NULL;

-- Отзывы: пишет админ в Hunter Office или клиент в Mini App (клиентские выходят после проверки админом)
CREATE TABLE IF NOT EXISTS reviews (
  id         SERIAL PRIMARY KEY,
  tg_id      BIGINT REFERENCES leads(tg_id) ON DELETE SET NULL,
  author     TEXT NOT NULL,
  rating     INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body       TEXT NOT NULL,
  photo      BYTEA,
  photo_type TEXT,
  photo_key  TEXT,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','hidden')),
  by_admin   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reviews_status_idx ON reviews (status, created_at DESC);

-- Шаблоны сообщений, которые бот шлёт сам: новый сигнал и «стример в эфире». Куда и кому, текст, картинка и кнопки настраивает админ
CREATE TABLE IF NOT EXISTS push_templates (
  key        TEXT PRIMARY KEY,
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  text       TEXT NOT NULL DEFAULT '',
  buttons    JSONB NOT NULL DEFAULT '[]',
  segment    TEXT NOT NULL DEFAULT 'all',
  channels   JSONB NOT NULL DEFAULT '[]',
  photo      BYTEA,
  photo_type TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Канал самого стримера: пуш «стример в эфире» может уходить и в него. Основной канал команды задаётся в самом шаблоне
ALTER TABLE staff ADD COLUMN IF NOT EXISTS live_channel TEXT;
ALTER TABLE push_templates ADD COLUMN IF NOT EXISTS to_staff_channel BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS photo BYTEA;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS photo_type TEXT;

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
ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_name TEXT;
-- Начало эфира, которое стример указал в отчёте (по Киеву, хранится как момент времени)
-- Админ закрыл чат: он скрыт из списка, пока клиент не напишет снова
ALTER TABLE leads ADD COLUMN IF NOT EXISTS chat_closed_at TIMESTAMPTZ;
-- Сотрудник (админ) тоже стримит: смены, отчёты, часы и зарплата считаются как у стримера
ALTER TABLE staff ADD COLUMN IF NOT EXISTS streams BOOLEAN NOT NULL DEFAULT FALSE;
-- Свой порядок и папки бокового меню (у каждого сотрудника)
ALTER TABLE staff ADD COLUMN IF NOT EXISTS nav_layout JSONB;
CREATE TABLE IF NOT EXISTS nav_defaults (role TEXT PRIMARY KEY, layout JSONB NOT NULL);
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS declared_start TIMESTAMPTZ;
-- 'await': смену закрыл админ без отчёта, данные должен внести сам стример
ALTER TABLE shift_reports DROP CONSTRAINT IF EXISTS shift_reports_status_check;
ALTER TABLE shift_reports ADD CONSTRAINT shift_reports_status_check CHECK (status IN ('live','await','pending','approved','rejected'));

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
ALTER TABLE push_rules DROP CONSTRAINT IF EXISTS push_rules_trigger_check;
ALTER TABLE push_rules ADD CONSTRAINT push_rules_trigger_check CHECK (trigger IN ('start','no_reg','no_deposit','ftd','inactive','withdrawal'));
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

-- Бухгалтерия стримеров: KPI, смены и отчёты, бонусы и штрафы, выплаты и авансы
CREATE TABLE IF NOT EXISTS kpi_settings (
  id   INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);
INSERT INTO kpi_settings (id, data) VALUES (1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING;

-- Поля формы отчёта о смене: настраивает админ
CREATE TABLE IF NOT EXISTS report_fields (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'number' CHECK (kind IN ('number','text','link')),
  required     BOOLEAN NOT NULL DEFAULT FALSE,
  on_dashboard BOOLEAN NOT NULL DEFAULT FALSE,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort         INT NOT NULL DEFAULT 0
);
INSERT INTO report_fields (name, kind, required, on_dashboard, sort)
  SELECT v.name, 'number', v.req, TRUE, v.sort FROM (VALUES ('Просмотры', TRUE, 1), ('Подписчики', TRUE, 2), ('Комментарии', FALSE, 3), ('Лайки', FALSE, 4)) AS v(name, req, sort)
   WHERE NOT EXISTS (SELECT 1 FROM report_fields);

-- Смены: стример начинает со ссылкой на эфир, заканчивает отчётом; админ зачитывает
CREATE TABLE IF NOT EXISTS shift_reports (
  id              SERIAL PRIMARY KEY,
  staff_id        INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','pending','approved','rejected')),
  stream_url      TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  day             DATE NOT NULL,                 -- день по Киеву, к которому относится смена
  declared_min    INT,                           -- время, которое указал стример
  approved_min    INT,                           -- время, которое зачёл админ
  fields          JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{name, kind, value}] на момент отправки
  comment         TEXT,
  screenshot      BYTEA,
  screenshot_type TEXT,
  reviewed_by     INT REFERENCES staff(id),
  reviewed_at     TIMESTAMPTZ,
  reject_reason   TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shift_reports_staff ON shift_reports(staff_id, day);
CREATE INDEX IF NOT EXISTS shift_reports_status ON shift_reports(status);

-- Бонусы и штрафы: комментарий видит только админ
CREATE TABLE IF NOT EXISTS staff_adjustments (
  id         SERIAL PRIMARY KEY,
  staff_id   INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  period     TEXT NOT NULL,                      -- 'YYYY-MM'
  kind       TEXT NOT NULL CHECK (kind IN ('bonus','penalty')),
  amount     NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  comment    TEXT,
  created_by INT REFERENCES staff(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_adjustments_period ON staff_adjustments(staff_id, period);

-- Выплаты и запросы аванса
CREATE TABLE IF NOT EXISTS staff_payouts (
  id         SERIAL PRIMARY KEY,
  staff_id   INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  period     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('advance','final','extra')),
  amount     NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  note       TEXT,
  created_by INT REFERENCES staff(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS staff_payouts_period ON staff_payouts(staff_id, period);
CREATE TABLE IF NOT EXISTS advance_requests (
  id         SERIAL PRIMARY KEY,
  staff_id   INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  period     TEXT NOT NULL,
  amount     NUMERIC(12,2) NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','rejected')),
  created_at TIMESTAMPTZ DEFAULT now(),
  decided_by INT REFERENCES staff(id),
  decided_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS advance_once ON advance_requests(staff_id, period) WHERE status <> 'rejected';

-- Невыполненный план за день: стример пишет причину, админ читает
CREATE TABLE IF NOT EXISTS shift_shortfalls (
  id         SERIAL PRIMARY KEY,
  staff_id   INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  day        DATE NOT NULL,
  minutes    INT NOT NULL DEFAULT 0,
  reason     TEXT,
  reason_at  TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (staff_id, day)
);

-- Расходы компании: админ записывает вручную, сумма в долларах и комментарий. Идут в чистую прибыль на дашборде
CREATE TABLE IF NOT EXISTS expenses (
  id         SERIAL PRIMARY KEY,
  day        DATE NOT NULL,                      -- день расхода по Киеву
  amount     NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  comment    TEXT NOT NULL,
  created_by INT REFERENCES staff(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expenses_day ON expenses(day);

-- Журнал кликов по ссылкам: нужен, чтобы дашборд считал клики за период (links.clicks остаётся общим счётчиком)
CREATE TABLE IF NOT EXISTS link_clicks (
  id      BIGSERIAL PRIMARY KEY,
  link_id INT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Подробности клика для аналитики по ссылке (у старых кликов их нет)
ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS device TEXT;
ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS os TEXT;
ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS browser TEXT;
ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS referrer TEXT;
CREATE INDEX IF NOT EXISTS link_clicks_at ON link_clicks(at);
CREATE INDEX IF NOT EXISTS link_clicks_link ON link_clicks(link_id, at);

-- Задачи сотрудникам: ставит админ, сотрудник отмечает выполненной, админ принимает или возвращает
CREATE TABLE IF NOT EXISTS staff_tasks (
  id          SERIAL PRIMARY KEY,
  staff_id    INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  details     TEXT,
  due         DATE,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','accepted')),
  created_by  INT REFERENCES staff(id),
  created_at  TIMESTAMPTZ DEFAULT now(),
  done_at     TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS staff_tasks_staff ON staff_tasks(staff_id, status);

-- Закрытие месяца: фиксируем начисления стримерам, чтобы смена ставок и планов не меняла прошлое
CREATE TABLE IF NOT EXISTS month_closes (
  period    TEXT PRIMARY KEY,                    -- 'YYYY-MM'
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by INT REFERENCES staff(id),            -- NULL: закрыт автоматически
  plan      JSONB NOT NULL                       -- KPI-план на момент закрытия
);
CREATE TABLE IF NOT EXISTS kpi_closed (
  period   TEXT NOT NULL REFERENCES month_closes(period) ON DELETE CASCADE,
  staff_id INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  data     JSONB NOT NULL,                       -- расчёт KPI на момент закрытия
  PRIMARY KEY (period, staff_id)
);
-- Месяц, который админ открыл заново: автоматически его больше не закрываем, только вручную
CREATE TABLE IF NOT EXISTS month_holds (period TEXT PRIMARY KEY);

-- 2FA (TOTP): подтверждённый секрет, ожидающий подтверждения, последний использованный шаг, хэши резервных кодов
ALTER TABLE staff ADD COLUMN IF NOT EXISTS totp_secret   TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS totp_pending  TEXT;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS totp_last     BIGINT NOT NULL DEFAULT 0;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS recovery_codes TEXT[] NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS login_challenges (
  token_hash TEXT PRIMARY KEY,
  staff_id   INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  tries      INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL
);

-- Лид снят с миниапп (доступ отозван), но события и постбеки остаются: по ним считаются зарплаты
ALTER TABLE leads ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

-- Один раз: все лиды с депозитом получают доступ к миниапп (дальше его выдаёт постбек автоматически)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_flags WHERE key = 'ftd_access_backfill') THEN
    UPDATE leads SET access = TRUE WHERE status IN ('ftd','active') AND NOT coalesce(access, FALSE) AND removed_at IS NULL;
    INSERT INTO app_flags (key) VALUES ('ftd_access_backfill');
  END IF;
END $$;

-- Связь записи журнала с событием: чтобы можно было удалить постбек вместе с деньгами
ALTER TABLE postback_log ADD COLUMN IF NOT EXISTS event_id BIGINT;

-- Меню админов общее: берём уже настроенную раскладку первого админа, у которого она есть
INSERT INTO nav_defaults (role, layout)
  SELECT 'admin', nav_layout FROM staff WHERE role = 'admin' AND nav_layout IS NOT NULL ORDER BY id LIMIT 1
  ON CONFLICT (role) DO NOTHING;

-- Один раз: лиды из старого бота (есть додепы или комиссия, но нет FTD) становятся «активными» и получают доступ
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_flags WHERE key = 'legacy_leads_active') THEN
    UPDATE leads SET status = 'active', access = TRUE
     WHERE removed_at IS NULL AND status IN ('new','registered','ftd')
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.tg_id = leads.tg_id AND e.type = 'ftd')
       AND EXISTS (SELECT 1 FROM events e WHERE e.tg_id = leads.tg_id AND (e.type = 'dep' OR (e.type = 'comm' AND e.amount > 0)));
    INSERT INTO app_flags (key) VALUES ('legacy_leads_active');
  END IF;
END $$;

-- Один раз: у лидов, заведённых вручную из постбеков, дата «Пришёл» берётся с их первого события
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_flags WHERE key = 'manual_leads_created_at') THEN
    UPDATE leads SET created_at = e.m
      FROM (SELECT tg_id, min(created_at) AS m FROM events GROUP BY tg_id) e
     WHERE e.tg_id = leads.tg_id AND leads.bot_started IS NOT TRUE AND leads.username IS NULL AND e.m < leads.created_at;
    INSERT INTO app_flags (key) VALUES ('manual_leads_created_at');
  END IF;
END $$;

-- Невыполненные дни: админ принимает причину или выписывает штраф (комментарий штрафа видит стример)
ALTER TABLE staff_adjustments ADD COLUMN IF NOT EXISTS visible BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE shift_shortfalls ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE shift_shortfalls ADD COLUMN IF NOT EXISTS penalty_id INT REFERENCES staff_adjustments(id) ON DELETE SET NULL;

-- Тестовые сигналы и демо-история больше не используются: убираем те, по которым нет сделок клиентов
DELETE FROM signals s WHERE s.requested_by IS NULL AND (s.is_test OR s.demo_result IS NOT NULL OR s.source = 'test') AND NOT EXISTS (SELECT 1 FROM deals x WHERE x.signal_id = s.id);

-- Админ всегда считается в общих показателях (признак «тоже стример» больше не настраивается)
UPDATE staff SET streams = TRUE WHERE role = 'admin' AND NOT streams;

-- Бонус стримеру за додепы лида: лид достигает градации по сумме депозитов, стример запрашивает бонус (сообщение и скрин), админ принимает
CREATE TABLE IF NOT EXISTS dep_bonus_requests (
  id              SERIAL PRIMARY KEY,
  tg_id           BIGINT NOT NULL REFERENCES leads(tg_id) ON DELETE CASCADE,
  staff_id        INT NOT NULL REFERENCES staff(id),
  tier            INT NOT NULL CHECK (tier BETWEEN 1 AND 4),
  amount          NUMERIC(12,2) NOT NULL,
  message         TEXT NOT NULL,
  screenshot      BYTEA,
  screenshot_type TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  period          TEXT,
  reject_reason   TEXT,
  decided_by      INT REFERENCES staff(id),
  decided_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS dep_bonus_one ON dep_bonus_requests (tg_id, tier) WHERE status <> 'rejected';
CREATE INDEX IF NOT EXISTS dep_bonus_status ON dep_bonus_requests (status, created_at);

-- Второй (и следующие) Pocket ID одного человека: у лида в leads.trader_id основной, остальные здесь
CREATE TABLE IF NOT EXISTS lead_pockets (
  trader_id  TEXT PRIMARY KEY,
  tg_id      BIGINT NOT NULL REFERENCES leads(tg_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_pockets_tg ON lead_pockets(tg_id);

-- Починка статусов: лид с додепом не может оставаться в статусе FTD (раньше поздний FTD мог понизить «Активного»)
UPDATE leads SET status = 'active' WHERE status = 'ftd' AND EXISTS (SELECT 1 FROM events e WHERE e.tg_id = leads.tg_id AND e.type = 'dep');
