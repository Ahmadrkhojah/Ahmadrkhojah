// openGym app: start-up preparation (runs as root, before the API and nginx start).
//   1. reads /data/options.json, checks every value against a strict pattern, writes /tmp/og/env
//      (KEY=VALUE lines that run.sh sources; nothing in them can carry shell syntax);
//   2. computes the Content-Security-Policy hash of index.html's one inline script, so the CSP
//      stays right when the pinned openGym version changes;
//   3. while the instance has NO profile yet and sign-up is invite-only, makes sure one unused
//      invite code exists and prints it to the app log, so the owner can create the first profile.
//      (Upstream: with INVITE_ONLY on and no admin, nobody could ever make the first code.)
// Run twice by run.sh: as root (`node prepare.mjs`, steps 1-2, writes only /tmp/og) and as the API
// user (`node prepare.mjs --invite`, step 3, writes only /data/opengym).
// Exported functions are unit-tested in ../../tests/prepare.test.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULTS = {
  origin: 'http://localhost:8780',
  password_login: true,
  invite_only: true,
  allow_guest: false,
  webhooks: false,
  default_lang: 'en',
};
const ORIGIN_RX = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;
const LANG_RX = /^[a-z]{2}(-[A-Za-z]{2})?$/;
const FIRST_NOTE = 'first profile (made by the HA app at start)';
const HOOK_RX = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * The house sidecar's settings (house.mjs): only the Home Assistant webhook id, checked. Written to
 * /tmp/og/house.json 0600, handed to the API user by run.sh; never in the environment, never logged.
 * An empty or malformed id means no events to Home Assistant (plans and invites still work).
 */
export function houseFromOptions(raw) {
  const v = raw && typeof raw === 'object' ? raw.house_webhook : undefined;
  return { webhook: typeof v === 'string' && HOOK_RX.test(v) ? v : null };
}

/** Options -> environment for the API. Throws on a value that does not match its pattern. */
export function envFromOptions(raw) {
  const o = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const origin = String(o.origin).trim().replace(/\/+$/, '');
  if (!ORIGIN_RX.test(origin)) throw new Error('option "origin" must look like http://host:port');
  const lang = String(o.default_lang);
  if (!LANG_RX.test(lang)) throw new Error('option "default_lang" must be a language code like en or pt-BR');
  const on = (v) => (v === true ? '1' : '0');
  const env = {
    RP_ID: new URL(origin).hostname,
    ORIGIN: origin,
    RP_NAME: 'openGym',
    PASSWORD_LOGIN: on(o.password_login),
    INVITE_ONLY: on(o.invite_only),
    ALLOW_GUEST: on(o.allow_guest),
    FIRST_USER_ADMIN: '1',
    DEFAULT_LANG: lang,
    // Only nginx (same container) talks to the API, and it overwrites X-Forwarded-For.
    TRUST_PROXY: '1',
  };
  if (o.webhooks === true) {
    env.INTEGRATIONS = 'webhook';
    // Lets a signed-in profile send webhooks to private addresses (Home Assistant on the
    // Supervisor network gateway). Fine on an invite-only, one-household instance.
    env.INTEGRATIONS_ALLOW_LAN = '1';
    // ...but only to Home Assistant itself: the Dockerfile narrows upstream's "whole home network"
    // rule to this list: the Supervisor network gateway, which is `homeassistant`. 22 Nov 2026.
    env.ALLOWED_PRIVATE_IPS = '172.30.32.0/31';
  }
  return env;
}

/** KEY=VALUE text; values are already pattern-checked, this refuses anything else to be safe. */
export function envText(env) {
  return Object.entries(env).map(([k, v]) => {
    if (!/^[A-Z_]+$/.test(k) || !/^[A-Za-z0-9.:/_-]*$/.test(v)) throw new Error(`unsafe env value for ${k}`);
    return `${k}=${v}`;
  }).join('\n') + '\n';
}

