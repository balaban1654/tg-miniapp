# Hunter AI и Hunter Office

Воронка в Telegram Mini App и CRM для команды. План и макеты: `plan.html`, `design.html`.

## Запуск для разработки
1. `cp .env.example .env` и впишите `BOT_TOKEN`, остальное можно оставить.
2. `docker compose up -d` поднимает Postgres со схемой из `db/schema.sql`.
3. `cd server && npm install && npm run dev`.

Ссылка стримера: `PUBLIC_URL/s/<slug>` считает клик и ведёт в бота `?start=s_<slug>`. Первый /start закрепляет лида за владельцем ссылки.

Токен бота хранится только в `.env` и секретах сервера, в git его не добавляем.
