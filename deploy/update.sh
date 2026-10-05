#!/usr/bin/env bash
# Подтягивает свежий код с GitHub. Запускается cron'ом раз в 5 минут (см. install.sh).
set -euo pipefail
APP_DIR=/opt/uletnoe
BRANCH="$(sed -n 's/^BRANCH=//p' /etc/uletnoe.env 2>/dev/null || true)"
BRANCH="${BRANCH:-main}"
cd "$APP_DIR"
git fetch -q origin "$BRANCH"
old="$(git rev-parse HEAD)"
new="$(git rev-parse FETCH_HEAD)"
[ "$old" = "$new" ] && exit 0
git reset -q --hard "$new"
if git diff --name-only "$old" "$new" | grep -q '^server/'; then systemctl restart uletnoe; fi
echo "$(date -Is) обновлено ${old:0:7} -> ${new:0:7}"
