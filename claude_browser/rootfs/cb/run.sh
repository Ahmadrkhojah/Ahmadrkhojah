#!/bin/bash
# Claude Browser start script (runs as root under tini, PID 1's child).
# 1. reads options, makes the access token (kept in /data, never printed),
# 2. announces the MCP server to Home Assistant through Supervisor discovery,
# 3. drops the Supervisor token, then starts three processes as three different users:
#      proxy (cbproxy) -> 127.0.0.1:3128   the only way out for Chromium
#      Playwright MCP + Chromium (node) -> 127.0.0.1:8930
#      gateway (cbgw) -> :8931 /mcp, bearer token, the app's only reachable port
# 4. watches them: a dead proxy/gateway stops the app (Supervisor's watchdog restarts it);
#    a dead or over-memory browser is restarted on its own.
set -euo pipefail

OPT=/data/options.json
log() { echo "[run] $(date -Iseconds) $*"; }
opt() { node -e '
  const fs=require("fs"); let o={}; try{o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{}
  const v=o[process.argv[2]]; process.stdout.write(String(Number.isInteger(v)?v:process.argv[3]));' "$OPT" "$1" "$2"; }
IDLE_MIN=$(opt idle_minutes 5)
CAP_MB=$(opt memory_cap_mb 1200)
MAX_CHARS=$(opt max_result_chars 40000)
HOME_NAMES=$(node -e '
  let o={}; try{o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch{}
  const v=String(o.home_public_names??""); process.stdout.write(/^[A-Za-z0-9.,-]*$/.test(v)?v:"");' "$OPT")

if [ -z "$HOME_NAMES" ]; then
  log "WARN: home_public_names is empty: the proxy does NOT refuse this home's own public address. Set it in the app's options."
fi

# ---- token: 256 random bits, readable only by root here and by cbgw in /run/cb.
umask 077
if [ ! -s /data/token ]; then
  node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))' > /data/token
  log "new access token created (stored in /data/token, not shown)"
fi
mkdir -p /run/cb && chmod 0711 /run/cb
install -o cbgw -g cbgw -m 0400 /data/token /run/cb/token

# ---- announce to Home Assistant (mcp integration picks it up; the token travels only
#      Supervisor -> Home Assistant, inside the Pi).
if [ -n "${SUPERVISOR_TOKEN:-}" ]; then
  node -e '
    const fs=require("fs"); const tok=fs.readFileSync("/data/token","utf8").trim();
    const H={authorization:"Bearer "+process.env.SUPERVISOR_TOKEN,"content-type":"application/json"};
    (async()=>{
      let host=require("os").hostname();
      try{const r=await fetch("http://supervisor/addons/self/info",{headers:H,signal:AbortSignal.timeout(5000)});const j=await r.json();if(j?.data?.hostname)host=j.data.hostname;}catch{}
      const body={service:"mcp",config:{url:`http://${host}:8931/mcp`,token:tok}};
      const r=await fetch("http://supervisor/discovery",{method:"POST",headers:H,body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
      console.log(`[run] discovery sent for http://${host}:8931/mcp -> HTTP ${r.status}`);
    })().catch(e=>{console.log("[run] discovery failed: "+e.message);});'
else
  log "WARN: no SUPERVISOR_TOKEN, discovery skipped"
fi
unset SUPERVISOR_TOKEN HASSIO_TOKEN || true

# ---- run a command as another user, no new privileges, clean environment.
as() { local u=$1; shift; setpriv --reuid="$u" --regid="$u" --init-groups --no-new-privs "$@"; }
BASE_ENV=(env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=production LANG=C.UTF-8)

NODE_UID=$(id -u node)
kill_uid() {  # no procps in this image: walk /proc
  local sig=$1 f pid
  for f in /proc/[0-9]*/status; do
    pid=${f#/proc/}; pid=${pid%/status}
    awk -v u="$2" '$1=="Uid:"{f=($2==u)} END{exit !f}' "$f" 2>/dev/null && kill "-$sig" "$pid" 2>/dev/null || true
  done
}

# ---- Chromium sandbox: on unless the probe proves this container refuses it (fail closed).
# The probe launches the SAME browser (channel, headless, args) as Playwright MCP, as the same
# user, from the generated config, so the answer holds for the browser that really runs.
PW_CORE=$(node -e 'process.stdout.write(require.resolve("playwright-core",{paths:["/app"]}))')
write_pw_config() {
  node -e '
    const fs=require("fs"); const c=JSON.parse(fs.readFileSync("/cb/pw-config.base.json","utf8"));
    c.browser.launchOptions.chromiumSandbox = process.argv[1]==="true";
    fs.writeFileSync("/run/cb/pw-config.json", JSON.stringify(c,null,1), {mode:0o644});' "$1"
  chmod 0644 /run/cb/pw-config.json
}
write_pw_config true
SANDBOX=true
set +e
PROBE=$(timeout -k 10 200 setpriv --reuid=node --regid=node --init-groups --no-new-privs "${BASE_ENV[@]}" HOME=/home/node \
  PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node /cb/sandbox-probe.mjs /run/cb/pw-config.json "$PW_CORE" 2>&1 | tail -n 1)
PROBE_RC=$?   # pipefail is on: the probe's own exit code (124 = timeout)
set -e
kill_uid KILL "$NODE_UID"   # nothing from the probe may outlive it
PROBE_REASON=$(printf '%s' "$PROBE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r="no answer from probe";try{r=JSON.parse(s).reason||r}catch{if(s)r=s}process.stdout.write(String(r).replace(/[^ -~]/g,"?").slice(0,300))})')
case "$PROBE_RC" in
  0) log "chromium sandbox: true" ;;
  2) SANDBOX=false; log "WARN: chromium sandbox: false (this container refuses it: $PROBE_REASON)" ;;
  *) log "ERROR: chromium did not start in the probe (exit $PROBE_RC): $PROBE_REASON; sandbox stays on" ;;
esac
write_pw_config "$SANDBOX"
mkdir -p /tmp/cb-out && chown node:node /tmp/cb-out && chmod 0700 /tmp/cb-out

start_proxy() { as cbproxy "${BASE_ENV[@]}" HOME=/nonexistent CB_HOME_NAMES="$HOME_NAMES" node /cb/proxy.mjs & PROXY_PID=$!; }
start_browser() {
  # setsid: own process group (pgid = this pid). oom_score_adj 1000: if the Pi runs short of
  # memory, the kernel kills Chromium first, never Home Assistant. nice 19: lowest CPU priority.
  setsid bash -c 'echo 1000 > /proc/self/oom_score_adj; cd /home/node && exec nice -n 19 "$@"' _ \
    setpriv --reuid=node --regid=node --init-groups --no-new-privs \
    "${BASE_ENV[@]}" HOME=/home/node PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    node /app/cli.js --config /run/cb/pw-config.json & BROWSER_PID=$!
}
start_gateway() {
  as cbgw "${BASE_ENV[@]}" HOME=/nonexistent CB_TOKEN_FILE=/run/cb/token CB_IDLE_MINUTES="$IDLE_MIN" \
    CB_MAX_RESULT_CHARS="$MAX_CHARS" node /cb/gateway.mjs & GATEWAY_PID=$!
}
stop_browser() {
  kill -TERM -- "-$BROWSER_PID" 2>/dev/null || true
  sleep 1
  kill -KILL -- "-$BROWSER_PID" 2>/dev/null || true
  kill_uid KILL "$NODE_UID"   # anything left from Chromium's user
}
shutdown() { log "stopping"; stop_browser; kill "$GATEWAY_PID" "$PROXY_PID" 2>/dev/null || true; exit "${1:-0}"; }
trap 'shutdown 0' TERM INT

# Memory used by this container, without reclaimable file cache (cgroup v2, then v1).
mem_mb() {
  if [ -r /sys/fs/cgroup/memory.current ]; then
    local cur inact; cur=$(cat /sys/fs/cgroup/memory.current)
    inact=$(awk '$1=="inactive_file"{print $2}' /sys/fs/cgroup/memory.stat 2>/dev/null || echo 0)
    echo $(( (cur - ${inact:-0}) / 1048576 ))
  elif [ -r /sys/fs/cgroup/memory/memory.usage_in_bytes ]; then
    echo $(( $(cat /sys/fs/cgroup/memory/memory.usage_in_bytes) / 1048576 ))
  else
    { cat /proc/[0-9]*/status 2>/dev/null || true; } | awk '$1=="VmRSS:"{s+=$2} END {print int(s/1024)}'
  fi
}

start_proxy
start_browser
sleep 2
start_gateway
log "started: proxy $PROXY_PID, browser $BROWSER_PID, gateway $GATEWAY_PID; idle ${IDLE_MIN} min, memory cap ${CAP_MB} MB"

tick=0
while true; do
  sleep 5 & wait $! || true   # wait is interruptible, so a stop runs the trap at once
  tick=$((tick + 1))
  kill -0 "$PROXY_PID" 2>/dev/null || { log "proxy died"; shutdown 1; }
  kill -0 "$GATEWAY_PID" 2>/dev/null || { log "gateway died"; shutdown 1; }
  if ! kill -0 "$BROWSER_PID" 2>/dev/null; then
    log "browser server died: restarting it"; stop_browser; start_browser; continue
  fi
  used=$(mem_mb)
  if [ "$used" -gt "$CAP_MB" ]; then
    log "memory ${used} MB over cap ${CAP_MB} MB: restarting the browser"
    stop_browser; start_browser
  fi
  # Leftover snapshot/console files (Playwright writes them for action tools): keep 10 minutes.
  if [ $((tick % 60)) -eq 0 ]; then setpriv --reuid=node --regid=node --init-groups find /tmp/cb-out -type f -mmin +10 -delete 2>/dev/null || true; fi
done
