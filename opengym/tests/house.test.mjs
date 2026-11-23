// Tests for the house sidecar and the server-side plan merge. Run from ha-config:
//   node --test addons/opengym/tests/house.test.mjs
// With OG_PLANS=<folder holding *-plan.json> the real plan files are merged too (they are private,
// so they are never copied into this repo; the vault keeps them under inbox/plans/opengym-import*).
// Not shipped in the image (the image copies rootfs/ only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readPlan, mergeInto, cleanRow, alreadyThere } from '../rootfs/og/plan-merge.mjs';
import { readManifest, findUser, liveStep, localToday, statsEvent, GONE_MS, LIVE_REFRESH_MS } from '../rootfs/og/house.mjs';
import { houseFromOptions } from '../rootfs/og/prepare.mjs';

const PLAN = {
  opengym_plan: 1, unit: 'kg', programme_fmt: 1, name: 'Test',
  customEx: [{ id: 'c1', n: 'Towel pull-apart', bp: 'back', eq: 'other', primaries: ['upper-back'], secondaries: ['deltoids', 'upper-back'], mv: 2 }],
  routines: [
    { id: 'r1', name: 'T · Warm-up', emoji: '🔥', excludeFromProgression: true, ex: [{ id: '0001', sets: 1, mode: 'time', sec: 60, restOff: true, note: 'easy' }] },
    { id: 'r2', name: 'T · Full Body', emoji: '🏋️', ex: [
      { id: '0002', sets: 3, reps: 12, repsMin: 8, prog: 'double', inc: 2.5, restSec: 90, warmup: 'auto', subs: ['0003', '0002'] },
      { id: 'c1', sets: 2, reps: 16, side: true, restSec: 0, restOff: true },
      { id: '0004', sets: 3, mode: 'time', sec: 40, sg: 'a', sgName: '  Circuit  ', sgRest: 60, sgCircuit: { mode: 'circuit', rounds: 3, gap: 20 } },
      { id: '0005', sets: 1, mode: 'cardio', min: 20, speed: 5, incline: 6.2, level: 99 },
    ] },
  ],
  week: { 0: ['r1', 'r2'], 2: ['r2'], 9: ['r1'] },
  programmes: [{ id: 'p1', name: 'T · 12 weeks', weeks: [{ rpe: 6 }, { rpe: 7.3 }, { deload: true }, { rpe: 12 }], days: { 0: ['r1', 'r2'], 3: ['nope'] } }],
};

let n = 0;
const ids = () => `id${++n}`;

test('a plan merges like the app: new ids, customs remapped, week set, programme added', () => {
  const S = { unit: 'kg', routines: [{ id: 'mine', name: 'My own', ex: [] }], customEx: [] };
  const did = mergeInto(S, readPlan(JSON.stringify(PLAN)), { id: ids, now: 5 });
  assert.equal(did.status, 'added');
  assert.equal(did.routines, 2);
  assert.equal(did.customEx, 1);
  assert.equal(did.programmes, 1);
  assert.equal(did.week, 'set');
  assert.equal(S.routines.length, 3);
  assert.equal(S.routines[0].id, 'mine');                       // the profile's own routine untouched
  const fb = S.routines.find(r => r.name === 'T · Full Body');
  const custom = S.customEx[0];
  assert.equal(custom.custom, true);
  assert.deepEqual(custom.sm, ['deltoids']);                   // secondaries without the primary
  assert.equal(fb.ex[1].id, custom.id);                          // custom exercise id remapped
  assert.deepEqual(fb.ex[0].subs, ['0003']);                     // a swap to itself dropped
  assert.equal(fb.ex[0].warmup, 'auto');
  assert.equal(fb.ex[1].restOff, true);
  assert.equal(fb.ex[1].restSec, undefined);
  assert.equal(fb.ex[2].sgName, 'Circuit');
  assert.deepEqual(fb.ex[2].sgCircuit, { mode: 'circuit', rounds: 3, gap: 20 });
  assert.equal(fb.ex[3].incline, 6);
  assert.equal(fb.ex[3].level, 30);
  const warm = S.routines.find(r => r.name === 'T · Warm-up');
  assert.equal(warm.excludeFromProgression, true);
  assert.deepEqual(S.week, { 0: [warm.id, fb.id], 2: [fb.id] });  // weekday 9 ignored
  const p = Object.values(S.programmes)[0];
  assert.deepEqual(p.weeks, [{ rpe: 6 }, { rpe: 7.5 }, { deload: true }, {}]);
  assert.deepEqual(p.days, { 0: [warm.id, fb.id] });             // a day pointing at nothing dropped
  assert.equal(p.at, 5);
});

