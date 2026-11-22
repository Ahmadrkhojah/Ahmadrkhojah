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
COPY rootfs/og/ /og/
RUN chmod 0755 /og /og/run.sh && chmod 0644 /og/*.mjs /og/nginx.conf /og/default.conf.template

# Our own health check: nginx's static page only. Upstream's (inherited) one calls /api/health,
# which writes a file under /data every 30 s. Not `HEALTHCHECK NONE`: Supervisor then waits for a
# "healthy" event that never comes and the app stays in state "startup" (0.1.0, 22 Nov 2026).
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:8780/ || exit 1
ENTRYPOINT ["/sbin/tini", "-s", "-g", "--", "/og/run.sh"]
