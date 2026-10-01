#!/usr/bin/env bash
# Первичная настройка сервера Ubuntu 24.04. Запускать от root один раз.
set -euo pipefail
DOMAIN="${DOMAIN:-hunterai.space}"

apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
apt-get install -y ca-certificates curl ufw fail2ban nginx openssl git

# Docker и compose
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
systemctl enable --now docker

# Firewall: SSH, HTTP, HTTPS
ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp
ufw --force enable
systemctl enable --now fail2ban

# Самоподписанный сертификат для режима Cloudflare Full (потом заменим на Origin Certificate)
mkdir -p /etc/nginx/ssl
if [ ! -f /etc/nginx/ssl/origin.crt ]; then
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout /etc/nginx/ssl/origin.key -out /etc/nginx/ssl/origin.crt \
    -subj "/CN=$DOMAIN" \
    -addext "subjectAltName=DNS:$DOMAIN,DNS:*.$DOMAIN"
fi

# Nginx: go и api идут в приложение на порту 3000, app и crm пока заглушки
cat > /etc/nginx/sites-available/hunter <<NGINX
server {
  listen 443 ssl;
  server_name go.$DOMAIN api.$DOMAIN;
  ssl_certificate /etc/nginx/ssl/origin.crt;
  ssl_certificate_key /etc/nginx/ssl/origin.key;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$http_cf_connecting_ip;
    proxy_set_header X-Forwarded-Proto https;
  }
}
server {
  listen 443 ssl;
  server_name app.$DOMAIN crm.$DOMAIN;
  ssl_certificate /etc/nginx/ssl/origin.crt;
  ssl_certificate_key /etc/nginx/ssl/origin.key;
  location / { default_type text/plain; return 200 "Hunter: скоро открытие\n"; }
}
server { listen 80 default_server; return 301 https://\$host\$request_uri; }
NGINX
ln -sf /etc/nginx/sites-available/hunter /etc/nginx/sites-enabled/hunter
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

mkdir -p /opt/hunter
echo "Готово. Проверьте: https://app.$DOMAIN"