test('never twice: a plan whose routines are there already changes nothing', () => {
  const S = { unit: 'kg', routines: [{ id: 'x', name: ' t · full body ', ex: [] }] };
  const before = JSON.stringify(S);
  const did = mergeInto(S, readPlan(PLAN), { id: ids });
  assert.equal(did.status, 'already');
  assert.deepEqual(did.have, ['T · Full Body']);
  assert.equal(JSON.stringify(S), before);
});

test('a week the profile already has is kept', () => {
  const S = { unit: 'kg', routines: [{ id: 'm', name: 'Mine', ex: [] }], week: { 1: ['m'] } };
  const did = mergeInto(S, readPlan(PLAN), { id: ids });
  assert.equal(did.week, 'kept');
  assert.deepEqual(S.week, { 1: ['m'] });
});

test('a custom exercise with the same name and body part is reused', () => {
  const S = { unit: 'kg', routines: [], customEx: [{ id: 'old', n: 'towel pull-apart', bp: 'back', custom: true }] };
  mergeInto(S, readPlan(PLAN), { id: ids });
  assert.equal(S.customEx.length, 1);
  assert.equal(S.routines.find(r => r.name === 'T · Full Body').ex[1].id, 'old');
});

test('a profile in lb is refused, and so are plan files that are not ours', () => {
  const S = { unit: 'lb', routines: [] };
  assert.equal(mergeInto(S, readPlan(PLAN), { id: ids }).status, 'unit');
  assert.deepEqual(S.routines, []);
  assert.throws(() => readPlan('{"routines": []}'), { code: 'not-plan' });
  assert.throws(() => readPlan({ ...PLAN, unit: 'lb' }), { code: 'unit' });
  assert.throws(() => readPlan('not json'), { code: 'not-plan' });
  assert.throws(() => readPlan({ ...PLAN, routines: [{ id: 'z', ex: [] }] }), { code: 'bad-routine' });
});

test('rest: a positive rest wins over restOff, junk rest is none', () => {
  assert.deepEqual(cleanRow({ id: 'a', restSec: '45', restOff: true }), { id: 'a', restSec: 45 });
  assert.deepEqual(cleanRow({ id: 'a', restSec: -3 }), { id: 'a' });
  assert.deepEqual(cleanRow({ id: 'a', sgName: 'x', sgRest: 30 }), { id: 'a' }); // superset fields only on a superset
});

test('the real plan files merge into an empty profile without dropping a row', { skip: !process.env.OG_PLANS }, () => {
  const dir = process.env.OG_PLANS;
  const files = fs.readdirSync(dir, { recursive: true }).filter(f => /-plan\.json$/.test(f));
  assert.ok(files.length >= 1);
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const S = { unit: 'kg' };
    const did = mergeInto(S, readPlan(raw), { id: ids });
    assert.equal(did.status, 'added', f);
    assert.equal(S.routines.length, raw.routines.length, f);
    assert.equal(S.routines.reduce((a, r) => a + r.ex.length, 0), raw.routines.reduce((a, r) => a + r.ex.length, 0), f);
    assert.equal(did.programmes, raw.programmes.length, f);
    assert.equal(Object.keys(S.week).length, Object.values(raw.week).filter(v => v.length).length, f);
    assert.equal(alreadyThere(S, readPlan(raw)).length, raw.routines.length, f); // and a second run is refused
  }
});

test('the manifest is read strictly', () => {
  const m = readManifest(JSON.stringify({
    follow: 'owner', dry_run: true,
    people: [
      { tag: 'owner', label: 'Me', match: { owner: true }, plan: 'a-plan.json' },
      { tag: 'friend', label: 'Friend <b>', match: { names: ['Friend', ' FRIEND2 '] }, plan: '../etc/passwd', invite: 1 },
      { tag: 'pal', label: 'Pal', match: { names: ['Pal'] }, plan: 'pal-plan.json', invite: 2, schedule: false },
      { tag: 'pal', label: 'again' },
      { tag: 'Bad Tag' },
    ],
  }));
  assert.equal(m.follow, 'owner');
  assert.equal(m.dryRun, true);
  assert.deepEqual(m.people.map(p => p.tag), ['owner', 'pal']);
  assert.equal(m.people[1].invite, 2);
  assert.equal(m.people[1].schedule, false);
  assert.deepEqual(m.people[1].names, ['pal']);
  assert.equal(m.problems.length, 3);
  assert.equal(readManifest('nope').people.length, 0);
});

