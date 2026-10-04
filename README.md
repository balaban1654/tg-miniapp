# Hunter AI и Hunter Office

Воронка в Telegram Mini App и CRM для команды. План и макеты: `plan.html`, `design.html`.

## Запуск для разработки
1. `cp .env.example .env` и впишите `BOT_TOKEN`, остальное можно оставить.
2. `docker compose up -d` поднимает Postgres со схемой из `db/schema.sql`.
3. `cd server && npm install && npm run dev`.

Ссылка стримера: `PUBLIC_URL/s/<slug>` считает клик и ведёт в бота `?start=s_<slug>`. Первый /start закрепляет лида за владельцем ссылки.

Токен бота хранится только в `.env` и секретах сервера, в git его не добавляем.

## Деплой
Каждый пуш в ветку `claude/telegram-mini-app-funnel-nbqal3` (или `main`) запускает `.github/workflows/deploy.yml`: код копируется на сервер в `/opt/hunter`, обновляется Nginx, пересобирается контейнер. Нужны секреты репозитория `SSH_KEY`, `SSH_HOST`, `SSH_USER`, а на сервере файл `/opt/hunter/.env` (в деплой он не копируется). Схема базы применяется при старте приложения и безопасна для повторного запуска.

## Резервные копии базы
`deploy/backup.sh` ставится деплоем как `/usr/local/bin/hunter-backup` и запускается через cron каждый день в 03:30 по времени сервера.
- Копии лежат в `/var/backups/hunter/hunter_ГГГГ-ММ-ДД_ЧЧММ.sql.gz`, хранятся 14 дней. Журнал: `/var/log/hunter-backup.log`.
- Вручную: `hunter-backup`.
- **В группу Telegram.** Добавьте бота в закрытую группу, отправьте там `/chatid`, впишите число в `/opt/hunter/.env` как `BACKUP_TG_CHAT_ID`. Рекомендуется ещё задать `BACKUP_PASSPHRASE`: тогда файл уходит зашифрованным (в базе хэши паролей сотрудников и реквизиты выплат). Копии больше 47 МБ режутся на части по 45 МБ.
- **Расшифровать:** `openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:ВАШ_ПАРОЛЬ -in hunter_....sql.gz.enc -out hunter.sql.gz`. Если пришли части, сначала склейте: `cat hunter_....enc.* > hunter_....enc`.
- **Восстановить** (на чистую базу): `gunzip -c hunter.sql.gz | docker compose -f docker-compose.prod.yml exec -T db psql -U hunter -d hunter`.
