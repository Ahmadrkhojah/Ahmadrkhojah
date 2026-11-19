ARG BUILD_FROM
FROM ${BUILD_FROM}

# The base image runs as user "node" (Chromium + Playwright MCP live in /app and /ms-playwright).
# We add two more users so the three parts can't read each other's files:
#   cbproxy  - the filtering forward proxy (the only way Chromium reaches the network)
#   cbgw     - the MCP gateway (holds the access token; Chromium's user can't read it)
#   node     - Playwright MCP + Chromium
USER root
RUN set -eu; \
    useradd --system --no-create-home --shell /usr/sbin/nologin cbproxy; \
    useradd --system --no-create-home --shell /usr/sbin/nologin cbgw; \
    command -v setpriv >/dev/null; command -v tini >/dev/null; command -v curl >/dev/null || true
COPY rootfs/cb/ /cb/
RUN chmod 0755 /cb && chmod 0644 /cb/*.mjs /cb/*.js /cb/*.json && chmod 0755 /cb/run.sh

ENTRYPOINT ["/usr/bin/tini", "-s", "-g", "--", "/cb/run.sh"]
LABEL io.hass.type="addon" io.hass.version="0.1.4"
