# Claude Browser

A headless Chromium that belongs to Claude, for reading live public pages (prices, stock).
Built on Microsoft's Playwright MCP (pinned in `build.yaml`). Vault: `sops/claude-browser.md`.

## How it is reached
claude.ai → Home Assistant's MCP server (`/api/mcp`, Home Assistant login) → the `mcp`
integration entry "Claude Browser" → this app's gateway (port 8931, internal Supervisor network
only, bearer token from Supervisor discovery) → Playwright MCP (127.0.0.1:8930) → Chromium →
filtering proxy (127.0.0.1:3128) → the internet.

## What it refuses
- Any request to the gateway without the token or on another path: 404.
- Home, Pi, Supervisor, tailnet and other private or special addresses, checked after DNS in
  the proxy (Chromium can't skip the proxy, loopback included). Ports other than 80/443.
- `file://`, `chrome://`, `view-source:`; tools that upload files, run code, read cookies or
  storage, write files, change routes or open tabs.

## Limits
One shared browser, one call at a time (queue of 3), 25 s per call, at most 2 tabs, no pop-ups,
in-memory profile wiped after `idle_minutes` (default 5), browser restarted above
`memory_cap_mb` (default 1200), page text cut at `max_result_chars`.

## Turn it off
Stop the app (Settings → Apps → Claude Browser → Stop). Nothing else depends on it.
