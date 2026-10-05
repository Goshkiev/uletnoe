#!/usr/bin/env bash
# Установка сайта и сервера заказов кафе «Улётное» на чистый сервер Ubuntu 22.04 / 24.04.
#
#   curl -fsSL https://raw.githubusercontent.com/Goshkiev/uletnoe/main/deploy/install.sh | sudo bash -s -- [домен] [e-mail]
#
# Без домена сайт будет доступен по адресу вида 1-2-3-4.sslip.io (IP сервера через дефисы).
# Скрипт можно запускать повторно, например после покупки домена.
set -euo pipefail

REPO="${REPO:-https://github.com/Goshkiev/uletnoe.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/uletnoe
DATA_DIR=/var/lib/uletnoe
NODE_MAJOR=22
DOMAIN="${1:-}"
EMAIL="${2:-}"

say() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }

IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}')"
[ -n "$DOMAIN" ] || DOMAIN="${IP//./-}.sslip.io"

say "Ставлю системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q nginx certbot python3-certbot-nginx git curl xz-utils ca-certificates

say "Ставлю Node.js ${NODE_MAJOR}"
need_node=1
if command -v node >/dev/null; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' && need_node=0
fi
if [ "$need_node" = 1 ]; then
  arch="$(uname -m)"; case "$arch" in x86_64) arch=x64;; aarch64) arch=arm64;; esac
  for mirror in https://nodejs.org/dist https://npmmirror.com/mirrors/node; do
    file="$(curl -fsS "$mirror/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" 2>/dev/null | awk "/linux-${arch}.tar.xz/ {print \$2}")" || true
    if [ -n "$file" ] && curl -fsSL "$mirror/latest-v${NODE_MAJOR}.x/$file" -o /tmp/node.tar.xz; then break; fi
  done
  [ -s /tmp/node.tar.xz ] || { echo "Не удалось скачать Node.js"; exit 1; }
  rm -rf /usr/local/lib/nodejs && mkdir -p /usr/local/lib/nodejs
  tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs --strip-components=1
  ln -sf /usr/local/lib/nodejs/bin/node /usr/local/bin/node
  rm -f /tmp/node.tar.xz
fi
node --version

say "Скачиваю код"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH"
  git -C "$APP_DIR" reset -q --hard FETCH_HEAD
else
  git clone -q --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

say "Настраиваю сервис заказов"
id uletnoe >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin uletnoe
install -d -o uletnoe -g uletnoe -m 700 "$DATA_DIR"
cat > /etc/uletnoe.env <<ENV
PORT=3000
DATA_DIR=$DATA_DIR
SITE_DIR=$APP_DIR
BRANCH=$BRANCH
RETENTION_DAYS=30
PUSH_SUBJECT=mailto:${EMAIL:-admin@$DOMAIN}
ENV
install -m 644 "$APP_DIR/deploy/uletnoe.service" /etc/systemd/system/uletnoe.service
systemctl daemon-reload
systemctl enable -q uletnoe
systemctl restart uletnoe

say "Настраиваю nginx для $DOMAIN"
sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__ROOT__|$APP_DIR|g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/uletnoe
ln -sf /etc/nginx/sites-available/uletnoe /etc/nginx/sites-enabled/uletnoe
rm -f /etc/nginx/sites-enabled/default
nginx -t -q
systemctl reload nginx
if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow 'Nginx Full' >/dev/null; fi

say "Получаю HTTPS-сертификат"
https=1
if [ -n "$EMAIL" ]; then cert_mail=(-m "$EMAIL"); else cert_mail=(--register-unsafely-without-email); fi
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos "${cert_mail[@]}" --redirect -q || https=0

say "Включаю автообновление с GitHub (раз в 5 минут)"
chmod +x "$APP_DIR/deploy/update.sh"
cat > /etc/cron.d/uletnoe <<CRON
*/5 * * * * root $APP_DIR/deploy/update.sh >> /var/log/uletnoe-update.log 2>&1
CRON

created=""
if [ "$(cd "$APP_DIR/server" && sudo -u uletnoe env DATA_DIR="$DATA_DIR" SITE_DIR="$APP_DIR" node --disable-warning=ExperimentalWarning cli.js list-users)" = "Сотрудников пока нет" ]; then
  created="$(cd "$APP_DIR/server" && for u in kafe manager; do sudo -u uletnoe env DATA_DIR="$DATA_DIR" SITE_DIR="$APP_DIR" node --disable-warning=ExperimentalWarning cli.js add-user "$u"; done)"
fi

sleep 1
curl -fsS "http://127.0.0.1:3000/api/health" >/dev/null && api_ok=yes || api_ok=no
scheme=https; [ "$https" = 1 ] || scheme=http

cat <<DONE

==================================================================
 Готово.
   Меню для гостей:   $scheme://$DOMAIN/
   Экран заказов:     $scheme://$DOMAIN/admin/
   Сервер заказов:    $( [ "$api_ok" = yes ] && echo работает || echo "НЕ ОТВЕЧАЕТ, смотрите: journalctl -u uletnoe" )
$( [ "$https" = 1 ] || echo "   HTTPS не получен: проверьте, что домен $DOMAIN указывает на $IP, и запустите скрипт ещё раз." )
$( [ -n "$created" ] && printf '\n Логины сотрудников (сохраните, больше не покажу):\n%s\n' "$created" )

 Сотрудники: sudo -u uletnoe env DATA_DIR=$DATA_DIR node $APP_DIR/server/cli.js list-users
==================================================================
DONE