/** sha256 hashes (CSP form) of every inline <script> without src in the html. */
export function inlineScriptHashes(html) {
  const out = [];
  const rx = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(rx)) {
    out.push(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  return out;
}

/** Upstream's default policy (web/Dockerfile, openGym 1.4.5) with the script hashes filled in. */
export function cspFor(hashes) {
  return [
    "default-src 'self'",
    `script-src 'self'${hashes.length ? ' ' + hashes.join(' ') : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https: http:",
    "worker-src 'self'",
    "manifest-src 'self'",
    'frame-src https://www.youtube-nocookie.com',
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * First-profile invite. Returns { db, code, created } where db is what should be on disk,
 * or { db, code: null } when there is nothing to do (a profile exists, or sign-up is open).
 */
export function ensureFirstInvite(db, { inviteOnly, now = new Date(), random = crypto.randomBytes } = {}) {
  const d = db && typeof db === 'object' ? db : {};
  for (const k of ['users', 'creds', 'subs', 'invites']) if (!Array.isArray(d[k])) d[k] = [];
  if (!inviteOnly || d.users.length > 0) return { db: d, code: null, created: false };
  const open = d.invites.find((i) => !i.usedBy && !i.revoked);
  if (open) return { db: d, code: open.code, created: false };
  let code;
  do { code = random(8).toString('hex').toUpperCase(); } while (d.invites.some((i) => i.code === code));
  d.invites.push({ code, note: FIRST_NOTE, createdBy: 'ha-app', created: now.toISOString() });
  return { db: d, code, created: true };
}

/** Root step: options -> /tmp/og/env and /tmp/og/csp. Writes nothing under /data. */
function prepareRoot() {
  let opts = {};
  try { opts = JSON.parse(fs.readFileSync('/data/options.json', 'utf8')); } catch { /* defaults */ }
  const env = envFromOptions(opts);
  const html = fs.readFileSync('/usr/share/nginx/html/index.html', 'utf8');
  const hashes = inlineScriptHashes(html);
  // Upstream 1.4.5 has exactly one inline script; none found means the CSP would break the app.
  if (hashes.length === 0) throw new Error('no inline script found in index.html: check the CSP step for this openGym version');
  if (hashes.length > 1) console.warn(`[prepare] ${hashes.length} inline scripts in index.html (expected 1); all are allowed`);
  fs.writeFileSync('/tmp/og/env', envText(env), { mode: 0o644 });
  // The CSP has quotes and spaces, so it travels in its own file (read by run.sh, never sourced).
  fs.writeFileSync('/tmp/og/csp', cspFor(hashes), { mode: 0o644 });
  const house = houseFromOptions(opts);
  fs.writeFileSync('/tmp/og/house.json', JSON.stringify(house), { mode: 0o600 });
  console.log(`[prepare] origin ${env.ORIGIN}, password sign-in ${env.PASSWORD_LOGIN === '1' ? 'on' : 'off'}, ` +
    `invite-only ${env.INVITE_ONLY === '1' ? 'on' : 'off'}, guests ${env.ALLOW_GUEST === '1' ? 'on' : 'off'}, ` +
    `webhooks ${env.INTEGRATIONS ? 'on' : 'off'}, house events ${house.webhook ? 'on' : 'off'}`);
}

/**
 * Invite step, run as the API's own user (never root), so a link planted in /data/opengym can
 * never make root write elsewhere. A damaged db.json is left to the API (it recovers from
 * db.json.bak); the write is a new file + rename, refused if anything is in the way.
 */
function prepareInvite() {
  const dataDir = '/data/opengym';
  const dbFile = path.join(dataDir, 'db.json');
  const inviteOnly = /^INVITE_ONLY=1$/m.test(fs.readFileSync('/tmp/og/env', 'utf8'));
  let db = null;
  try {
    if (fs.existsSync(dbFile)) {
      if (fs.lstatSync(dbFile).isSymbolicLink()) throw new Error('db.json is a symbolic link');
      db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    }
  } catch (e) {
    console.warn(`[prepare] db.json not read (${e.message}); skipping the first-profile invite, the API will recover it`);
    return;
  }
  const res = ensureFirstInvite(db, { inviteOnly });
  if (res.created) {
    const tmp = `${dbFile}.invite-tmp`;
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, JSON.stringify(res.db, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, dbFile);
  }
  if (res.code) {
    console.log('[prepare] No profile yet. Create yours in the app with "Create new profile" and this one-time');
    console.log(`[prepare] invite code: ${res.code}   (it stops working once used; this line goes away then)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === '--invite') prepareInvite(); else prepareRoot();
}
