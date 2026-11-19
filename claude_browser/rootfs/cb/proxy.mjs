// Filtering forward proxy for Claude Browser. Chromium is launched with this as its only
// proxy (loopback included: bypass list "<-loopback>"), so every page, redirect, image,
// XHR and WebSocket goes through here.
//
// For each request: check the host name, resolve it ONCE, refuse unless EVERY address is
// public (policy.mjs), then connect to the checked address itself (no second lookup, so a
// DNS-rebinding answer can't swap in a private IP). Ports 80 and 443 only.
// Listens on 127.0.0.1 only. Runs as its own user (cbproxy).
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { ALLOWED_PORTS, hostnameProblem, isPublicIp, bareHost } from './policy.mjs';

const LISTEN_PORT = Number(process.env.CB_PROXY_PORT || 3128);
const LOOKUP_TIMEOUT_MS = 5000;
const IDLE_SOCKET_MS = 60_000;
const MAX_SOCKETS = 256;
// The house's own public names (hairpin through the router would reach home web UIs).
const HOME_NAMES = (process.env.CB_HOME_NAMES || '').split(',').map((x) => x.trim()).filter(Boolean);
const homeIps = new Set();
async function refreshHomeIps() {
  const next = new Set();
  for (const n of HOME_NAMES) {
    try {
      const addrs = await Promise.race([dns.lookup(n, { all: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), LOOKUP_TIMEOUT_MS))]);
      for (const a of addrs) next.add(a.address);
    } catch { for (const ip of homeIps) next.add(ip); } // keep the last known addresses
  }
  homeIps.clear(); for (const ip of next) homeIps.add(ip);
  if (HOME_NAMES.length && !homeIps.size) { log('house public names not resolved yet: refusing all traffic, retry in 30 s'); setTimeout(refreshHomeIps, 30_000).unref(); }
}
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization',
  'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

function log(msg) { process.stdout.write(`[proxy] ${new Date().toISOString()} ${msg}\n`); }

/** Resolve and vet a host. Returns {ip, family} or throws Error(reason). */
export async function vet(host, port) {
  if (!ALLOWED_PORTS.has(port)) throw new Error(`port ${port} not allowed`);
  // Fail closed until the house's own public address is known.
  if (HOME_NAMES.length && !homeIps.size) throw new Error('house address list not ready yet');
  const problem = hostnameProblem(host);
  if (problem) throw new Error(problem);
  const h = bareHost(host);
  if (net.isIP(h)) {
    if (net.isIPv6(h)) throw new Error('IPv6 targets not allowed');
    if (homeIps.has(h)) throw new Error("the house's own public address");
    return { ip: h, family: 4 };
  }
  let addrs;
  try {
    addrs = await Promise.race([
      dns.lookup(h, { all: true, verbatim: true, family: 4 }), // IPv4 only: no home IPv6 prefix
      new Promise((_, rej) => setTimeout(() => rej(new Error('dns timeout')), LOOKUP_TIMEOUT_MS)),
    ]);
  } catch (e) { throw new Error(`dns failed (${e.code || e.message})`); }
  if (!addrs.length) throw new Error('no address');
  const bad = addrs.find((a) => !isPublicIp(a.address));
  if (bad) throw new Error('resolves to a private or special address');
  if (addrs.some((a) => homeIps.has(a.address))) throw new Error("resolves to the house's own public address");
  return { ip: addrs[0].address, family: 4 };
}

function deny(res, why) {
  if (res.headersSent) return res.destroy();
  res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
  res.end(`Blocked by Claude Browser: ${why}.\n`);
}

let open = 0;
function track(sock) {
  open++;
  sock.setTimeout(IDLE_SOCKET_MS, () => sock.destroy());
  sock.once('close', () => { open--; });
}

const server = http.createServer(async (req, res) => {
  // Plain-HTTP proxy request: req.url is absolute (http://host/path).
  let u;
  try { u = new URL(req.url); } catch { return deny(res, 'not a proxy request'); }
  if (u.protocol !== 'http:' || u.username || u.password) return deny(res, 'only plain http URLs without credentials');
  const port = u.port ? Number(u.port) : 80;
  let target;
  try { target = await vet(u.hostname, port); } catch (e) {
    log(`DENY http ${bareHost(u.hostname)}:${port} (${e.message})`);
    return deny(res, e.message);
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
  headers.host = u.host;
  const up = http.request({
    host: target.ip, family: target.family, port, method: req.method,
    path: u.pathname + u.search, headers, setHost: false, timeout: IDLE_SOCKET_MS,
  }, (upRes) => {
    const h = {};
    for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k.toLowerCase())) h[k] = v;
    res.writeHead(upRes.statusCode || 502, h);
    upRes.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy(); });
  req.pipe(up);
});

server.on('connect', async (req, clientSock, head) => {
  clientSock.on('error', () => clientSock.destroy()); // first: a reset during DNS must not crash us
  track(clientSock);
  if (open > MAX_SOCKETS) { clientSock.end('HTTP/1.1 503 Busy\r\n\r\n'); return; }
  // req.url is "host:port" or "[v6]:port"; parse it explicitly (URL() drops default ports).
  const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(req.url || '');
  if (!m) { clientSock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  const host = m[1], port = Number(m[2]);
  let target;
  try { target = await vet(host, port); } catch (e) {
    log(`DENY connect ${bareHost(host)}:${port} (${e.message})`);
    if (!clientSock.destroyed) clientSock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  if (clientSock.destroyed) return;
  const upSock = net.connect({ host: target.ip, port, family: target.family });
  track(upSock);
  let established = false;
  upSock.once('connect', () => {
    if (clientSock.destroyed) { upSock.destroy(); return; }
    established = true;
    clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upSock.write(head);
    upSock.pipe(clientSock); clientSock.pipe(upSock);
  });
  upSock.on('error', () => {
    if (!established && !clientSock.destroyed) clientSock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    else clientSock.destroy();
    upSock.destroy();
  });
  clientSock.on('close', () => upSock.destroy());
});

// WebSocket over plain http without CONNECT is not supported: refuse.
server.on('upgrade', (req, sock) => { sock.on('error', () => sock.destroy()); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
server.on('clientError', (err, sock) => sock.destroy());
server.maxConnections = MAX_SOCKETS;
server.headersTimeout = 15_000;
server.requestTimeout = 120_000;

if (process.argv[1] && process.argv[1].endsWith('proxy.mjs')) {
  refreshHomeIps().finally(() => {
    server.listen(LISTEN_PORT, '127.0.0.1', () => log(`listening on 127.0.0.1:${LISTEN_PORT}; home names blocked: ${HOME_NAMES.length}, ${homeIps.size} address(es)`));
  });
  setInterval(refreshHomeIps, 10 * 60_000).unref();
}
export { server, refreshHomeIps, homeIps };
