// Audit tests for the openGym house sidecar (EXTREME AUDIT part 1, 23 Nov 2026).
// Each test states the behaviour we WANT. Run against a copy of the app folder:
//   OG_APP=/tmp/og-audit/A node --test /tmp/og-audit/audit.test.mjs     (0.2.3 as shipped)
//   OG_APP=/tmp/og-audit/B node --test /tmp/og-audit/audit.test.mjs     (with the proposed fixes)
// In the repo: put it in addons/opengym/tests/audit.test.mjs and replace APP with '..'.
// OG_PLANS=<dir with the vault's *-plan.json, fay-week1.json, fay-edit.json> adds the real-plan cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = process.env.OG_APP || path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { readPlan, mergeInto, applyEdit } = await import(path.join(APP, 'rootfs/og/plan-merge.mjs'));
const { readEdit, readManifest, findUser } = await import(path.join(APP, 'rootfs/og/house.mjs'));

let n = 0;
const ids = () => `id${++n}`;
const plan = (o) => readPlan(JSON.stringify({ opengym_plan: 1, unit: 'kg', ...o }));
const R = (id, name) => ({ id, name, ex: [] });

/* ---------------- applyEdit: renames ---------------- */

test('A1 case-only rename is applied, not silently dropped', () => {
  const S = { routines: [R('a', 'push day')] };
  const did = applyEdit(S, { rename: { 'push day': 'Push Day' } });
  assert.equal(S.routines[0].name, 'Push Day');
  assert.deepEqual(did.renamed, [['push day', 'Push Day']]);
  assert.equal(did.changed, true);
});

test('A2 a rename that changes nothing is not a change (same exact name)', () => {
  const S = { routines: [R('a', 'Push')] };
  const did = applyEdit(S, { rename: { push: 'Push' } }); // key matches case-insensitively, name already exact
  assert.equal(did.changed, false);
  assert.deepEqual(did.renamed, []);
});

test('A3 the new name is stored trimmed and NFKC-normalised', () => {
  const S = { routines: [R('a', 'Old')] };
  applyEdit(S, { rename: { Old: '  Ｗarm-up  ' } });
  assert.equal(S.routines[0].name, 'Warm-up');
});

test('A4 swap and chain still work (positive)', () => {
  const S = { routines: [R('a', 'A'), R('b', 'B'), R('c', 'X')] };
  applyEdit(S, { rename: { A: 'B', B: 'A' } });
  assert.deepEqual(S.routines.map(r => r.name), ['B', 'A', 'X']);
  const T = { routines: [R('a', 'A'), R('b', 'B')] };
  applyEdit(T, { rename: { A: 'B', B: 'C' } });
  assert.deepEqual(T.routines.map(r => r.name), ['B', 'C']);
});

test('A5 two keys for one name: the second is kept, never two renames', () => {
  const S = { routines: [R('a', 'Push')] };
  const did = applyEdit(S, { rename: { Push: 'One', push: 'Two' } });
  assert.equal(S.routines[0].name, 'One');
  assert.deepEqual(did.kept, ['push']);
});

test('A6 Arabic names rename and match exactly once', () => {
  const S = { routines: [R('a', 'تمرين الصدر'), R('b', 'تمرين الظهر')] };
  const did = applyEdit(S, { rename: { 'تمرين الصدر': 'صدر', 'تمرين الظهر': 'صدر' } });
  assert.deepEqual(S.routines.map(r => r.name), ['صدر', 'تمرين الظهر']);
  assert.deepEqual(did.kept, ['تمرين الظهر']);
});

test('A7 invisible / bidi characters are refused in edit names (readEdit)', () => {
  assert.ok(readEdit({ id: 'x1', rename: { Push: 'Push​' } }).error);
  assert.ok(readEdit({ id: 'x1', rename: { Push: '‮Push' } }).error);
});

/* ---------------- applyEdit: week replace ---------------- */

test('B1 week replace with a plan that schedules nothing does not wipe the week', () => {
  const S = { unit: 'kg', routines: [R('mine', 'Mine')], week: { 1: ['mine'], 3: ['mine'] } };
  const did = applyEdit(S, { plan: plan({ routines: [R('p', 'New')], week: {} }), weekReplace: true }, { id: ids });
  assert.deepEqual(S.week, { 1: ['mine'], 3: ['mine'] });
  assert.equal(did.week, 'kept');
});

