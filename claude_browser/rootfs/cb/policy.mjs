// Address policy for Claude Browser: which hosts and IPs the browser may reach.
// Used by proxy.mjs (the real gate, after DNS) and gateway.mjs (early, friendly refusal).
// Rule: only public internet addresses on ports 80/443. Never the home, the Pi, the
// Supervisor network, the tailnet, or any special-purpose range.
import net from 'node:net';

export const ALLOWED_PORTS = new Set([80, 443]);

const v4 = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) v4.addSubnet(a, p, 'ipv4');
// 172.30.32.0/23 (Supervisor network) is inside 172.16.0.0/12.

const v6block = new net.BlockList();
for (const [a, p] of [
  ['2001::', 32],      // Teredo (tunnels to IPv4)
  ['2001:db8::', 32],  // documentation
  ['2002::', 16],      // 6to4 (embeds IPv4)
]) v6block.addSubnet(a, p, 'ipv6');
const v6global = new net.BlockList();
v6global.addSubnet('2000::', 3, 'ipv6'); // only global unicast is allowed at all

/** Expand an IPv6 string to 8 groups of 16-bit numbers, or null. */
function v6groups(ip) {
  if (net.isIPv6(ip) !== true) return null;
  let s = ip.toLowerCase();
  const pct = s.indexOf('%'); if (pct >= 0) return null; // zone ids never allowed
  // dotted IPv4 tail (::ffff:1.2.3.4)
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const p = m[2].split('.').map(Number);
    s = m[1] + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  const g = [...h, ...Array(fill).fill('0'), ...t].map((x) => parseInt(x || '0', 16));
  return g.length === 8 && g.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? g : null;
}

/** True only for a public, routable IP literal. Anything unknown is false. */
export function isPublicIp(ip) {
  if (net.isIPv4(ip)) return !v4.check(ip, 'ipv4');
  const g = v6groups(ip);
  if (!g) return false;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 inside.
  if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const d = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
    return net.isIPv4(d) && !v4.check(d, 'ipv4');
  }
  const norm = g.map((n) => n.toString(16)).join(':');
  if (!v6global.check(norm, 'ipv6')) return false; // ::1, fc00::/7, fe80::/10, ff00::/8, 64:ff9b::/96 ...
  return !v6block.check(norm, 'ipv6');
}

const BLOCKED_SUFFIXES = [
  '.local', '.localhost', '.localdomain', '.internal', '.intranet', '.lan', '.home', '.arpa',
  '.ts.net', '.hass.io', '.corp', '.private', '.test', '.invalid', '.onion',
];
const BLOCKED_NAMES = new Set(['localhost', 'homeassistant', 'supervisor', 'hassio', 'host.docker.internal']);

/**
 * Check a hostname before DNS. Returns null if it may be looked up, or a reason string.
 * IP literals are judged directly.
 */
export function hostnameProblem(rawHost) {
  if (typeof rawHost !== 'string' || !rawHost) return 'empty host';
  let h = rawHost.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  while (h.endsWith('.')) h = h.slice(0, -1);
  if (net.isIP(h)) return isPublicIp(h) ? null : 'private or special address';
  if (h.length > 253 || !/^[a-z0-9.-]+$/.test(h)) return 'invalid host name';
  if (!h.includes('.')) return 'single-label (local) name';
  if (BLOCKED_NAMES.has(h)) return 'home name';
  for (const s of BLOCKED_SUFFIXES) if (h.endsWith(s)) return 'local or tailnet name';
  // A numeric or hex last label is never a real TLD; resolvers may read it as an IPv4
  // shorthand (127.1, 0x7f.1, 0177.0.0.1).
  const last = h.split('.').pop();
  if (/^(0x[0-9a-f]*|[0-9]+)$/.test(last)) return 'numeric host';
  return null;
}

/** Normalised host for logging (no userinfo, no path). */
export function bareHost(h) {
  return String(h || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}
