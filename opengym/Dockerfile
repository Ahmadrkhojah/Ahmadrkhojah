# openGym as ONE Home Assistant app container (upstream ships two: api + web).
#   stage "web": upstream's web image, only for its built app and its nginx template.
#   final: upstream's API image (node + /app) plus Alpine's nginx, which serves the app and
#          proxies /api to the API on 127.0.0.1:3000. Only nginx's port is published.
# Bump: change 1.4.5 here AND in build.yaml, bump config.yaml version, review gate, publish.
# Pinned by tag (the cloud session that wrote this could not read ghcr digests); pin by digest
# (@sha256:...) when a session can read them.
ARG BUILD_FROM
FROM ghcr.io/duartesantos8/opengym-web:1.4.5 AS web

FROM ${BUILD_FROM}
USER root
# nginx (+ its user "nginx"), envsubst for upstream's template, su-exec to drop root, tini as init.
RUN set -eu; \
    apk add --no-cache nginx gettext-envsubst su-exec tini; \
    rm -f /etc/nginx/http.d/default.conf; \
    adduser -D -H -s /sbin/nologin og; \
    node --version
COPY --from=web /usr/share/nginx/html /usr/share/nginx/html
COPY --from=web /etc/nginx/templates/default.conf.template /og/default.conf.template
# The API listens on every interface by default; inside this container only nginx should reach it.
# The build fails if upstream renames the line, so a silent drift can't publish port 3000.
RUN set -eu; \
    grep -q 'server.listen(PORT, () =>' /app/server.js; \
    sed -i "s|server.listen(PORT, () =>|server.listen(PORT, '127.0.0.1', () =>|" /app/server.js; \
    grep -q "server.listen(PORT, '127.0.0.1', () =>" /app/server.js
# Webhooks to private addresses: upstream's INTEGRATIONS_ALLOW_LAN opens the WHOLE home network and
# tailnet (10/8, 172.16/12, 192.168/16, 100.64/10). Since 22 Nov 2026 the app is public behind
# an https proxy, so one stolen password must not mean blind POSTs to every
# LAN admin page. Narrow it to the addresses in ALLOWED_PRIVATE_IPS only (prepare.mjs sets
# Home Assistant's Supervisor-network address). The build fails if upstream changes these lines.
RUN set -eu; \
    f=/app/net-guard.js; \
    grep -qF 'if (plain) return allowLan && (isLanAddr(v) || isAllowedPrivateAddr(v));' "$f"; \
    grep -qF '  return allowLan && isLanAddr(v);' "$f"; \
    sed -i 's/if (plain) return allowLan \&\& (isLanAddr(v) || isAllowedPrivateAddr(v));/if (plain) return allowLan \&\& isAllowedPrivateAddr(v);/' "$f"; \
    sed -i 's/^  return allowLan \&\& isLanAddr(v);$/  return allowLan \&\& isAllowedPrivateAddr(v);/' "$f"; \
    grep -qF 'if (plain) return allowLan && isAllowedPrivateAddr(v);' "$f"; \
    grep -qF '  return allowLan && isAllowedPrivateAddr(v);' "$f"; \
    ! grep -qF 'allowLan && isLanAddr(v)' "$f"; \
    ! grep -qF '(isLanAddr(v) || isAllowedPrivateAddr(v))' "$f"
# Plain http:// webhooks may only reach Home Assistant's own port 8123 (audit 23 Nov 2026: the
# Supervisor-network address also publishes ha-mcp, Mosquitto, z2m, backups and openGym itself).
COPY build/patch-netguard.mjs /tmp/patch-netguard.mjs
RUN node /tmp/patch-netguard.mjs /app/net-guard.js && rm /tmp/patch-netguard.mjs
# House commands on openGym's own admin socket (23 Nov 2026; rootfs/og/house-cmds.mjs explains).
# One line in front of upstream's "unknown command": a "house.*" command goes to our module with the
# server's own data and functions, so plans and invites go through openGym's own write paths in its
# own process (never a second writer of db.json or a state file). The socket stays what it was: a
# Unix socket only the API user can open. The build fails if upstream changes the line.
COPY build/patch-server.mjs /tmp/patch-server.mjs
RUN node /tmp/patch-server.mjs /app/server.js && rm /tmp/patch-server.mjs
COPY rootfs/og/ /og/
RUN chmod 0755 /og /og/run.sh && chmod 0644 /og/*.mjs /og/nginx.conf /og/default.conf.template

# Our own health check: nginx's static page only. Upstream's (inherited) one calls /api/health,
# which writes a file under /data every 30 s. Not `HEALTHCHECK NONE`: Supervisor then waits for a
# "healthy" event that never comes and the app stays in state "startup" (0.1.0, 22 Nov 2026).
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:8780/ || exit 1
ENTRYPOINT ["/sbin/tini", "-s", "-g", "--", "/og/run.sh"]
