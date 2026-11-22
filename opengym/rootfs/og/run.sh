#!/bin/sh
# openGym app start script (root, under tini).
#   prepare.mjs -> /tmp/og/env + /tmp/og/csp (+ first-profile invite while no profile exists)
#   API  : node /app/server.js as user "og", 127.0.0.1:3000, data in /data/opengym
#   web  : nginx as user "nginx" on :8780 (upstream's template), the app's only open port
# If either process stops, the app stops; Supervisor's watchdog starts it again.
set -eu
log() { echo "[run] $(date -Iseconds) $*"; }

mkdir -p /tmp/og
# The API user must be able to pass through /data (traverse only, no listing) to reach its folder.
chmod o+x,o-rw /data
[ -d /data/opengym ] || install -d -o og -g og -m 0700 /data/opengym
# The API user owns its data. -h: change a link itself, never what it points to; -xdev: stay on /data.
chown -h og:og /data/opengym
find /data/opengym -xdev ! -user og -exec chown -h og:og {} +

node /og/prepare.mjs                       # root: options -> /tmp/og/env, /tmp/og/csp
su-exec og:og node /og/prepare.mjs --invite  # API user: first-profile invite, if needed

# shellcheck disable=SC1091
set -a; . /tmp/og/env; set +a
export DATA_DIR=/data/opengym PORT=3000 NODE_ENV=production

# ---- nginx config from upstream's template. Only these names are substituted, so nginx's own
#      $variables in the template stay as they are.
export NGINX_PORT=8780 BACKEND=127.0.0.1 RESOLVER=127.0.0.11 CF_CONNECTING_IP="" BASE_PATH="" \
       MEDIA_UPLOAD_MAX=112m MCP_BACKEND=127.0.0.1 MCP_PORT=9
CONTENT_SECURITY_POLICY=$(cat /tmp/og/csp)
export CONTENT_SECURITY_POLICY
# shellcheck disable=SC2016
envsubst '${NGINX_PORT} ${BASE_PATH} ${RESOLVER} ${BACKEND} ${PORT} ${CF_CONNECTING_IP} ${MEDIA_UPLOAD_MAX} ${MCP_BACKEND} ${MCP_PORT} ${CONTENT_SECURITY_POLICY}' \
  < /og/default.conf.template > /tmp/og/default.conf
mkdir -p /tmp/og/client /tmp/og/proxy /tmp/og/fastcgi /tmp/og/uwsgi /tmp/og/scgi
chown nginx:nginx /tmp/og/client /tmp/og/proxy /tmp/og/fastcgi /tmp/og/uwsgi /tmp/og/scgi
nginx -t -c /og/nginx.conf -q

log "starting API (127.0.0.1:3000) and web (:8780)"
su-exec og:og node --max-old-space-size=256 /app/server.js &
API=$!
# Wait up to 30 s for the API before nginx opens the port.
i=0
until wget -q -O /dev/null http://127.0.0.1:3000/api/health 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 30 ] || ! kill -0 "$API" 2>/dev/null; then log "API did not come up"; exit 1; fi
  sleep 1
done
nginx -c /og/nginx.conf -g 'daemon off;' &
WEB=$!
log "ready"

# Stop both when either ends (tini forwards SIGTERM from Supervisor to this script's group).
while kill -0 "$API" 2>/dev/null && kill -0 "$WEB" 2>/dev/null; do sleep 5; done
log "a process stopped; stopping the app"
kill "$API" "$WEB" 2>/dev/null || true
wait || true
exit 1