test('B2 week replace on a partly-present plan: unmatched plan routines are reported, week kept', () => {
  const S = { unit: 'kg', routines: [R('t', 'Treadmill')], week: { 1: ['t'] } };
  const p = plan({ routines: [R('p1', 'Treadmill'), R('p2', 'Bike')], week: { 0: ['p1'], 2: ['p2'], 4: ['p2'] } });
  const did = applyEdit(S, { plan: p, weekReplace: true });
  assert.equal(did.plan.status, 'already');
  assert.deepEqual(did.weekUnmatched, ['Bike']);
  assert.equal(did.week, 'kept');
  assert.deepEqual(S.week, { 1: ['t'] });
});

test('B3 re-running a finished week replace is not a change (crash replay must not write again)', () => {
  const S = { unit: 'kg', routines: [R('t', 'Treadmill')], week: { 0: ['t'], 2: ['t'] } };
  const p = plan({ routines: [R('p1', 'Treadmill')], week: { 0: ['p1'], 2: ['p1'] } });
  const did = applyEdit(S, { plan: p, weekReplace: true });
  assert.equal(did.changed, false);
});

test('B4 week keys: only "0".."6" count; "07", " 1", "1.0", "7" are ignored', () => {
  const S = { unit: 'kg', routines: [] };
  const p = plan({ routines: [R('p', 'P')], week: { '07': ['p'], ' 1': ['p'], '1.0': ['p'], 7: ['p'], 6: 'p' } });
  mergeInto(S, p, { id: ids });
  const pid = S.routines[0].id;
  assert.deepEqual(S.week, { 6: [pid] });
});

/* ---------------- plan-merge: hostile or sloppy plan files ---------------- */

test('C1 an id like "constructor" or "__proto__" never puts null into the week or programme days', () => {
  const S = { unit: 'kg', routines: [] };
  const p = plan({
    routines: [R('r1', 'One')],
    week: { 0: ['constructor', 'r1'], 1: ['__proto__'], 2: ['toString'] },
    programmes: [{ name: 'P', weeks: [{}], days: { 0: ['constructor', 'r1'], 1: ['hasOwnProperty'] } }],
  });
  mergeInto(S, p, { id: ids });
  const text = JSON.stringify(S);
  assert.ok(!text.includes('null'), text);
  const rid = S.routines[0].id;
  assert.deepEqual(S.week, { 0: [rid] });
  assert.deepEqual(Object.values(S.programmes)[0].days, { 0: [rid] });
});

test('C2 an exercise row whose id is "constructor" keeps its id', () => {
  const S = { unit: 'kg', routines: [] };
  mergeInto(S, plan({ routines: [{ id: 'r', name: 'R', ex: [{ id: 'constructor', sets: 1 }] }] }), { id: ids });
  assert.equal(JSON.parse(JSON.stringify(S)).routines[0].ex[0].id, 'constructor');
});

test('C3 a plan with two routines of the same name (or the same id) is refused', () => {
  assert.throws(() => plan({ routines: [R('a', 'Push'), R('b', ' push ')] }), /twice|same/);
  assert.throws(() => plan({ routines: [R('a', 'Push'), R('a', 'Pull')] }), /twice|same/);
});

/* ---------------- sidecar: manifest, sizes, profile matching ---------------- */

test('D1 a readEdit-valid edit always fits the admin socket line (4096 chars incl. the envelope)', () => {
  const rename = {};
  for (let i = 0; i < 60; i++) rename[`${String(i).padStart(2, '0')}${'o'.repeat(78)}`] = 'n'.repeat(80);
  const e = readEdit({ id: 'big-edit', rename, plan: 'some-plan.json', week: 'replace' });
  if (e.error) return; // refused up front: fine
  const msg = { cmd: 'house.edit', uid: 'B16cPaRKI9TZxhvL', id: e.id, rename: e.rename, file: e.plan, weekReplace: e.weekReplace, dryRun: false };
  assert.ok(JSON.stringify(msg).length + 1 <= 4096, `line is ${JSON.stringify(msg).length + 1} chars`);
});