test('people are found by owner, by their invite, then by name, never twice', () => {
  const users = [
    { id: 'a', name: 'Owner', owner: true },
    { id: 'b', name: 'B', inviteTag: 'pal' },
    { id: 'c', name: 'Pal' },
    { id: 'd', name: 'pal', disabled: true },
  ];
  const owner = { tag: 'o', owner: true, names: [] };
  const pal = { tag: 'pal', owner: false, names: ['pal'] };
  const other = { tag: 'x', owner: false, names: ['pal'] };
  assert.equal(findUser(owner, users).id, 'a');
  assert.equal(findUser(pal, users).id, 'b');                 // the invite wins over the name
  assert.equal(findUser(other, users, new Set(['b'])).id, 'c'); // by name, no invite of theirs
  assert.equal(findUser(other, users, new Set(['b', 'c'])), null); // a disabled profile never
});

test('live workout: on at start, sets as they change, off when a workout is saved', () => {
  const t0 = 1_000_000;
  let s = liveStep(null, null, { total: 4, lastId: 'w4' }, t0);
  assert.equal(s.event, null);
  s = liveStep(s.next, { setsDone: 0, setsTotal: 12, name: 'Full Body', startedAt: t0 }, { total: 4, lastId: 'w4' }, t0);
  assert.deepEqual(s.event, { type: 'live', live: true, sets: 0, sets_total: 12, name: 'Full Body', started_at: t0 });
  let r = liveStep(s.next, { setsDone: 0, setsTotal: 12 }, { total: 4, lastId: 'w4' }, t0 + 15000);
  assert.equal(r.event, null);                                  // nothing new
  r = liveStep(r.next, { setsDone: 1, setsTotal: 12 }, { total: 4, lastId: 'w4' }, t0 + 30000);
  assert.equal(r.event.sets, 1);
  r = liveStep(r.next, { setsDone: 1, setsTotal: 12 }, { total: 4, lastId: 'w4' }, t0 + 30000 + LIVE_REFRESH_MS);
  assert.equal(r.event.live, true);                             // keep-alive
  const gone = liveStep(r.next, null, { total: 4, lastId: 'w4' }, t0 + 300000);
  assert.equal(gone.event, null);                               // a locked phone: wait
  const saved = liveStep(gone.next, null, { total: 5, lastId: 'w5' }, t0 + 320000);
  assert.deepEqual(saved.event, { type: 'live', live: false, finished: true });
  assert.equal(saved.next.live, false);
});

test('live workout: a heartbeat back in time keeps it on; gone for good ends it', () => {
  const t0 = 0;
  let s = liveStep(null, { setsDone: 2, setsTotal: 9 }, { total: 1, lastId: 'a' }, t0);
  let g = liveStep(s.next, null, { total: 1, lastId: 'a' }, t0 + 60000);
  assert.equal(g.event, null);
  const back = liveStep(g.next, { setsDone: 2, setsTotal: 9 }, { total: 1, lastId: 'a' }, t0 + 120000);
  assert.equal(back.event.live, true);                          // came back: on again (and refreshed)
  g = liveStep(back.next, null, { total: 1, lastId: 'a' }, t0 + 200000);
  const end = liveStep(g.next, null, { total: 1, lastId: 'a' }, t0 + 200000 + GONE_MS);
  assert.deepEqual(end.event, { type: 'live', live: false, finished: false });
});

test('Local dates and the stats event', () => {
  assert.equal(localToday(Date.parse('2026-11-22T20:59:00Z')), '2026-11-22');
  assert.equal(localToday(Date.parse('2026-11-22T21:00:00Z')), '2026-11-23');
  const ev = statsEvent({ today: '2026-11-23', streak: 3, thisWeek: { start: '2026-11-22', end: '2026-11-28', workouts: 1, sets: 10, minutes: 40, x: 1 }, lastWeek: { start: '2026-11-15', end: '2026-11-21', workouts: 3, sets: 45, minutes: 120 } });
  assert.deepEqual(ev, { type: 'stats', today: '2026-11-23', this_week: { start: '2026-11-22', end: '2026-11-28', workouts: 1, sets: 10, minutes: 40 }, last_week: { start: '2026-11-15', end: '2026-11-21', workouts: 3, sets: 45, minutes: 120 }, streak_weeks: 3 });
});

test('the house webhook option is checked', () => {
  assert.equal(houseFromOptions({ house_webhook: 'abcdefABCDEF0123_-xy' }).webhook, 'abcdefABCDEF0123_-xy');
  assert.equal(houseFromOptions({ house_webhook: 'short' }).webhook, null);
  assert.equal(houseFromOptions({ house_webhook: 'abcdefabcdefabcdef/../x' }).webhook, null);
  assert.equal(houseFromOptions({}).webhook, null);
});
