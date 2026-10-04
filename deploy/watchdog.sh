#!/usr/bin/env bash
# Сторож сервера Hunter. Запускается из cron каждые 5 минут и пишет в ту же группу Telegram, что и копии базы.
# Работает отдельно от приложения, поэтому сообщит и тогда, когда приложение упало.
# Сообщения: проблема (сразу, когда подтвердилась), «всё снова работает», раз в день в 09:00 по Киеву краткая сводка.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/hunter}"
STATE_DIR="${STATE_DIR:-/var/lib/hunter-watch}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/hunter}"
LOCAL_URL="${LOCAL_URL:-http://127.0.0.1:3000/health}"
DISK_WARN="${DISK_WARN:-85}"            # диск заполнен на, % и выше
MEM_WARN_MB="${MEM_WARN_MB:-150}"       # свободной памяти меньше, МБ
BACKUP_MAX_HOURS="${BACKUP_MAX_HOURS:-26}"
REMIND_HOURS="${REMIND_HOURS:-6}"       # напоминать о незакрытой проблеме раз в столько часов
API="${TG_API:-https://api.telegram.org}"
mkdir -p "$STATE_DIR"

env_val() { grep -E "^$1=" "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r"' || true; }
TG_TOKEN="${BOT_TOKEN:-$(env_val BOT_TOKEN)}"
TG_CHAT="${ALERT_TG_CHAT_ID:-$(env_val ALERT_TG_CHAT_ID)}"
if [ -z "$TG_CHAT" ]; then TG_CHAT="${BACKUP_TG_CHAT_ID:-$(env_val BACKUP_TG_CHAT_ID)}"; fi
TG_THREAD="${ALERT_TG_THREAD_ID:-${BACKUP_TG_THREAD_ID:-$(env_val BACKUP_TG_THREAD_ID)}}"
# Адрес для проверки «снаружи» (через Cloudflare): PUBLIC_URL из .env, если это https
EXT_URL="${PUBLIC_CHECK_URL:-}"
if [ -z "$EXT_URL" ]; then
  PUBLIC_URL="$(env_val PUBLIC_URL)"
  case "$PUBLIC_URL" in https://*) EXT_URL="${PUBLIC_URL%/}/health" ;; esac
fi

send() {
  [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ] || return 0
  curl -sS --max-time 30 -o /dev/null "$API/bot$TG_TOKEN/sendMessage" -d "chat_id=$TG_CHAT" ${TG_THREAD:+-d "message_thread_id=$TG_THREAD"} --data-urlencode "text=$1" >/dev/null 2>&1 || true
}
now() { date +%s; }
get() { cat "$STATE_DIR/$1" 2>/dev/null || echo "$2"; }
put() { printf '%s' "$2" > "$STATE_DIR/$1"; }

# ---- замеры ----
http_code() { curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || echo 000; }
LOCAL_CODE="$(http_code "$LOCAL_URL")"
EXT_CODE=""; [ -n "$EXT_URL" ] && EXT_CODE="$(http_code "$EXT_URL")"
DISK_PCT="${FAKE_DISK_PCT:-$(df -P / | awk 'NR==2{gsub("%","",$5);print $5}')}"
DISK_FREE_MB="${FAKE_DISK_FREE_MB:-$(df -Pm / | awk 'NR==2{print $4}')}"
MEM_MB="${FAKE_MEM_MB:-$(free -m | awk '/^Mem:/{print $7}')}"
LAST_BACKUP_EPOCH="$(find "$BACKUP_DIR" -maxdepth 1 -name 'hunter_*.sql.gz' -printf '%T@\n' 2>/dev/null | sort -n | tail -1 | cut -d. -f1)"
LAST_BACKUP_TXT="ещё не было"
[ -n "$LAST_BACKUP_EPOCH" ] && LAST_BACKUP_TXT="$(TZ=Europe/Kyiv date -d "@$LAST_BACKUP_EPOCH" '+%d.%m %H:%M')"

NEW=""; REMIND=""; RECOVERED=""; BAD_NOW=0
# check ключ ok(1/0) подтверждений_подряд сообщение_о_проблеме название_для_восстановления
check() {
  local key="$1" ok="$2" need="$3" msg="$4" name="$5"
  local st fails last
  st="$(get "$key.st" ok)"; fails="$(get "$key.fails" 0)"; last="$(get "$key.last" 0)"
  if [ "$ok" = 1 ]; then
    [ "$st" = bad ] && RECOVERED="$RECOVERED
✔ $name"
    put "$key.st" ok; put "$key.fails" 0
  else
    fails=$((fails + 1)); put "$key.fails" "$fails"
    if [ "$st" = bad ]; then
      BAD_NOW=1
      if [ $(( $(now) - last )) -ge $((REMIND_HOURS * 3600)) ]; then REMIND="$REMIND
$msg"; put "$key.last" "$(now)"; fi
    elif [ "$fails" -ge "$need" ]; then
      BAD_NOW=1; put "$key.st" bad; put "$key.last" "$(now)"; NEW="$NEW
$msg"
    fi
  fi
}

# Приложение: проверка изнутри сервера (в ответе /health есть запрос к базе)
check app "$([ "$LOCAL_CODE" = 200 ] && echo 1 || echo 0)" 2 "🔴 Приложение не отвечает (сайт, мини-апп и бот не работают)" "приложение снова отвечает"
# Снаружи через Cloudflare: если приложение уже упало, это то же самое, отдельно не пишем
if [ -n "$EXT_URL" ]; then
  if [ "$LOCAL_CODE" = 200 ]; then
    check ext "$([ "$EXT_CODE" = 200 ] && echo 1 || echo 0)" 2 "🌐 Сайт снаружи не открывается (ответ $EXT_CODE) — проверь Cloudflare и домен" "сайт снаружи открывается"
  fi
fi
check disk "$([ "$DISK_PCT" -lt "$DISK_WARN" ] && echo 1 || echo 0)" 1 "💾 Диск заполнен на ${DISK_PCT}%, свободно ${DISK_FREE_MB} МБ. Нужно почистить место или увеличить диск, иначе база перестанет писаться" "места на диске достаточно"
check mem "$([ "$MEM_MB" -ge "$MEM_WARN_MB" ] && echo 1 || echo 0)" 2 "🧠 Мало свободной памяти: ${MEM_MB} МБ" "памяти достаточно"
BACKUP_OK=1
if [ -z "$LAST_BACKUP_EPOCH" ]; then
  # Пока копий нет вообще, молчим первые сутки после установки
  [ -f "$STATE_DIR/installed" ] || put installed "$(now)"
  [ $(( $(now) - $(get installed "$(now)") )) -ge $((BACKUP_MAX_HOURS * 3600)) ] && BACKUP_OK=0
else
  [ $(( $(now) - LAST_BACKUP_EPOCH )) -ge $((BACKUP_MAX_HOURS * 3600)) ] && BACKUP_OK=0
fi
check backup "$BACKUP_OK" 1 "📦 Копия базы не создавалась больше суток (последняя: $LAST_BACKUP_TXT)" "копии базы снова создаются"

# ---- сообщения ----
if [ -n "$NEW$REMIND" ]; then
  send "⚠️ Hunter: проблема на сервере$NEW$REMIND"
fi
if [ -n "$RECOVERED" ]; then
  if [ "$BAD_NOW" = 0 ]; then send "✅ Hunter: всё снова работает.$RECOVERED"; else send "✅ Hunter: часть проблем решена.$RECOVERED"; fi
fi

# Сводка раз в день в 09:00 по Киеву, если всё в порядке
HOUR="$(TZ=Europe/Kyiv date +%H)"; MIN="$(TZ=Europe/Kyiv date +%M)"; TODAY="$(TZ=Europe/Kyiv date +%F)"
if { [ "${FORCE_SUMMARY:-0}" = 1 ] || { [ "$HOUR" = 09 ] && [ "$MIN" -lt 5 ]; }; } && [ "$BAD_NOW" = 0 ] && [ "$(get summary '')" != "$TODAY" ]; then
  send "🟢 Hunter: всё работает · диск ${DISK_PCT}% · свободно памяти ${MEM_MB} МБ · последняя копия базы $LAST_BACKUP_TXT"
  put summary "$TODAY"
fi
exit 0
