#!/usr/bin/env bash
# Ежедневная копия базы Hunter. Ставится деплоем в cron (каждый день в 03:30 по серверу).
# Копии лежат в /var/backups/hunter, хранятся 3 дня (все копии и так уходят в группу Telegram). Вручную: hunter-backup
set -euo pipefail

DIR="${BACKUP_DIR:-/var/backups/hunter}"
KEEP_DAYS="${KEEP_DAYS:-3}"
# Копии «перед изменениями» (деплой с [backup]) храним дольше, но тоже не вечно
KEEP_BEFORE_DAYS="${KEEP_BEFORE_DAYS:-14}"
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
find "$DIR" -maxdepth 1 -name 'before-change_*.sql.gz' -mtime +"$KEEP_BEFORE_DAYS" -delete
# Остатки прерванных прошлых запусков
find "$DIR" -maxdepth 1 \( -name '*.part' -o -name '*.enc' \) -mmin +60 -delete
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
  CAP="Копия базы Hunter, $(date '+%d.%m.%Y %H:%M')${PASS:+, зашифрована}"
  NAME="$(basename "$OUT")${PASS:+.enc}"
  SIZE="$(stat -c %s "$OUT")"
  # Размер после шифрования известен заранее: заголовок 16 байт + данные, дополненные до блока 16 байт
  if [ -n "$PASS" ]; then ENC_SIZE=$(( 16 + (SIZE / 16 + 1) * 16 )); else ENC_SIZE=$SIZE; fi
  stream() { # копия как есть или зашифрованная, в stdout, без промежуточного файла на диске
    if [ -n "$PASS" ]; then BACKUP_PASSPHRASE="$PASS" openssl enc -aes-256-cbc -pbkdf2 -salt -pass env:BACKUP_PASSPHRASE -in "$OUT"; else cat "$OUT"; fi
  }
  # Telegram принимает файлы до 50 МБ: большую копию режем на части по 45 МБ прямо в отправку,
  # каждая часть уходит сразу и на диск не пишется. Собрать обратно: cat <файлы по порядку> > копия
  CHUNK=47185920
  if [ "$ENC_SIZE" -gt 47000000 ]; then
    N=$(( (ENC_SIZE + CHUNK - 1) / CHUNK ))
    FAILF="$(mktemp)"; rm -f "$FAILF"
    export TG_TOKEN TG_CHAT TG_THREAD API CAP N FAILF
    stream | split -b "$CHUNK" -d -a 2 --filter='I=$(expr "${FILE##*.}" + 1)
      code=$(curl -sS --max-time 300 -o "$FAILF.resp" -w "%{http_code}" "$API/bot$TG_TOKEN/sendDocument" -F "chat_id=$TG_CHAT" ${TG_THREAD:+-F "message_thread_id=$TG_THREAD"} -F "caption=$CAP, часть $I из $N" -F "document=@-;filename=$(basename "$FILE")") || code=000
      [ "$code" = 200 ] || { echo "Часть $I не отправлена в Telegram (код $code): $(cat "$FAILF.resp" 2>/dev/null)" >&2; touch "$FAILF"; }
      rm -f "$FAILF.resp"' - "$NAME."
    if [ -e "$FAILF" ]; then rm -f "$FAILF"; else echo "Копия отправлена в Telegram частями: $N"; fi
  else
    SEND="$OUT"
    if [ -n "$PASS" ]; then SEND="$DIR/$NAME"; stream > "$SEND"; fi
    code="$(curl -sS --max-time 300 -o /tmp/hunter_tg_resp -w '%{http_code}' "$API/bot$TG_TOKEN/sendDocument" \
      -F "chat_id=$TG_CHAT" ${TG_THREAD:+-F "message_thread_id=$TG_THREAD"} -F "caption=$CAP" -F "document=@$SEND")" || code=000
    if [ "$code" = 200 ]; then echo "Копия отправлена в Telegram"; else echo "Не удалось отправить копию в Telegram (код $code): $(cat /tmp/hunter_tg_resp 2>/dev/null)" >&2; fi
    if [ -n "$PASS" ]; then rm -f "$SEND"; fi
    rm -f /tmp/hunter_tg_resp
  fi
fi