test('D2 two manifest people who match the same profile by name never both act on it', () => {
  // The plan loop passes `taken`; the rename/edit/follow loops do not (house.mjs 266, 287, 305).
  const users = [{ id: 'u1', name: 'Sam', owner: false, inviteTag: null, synced: true }];
  const man = readManifest(JSON.stringify({ people: [
    { tag: 'sam', match: { names: ['Sam'] }, edit: { id: 'e1', rename: { A: 'B' } } },
    { tag: 'sam-two', match: { names: ['Sam'] }, edit: { id: 'e1', rename: { C: 'D' } } },
  ] }));
  const taken = new Set();
  const owners = man.people.map(p => { const u = findUser(p, users, taken); if (u) taken.add(u.id); return u?.id || null; });
  assert.deepEqual(owners, ['u1', null]); // what the plan loop decides
  // The rename, edit and follow loops must reuse that decision instead of their own findUser call
  // (0.2.3 calls findUser(person, users) there, without `taken`: the second person resolves to u1 too).
  assert.deepEqual(man.people.map(p => findUser(p, users)?.id || null), ['u1', 'u1']); // why it matters
  const src = fs.readFileSync(path.join(APP, 'rootfs/og/house.mjs'), 'utf8');
  const loops = src.slice(src.indexOf('// One-off renames'));
  assert.doesNotMatch(loops, /findUser\((person|fp), users\)/);
});

test('D3 dry_run makes no invite codes', async () => {
  // house.mjs main() line 212: the invite block has no man.dryRun check. Static check of the source.
  const src = fs.readFileSync(path.join(APP, 'rootfs/og/house.mjs'), 'utf8');
  const block = src.slice(src.indexOf('// Invite codes'), src.indexOf('// Their profile'));
  assert.match(block, /dryRun/);
});

test('D4 writeJson gives the file its mode even when a stale .tmp is in the way', () => {
  const src = fs.readFileSync(path.join(APP, 'rootfs/og/house.mjs'), 'utf8');
  const fn = src.slice(src.indexOf('function writeJson'), src.indexOf('let askAdminSocket'));
  // eslint-disable-next-line no-new-func
  const writeJson = new Function('fs', `${fn}; return writeJson;`)(fs);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogw-'));
  const f = path.join(dir, 'invites.json');
  fs.writeFileSync(`${f}.tmp`, 'old', { mode: 0o644 });
  fs.chmodSync(`${f}.tmp`, 0o644);
  writeJson(f, { code: 'X' }, 0o600);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

/* ---------------- the real files ---------------- */

const P = process.env.OG_PLANS;
test('E1 Fay: her plan, then the real 23 Nov edit, then a crash replay of the same edit', { skip: !P || !fs.existsSync(path.join(P || '', 'fay-edit.json')) }, () => {
  const S = { unit: 'kg' };
  assert.equal(mergeInto(S, readPlan(fs.readFileSync(path.join(P, 'fay-plan.json'), 'utf8')), { id: ids }).status, 'added');
  const ed = readEdit(JSON.parse(fs.readFileSync(path.join(P, 'fay-edit.json'), 'utf8')));
  assert.ok(!ed.error, ed.error);
  const week1 = readPlan(fs.readFileSync(path.join(P, ed.plan), 'utf8'));
  const did = applyEdit(S, { rename: ed.rename, plan: week1, weekReplace: ed.weekReplace }, { id: ids });
  assert.equal(did.renamed.length, 15);
  assert.deepEqual([did.kept, did.missing], [[], []]);
  assert.equal(did.plan.status, 'added');
  const tm = S.routines.find(r => r.name === 'Treadmill').id;
  assert.deepEqual(S.week, { 0: [tm], 2: [tm], 4: [tm] });
  assert.ok(S.routines.every(r => !r.name.startsWith('Fay ·')));
  assert.ok(Object.values(S.programmes).every(p => !p.name.startsWith('Fay ·')));
  assert.equal(new Set(S.routines.map(r => r.name.toLowerCase())).size, S.routines.length, 'no duplicate names');
  // The same edit again (state.json lost after the commit): nothing to change.
  const again = applyEdit(S, { rename: ed.rename, plan: week1, weekReplace: ed.weekReplace }, { id: ids });
  assert.equal(again.missing.length, 15);
  assert.equal(again.changed, false);
});
