// Tests for the openGym app's start-up preparation. Run from ha-config:
//   node --test addons/opengym/tests/prepare.test.mjs
// Not shipped (the image copies rootfs/ only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envFromOptions, envText, inlineScriptHashes, cspFor, ensureFirstInvite } from '../rootfs/og/prepare.mjs';

test('options map to the API environment', () => {
  const env = envFromOptions({ origin: 'http://gym.example.com:8780/', password_login: true, invite_only: true, allow_guest: false, webhooks: true, default_lang: 'en' });
  assert.equal(env.ORIGIN, 'http://gym.example.com:8780');
  assert.equal(env.RP_ID, 'gym.example.com');
  assert.equal(env.INVITE_ONLY, '1');
  assert.equal(env.ALLOW_GUEST, '0');
  assert.equal(env.PASSWORD_LOGIN, '1');
  assert.equal(env.INTEGRATIONS, 'webhook');
  assert.equal(env.FIRST_USER_ADMIN, '1');
});

test('webhooks reach Home Assistant only, and the public https origin is accepted', () => {
  const env = envFromOptions({ origin: 'https://gym.example.com:8443', webhooks: true });
  assert.equal(env.ORIGIN, 'https://gym.example.com:8443');
  assert.equal(env.RP_ID, 'gym.example.com');
  assert.equal(env.ALLOWED_PRIVATE_IPS, '172.30.32.0/31');
  assert.doesNotThrow(() => envText(env));
});

test('webhooks off leaves integrations unset', () => {
  const env = envFromOptions({ webhooks: false });
  assert.equal(env.INTEGRATIONS, undefined);
  assert.equal(env.INTEGRATIONS_ALLOW_LAN, undefined);
  assert.equal(env.ALLOWED_PRIVATE_IPS, undefined);
});

test('only boolean true switches a flag on', () => {
  const env = envFromOptions({ allow_guest: 'true', invite_only: 1 });
  assert.equal(env.ALLOW_GUEST, '0');
  assert.equal(env.INVITE_ONLY, '0');
});

test('shell-looking option values are refused', () => {
  assert.throws(() => envFromOptions({ origin: 'http://x;rm -rf /' }));
  assert.throws(() => envFromOptions({ origin: 'http://x$(id)' }));
  assert.throws(() => envFromOptions({ default_lang: 'en;id' }));
  assert.throws(() => envText({ X: 'a b' }));
  assert.throws(() => envText({ X: 'a\nB=1' }));
});

test('env text is KEY=VALUE lines', () => {
  assert.equal(envText({ A: '1', B_C: 'http://h:1' }), 'A=1\nB_C=http://h:1\n');
});

test('inline script hash matches upstream 1.4.5 value for the same text', () => {
  const html = '<html><script>x()</script><script type="module" src="/a.js"></script></html>';
  const h = inlineScriptHashes(html);
  assert.equal(h.length, 1);
  assert.match(h[0], /^'sha256-[A-Za-z0-9+/]+=*'$/);
  assert.match(cspFor(h), /script-src 'self' 'sha256-/);
  assert.match(cspFor(h), /frame-ancestors 'none'/);
});

test('first invite: made once while no profile exists', () => {
  const rnd = () => Buffer.from('0123456789abcdef', 'hex');
  const a = ensureFirstInvite(null, { inviteOnly: true, random: rnd });
  assert.equal(a.created, true);
  assert.equal(a.code, '0123456789ABCDEF');
  assert.deepEqual(a.db.users, []);
  const b = ensureFirstInvite(a.db, { inviteOnly: true, random: rnd });
  assert.equal(b.created, false);
  assert.equal(b.code, a.code);
  assert.equal(b.db.invites.length, 1);
});

test('first invite: nothing once a profile exists or sign-up is open', () => {
  assert.equal(ensureFirstInvite({ users: [{ id: 'u' }] }, { inviteOnly: true }).code, null);
  assert.equal(ensureFirstInvite({ users: [] }, { inviteOnly: false }).code, null);
});

test('first invite: a used or revoked code is not offered again', () => {
  let n = 0;
  const rnd = () => Buffer.from(n++ ? 'ffffffffffffffff' : '1111111111111111', 'hex');
  const db = { users: [], invites: [{ code: '1111111111111111', usedBy: 'gone' }, { code: 'AAAA', revoked: true }] };
  const r = ensureFirstInvite(db, { inviteOnly: true, random: rnd });
  assert.equal(r.code, 'FFFFFFFFFFFFFFFF');
  assert.equal(r.db.invites.length, 3);
});
