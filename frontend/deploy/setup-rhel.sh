#!/usr/bin/env bash
# One-time install on the RHEL VM (run as root from the repo root, the folder that holds pipeline/ and frontend/). Idempotent.
#   sudo bash frontend/deploy/setup-rhel.sh
# Prereqs: Node 24 at /usr/bin/node, nginx, a TLS cert/key for the hostname.
set -euo pipefail
APP=/opt/freight-ocr; DATA=/var/lib/freight-ocr; ETC=/etc/freight-ocr
node -v | grep -q '^v24\.' || { echo "Node 24 required at /usr/bin/node"; exit 1; }

id freightocr >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /sbin/nologin freightocr
mkdir -p "$APP" "$DATA/feedback" "$DATA/metrics" "$DATA/backups" "$ETC"
if [ "$(pwd)" != "$APP" ]; then tar --exclude=node_modules --exclude=.next --exclude=out --exclude=samples --exclude=data -cf - . | tar -xf - -C "$APP"; [ -d node_modules ] && [ ! -d "$APP/node_modules" ] && cp -a node_modules "$APP/"; fi
cd "$APP"
# air-gapped VM: copy node_modules from a connected RHEL box of the same arch instead of npm ci
[ -d node_modules ] || npm ci          # devDependencies are needed for next build (TypeScript)
npm run build                          # builds frontend/ (root workspace script)
chown -R freightocr:freightocr "$APP" "$DATA"
chmod 750 "$DATA"

if [ ! -f "$ETC/env" ]; then
  umask 077
  echo "# AUTH_USERS=alice:<sha256>,bob:<sha256>   (npm run hash-password -w frontend -- <user> <password>)" > "$ETC/env"
  echo "AUTH_USERS=" >> "$ETC/env"
  echo "!! edit $ETC/env and add reviewers before starting the service"
fi
chmod 600 "$ETC/env"; chown root:root "$ETC/env"

install -m 644 frontend/deploy/freight-ocr.service /etc/systemd/system/freight-ocr.service
install -m 644 frontend/deploy/freight-ocr-backup.service /etc/systemd/system/freight-ocr-backup.service
install -m 644 frontend/deploy/freight-ocr-backup.timer /etc/systemd/system/freight-ocr-backup.timer
install -m 644 frontend/deploy/nginx-freight-ocr.conf /etc/nginx/conf.d/freight-ocr.conf
install -m 644 frontend/deploy/freight-ocr.proxy_params /etc/nginx/conf.d/freight-ocr.proxy_params
command -v setsebool >/dev/null && setsebool -P httpd_can_network_connect 1 || true
command -v firewall-cmd >/dev/null && { firewall-cmd --permanent --add-service=https; firewall-cmd --permanent --add-service=http; firewall-cmd --reload; } || true

systemctl daemon-reload
systemctl enable --now freight-ocr-backup.timer
nginx -t && systemctl enable --now nginx && systemctl reload nginx
grep -q '^AUTH_USERS=.\+' "$ETC/env" && systemctl enable --now freight-ocr && systemctl restart freight-ocr || echo "service not started: AUTH_USERS empty"
echo "done. next: bash frontend/deploy/smoke.sh https://<host> <user> <password> <sample.pdf>"
