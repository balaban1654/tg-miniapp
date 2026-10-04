#!/usr/bin/env bash
# Ежедневная копия базы Hunter. Ставится деплоем в cron (каждый день в 03:30 по серверу).
# Копии лежат в /var/backups/hunter, хранятся 14 дней. Скрипт можно запускать вручную: hunter-backup
set -euo pipefail

DIR="${BACKUP_DIR:-/var/backups/hunter}"
KEEP_DAYS="${KEEP_DAYS:-14}"
APP_DIR="${APP_DIR:-/opt/hunter}"
# Команда выгрузки можно подменить для проверки скрипта
DUMP_CMD="${DUMP_CMD:-docker compose -f docker-compose.prod.yml exec -T db pg_dump -U hunter -d hunter --no-owner}"

mkdir -p "$DIR"
cd "$APP_DIR"
STAMP="$(date +%F_%H%M)"
TMP="$DIR/hunter_$STAMP.sql.gz.part"
OUT="$DIR/hunter_$STAMP.sql.gz"

# Пишем во временный файл: оборванная выгрузка не заменит хорошую копию
if ! bash -c "$DUMP_CMD" | gzip -9 > "$TMP"; then
  rm -f "$TMP"
  echo "Копия базы не создана: ошибка pg_dump" >&2
  exit 1
fi
# Пустая или слишком маленькая выгрузка это ошибка (в настоящей базе одна схема весит больше)
if [ "$(stat -c %s "$TMP")" -lt 2048 ]; then
  rm -f "$TMP"
  echo "Копия базы подозрительно маленькая, не сохраняю" >&2
  exit 1
fi
gzip -t "$TMP"
mv "$TMP" "$OUT"
chmod 600 "$OUT"

# Старые копии удаляем только после успешной новой
find "$DIR" -maxdepth 1 -name 'hunter_*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "Копия сохранена: $OUT ($(du -h "$OUT" | cut -f1))"

# ---- Отправка копии в группу Telegram (по желанию) ----
# В .env: BACKUP_TG_CHAT_ID (id группы, его показывает команда /chatid в боте), по желанию
# BACKUP_TG_THREAD_ID (тема группы) и BACKUP_PASSPHRASE (шифровать файл перед отправкой).
env_val() { grep -E "^$1=" "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r"' || true; }
TG_TOKEN="${BOT_TOKEN:-$(env_val BOT_TOKEN)}"
TG_CHAT="${BACKUP_TG_CHAT_ID:-$(env_val BACKUP_TG_CHAT_ID)}"
TG_THREAD="${BACKUP_TG_THREAD_ID:-$(env_val BACKUP_TG_THREAD_ID)}"
PASS="${BACKUP_PASSPHRASE:-$(env_val BACKUP_PASSPHRASE)}"
API="${TG_API:-https://api.telegram.org}"

send_part() { # файл, подпись
  curl -sS --max-time 300 -o /tmp/hunter_tg_resp -w '%{http_code}' "$API/bot$TG_TOKEN/sendDocument" \
    -F "chat_id=$TG_CHAT" ${TG_THREAD:+-F "message_thread_id=$TG_THREAD"} -F "caption=$2" -F "document=@$1"
}

if [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ]; then
  SEND="$OUT"
  if [ -n "$PASS" ]; then
    SEND="$OUT.enc"
    BACKUP_PASSPHRASE="$PASS" openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_PASSPHRASE -in "$OUT" -out "$SEND"
  fi
  CAP="Копия базы Hunter, $(date '+%d.%m.%Y %H:%M')${PASS:+, зашифрована}"
  # Telegram принимает файлы до 50 МБ: большую копию режем на части по 45 МБ
  if [ "$(stat -c %s "$SEND")" -gt 47000000 ]; then
    PARTS_DIR="$(mktemp -d)"
    split -b 45M -d "$SEND" "$PARTS_DIR/$(basename "$SEND")."
    N="$(ls "$PARTS_DIR" | wc -l)"; I=0; FAIL=0
    for f in "$PARTS_DIR"/*; do
      I=$((I + 1))
      code="$(send_part "$f" "$CAP, часть $I из $N")" || code=000
      [ "$code" = 200 ] || { FAIL=1; echo "Часть $I не отправлена в Telegram (код $code): $(cat /tmp/hunter_tg_resp 2>/dev/null)" >&2; }
    done
    rm -rf "$PARTS_DIR"
    [ "$FAIL" = 0 ] && echo "Копия отправлена в Telegram частями: $N"
  else
    code="$(send_part "$SEND" "$CAP")" || code=000
    if [ "$code" = 200 ]; then echo "Копия отправлена в Telegram"; else echo "Не удалось отправить копию в Telegram (код $code): $(cat /tmp/hunter_tg_resp 2>/dev/null)" >&2; fi
  fi
  if [ -n "$PASS" ]; then rm -f "$SEND"; fi
  rm -f /tmp/hunter_tg_resp
fi
