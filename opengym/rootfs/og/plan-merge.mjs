// openGym app: put an openGym plan file into a profile's document, server-side (house add-on, 23 Nov 2026).
//
// Why this exists: openGym 1.4.5 imports plan files only in the app (frontend lib/plan-share.js
// parsePlan + mergePlan), never on the server. This is a port of those two functions for the plan
// files this house builds (vault inbox/plans/opengym-import*/build_plan.py, validated against the
// openGym catalogue), so a new profile finds its plan already there. The result is written by
// house-cmds.mjs through openGym's own token-write path (commitState, unstamped, over the read
// revision), so every device merges it like a change from a second device.
//
// Kept to mergePlan's rules:
//   - custom exercises: one with the same name and body part is reused, else added with a new id;
//   - routines: always ADDED with new ids, never overwriting one the profile has;
//   - the week: only replaced when asked (`schedule`); days the plan leaves empty become rest days;
//     `schedule: 'replace'` (house.edit only) writes the week even when the profile has one;
//   - programmes: added over the new routines, never started.
// House rules on top (stricter than the app):
//   - a plan whose routine names are already in the profile is not added again (no duplicates):
//     planMerge reports `already` and changes nothing;
//   - the week is only written when the profile has no week yet, so a week someone set is kept
//     (unless `schedule: 'replace'`, used by the one-off edit, see applyEdit);
//   - only kg plans into kg profiles (no unit conversion here; anything else is refused).
// Pure: no node imports except crypto for ids, no file or network access. Tested in
// ../../tests/plan-merge.test.mjs against the three real plan files.
import crypto from 'node:crypto';

export const WEEK_DAYS = ['0', '1', '2', '3', '4', '5', '6'];
const WARMUP_MODES = ['auto', 'own', 'none'];              // frontend lib/warmup-ramp.js
const SG_NAME_MAX = 40;                                    // frontend lib/superset-meta.js
const INCLINE_MAX = 40, INCLINE_STEP = 0.5, LEVEL_MAX = 30; // frontend lib/incline.js
const MAX_WEEKS = 16;                                      // frontend lib/programmes.js
const MAX_ROUTINES = 60, MAX_ROWS = 80;                    // our own caps (the app has none this low)
const CIRCUIT = {                                          // frontend lib/circuit.js LIMITS
  rounds: [1, 50, 3], cap: [60, 3600, 600], every: [10, 600, 60], count: [1, 99, 10],
  work: [5, 3600, 20], rest: [0, 600, 10], gap: [0, 300, 0],
};
const MUSCLE_MODEL = 2;

const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);
// Id maps without a prototype: a plan id like "constructor" must never find Object's (upstream
// programmes.js importedProgramme guards the same way with Object.hasOwn).
const idMap = () => Object.create(null);
const clone = v => JSON.parse(JSON.stringify(v));
const clampInt = (v, [lo, hi, def]) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
const restSec = v => { const n = Math.round(Number(v)) || 0; return n > 0 ? n : 0; };
const half = v => Math.round(v * 2) / 2;

/** An id the way the app's uid() makes one (base36 time + 5 random base36 characters). */
export function newId(rand = crypto.randomBytes) {
  const r = BigInt('0x' + rand(4).toString('hex')).toString(36).padStart(5, '0').slice(-5);
  return Date.now().toString(36) + r;
}

const nameKey = s => String(s || '').normalize('NFKC').trim().toLowerCase();

class PlanError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function cleanCircuit(c) {
  if (!isMap(c)) return null;
  if (c.mode === 'circuit') return { mode: 'circuit', rounds: clampInt(c.rounds, CIRCUIT.rounds), gap: clampInt(c.gap, CIRCUIT.gap) };
  if (c.mode === 'amrap') return { mode: 'amrap', cap: clampInt(c.cap, CIRCUIT.cap) };
  if (c.mode === 'emom') return { mode: 'emom', every: clampInt(c.every, CIRCUIT.every), count: clampInt(c.count, CIRCUIT.count) };
  if (c.mode === 'intervals' && c.program !== 'runwalk') {
    return { mode: 'intervals', work: clampInt(c.work, CIRCUIT.work), rest: clampInt(c.rest, CIRCUIT.rest), rounds: clampInt(c.rounds, [1, 50, 8]) };
  }
  return null; // run-walk programmes and unknown modes are not in our plans: dropped, like the app drops unknown modes
}

/** One exercise row as parsePlan leaves it (the clamps our plans can meet; other fields pass through). */
export function cleanRow(e) {
  const {
    restSec: rs, restOff, sgName, sgRest, sgCircuit, incline, level, warmup, warmupRows: _wr,
    subs, ...pass
  } = e;
  const out = { ...pass };
  const rest = restSec(rs);
  if (rest) out.restSec = rest; else if (restOff === true) out.restOff = true;
  if (Array.isArray(subs)) { const s = subs.filter(x => typeof x === 'string' && x && x !== e.id); if (s.length) out.subs = [...new Set(s)]; }
  if (e.sg) {
    const n = typeof sgName === 'string' ? sgName.trim().slice(0, SG_NAME_MAX) : '';
    if (n) out.sgName = n;
    const r = restSec(sgRest); if (r) out.sgRest = r;
    const c = cleanCircuit(sgCircuit); if (c) out.sgCircuit = c;
  }
  const inc = Number(incline);
  if (Number.isFinite(inc) && inc > 0) out.incline = Math.min(INCLINE_MAX, Math.round(inc / INCLINE_STEP) * INCLINE_STEP);
  const lv = Math.round(Number(level));
  if (Number.isFinite(lv) && lv > 0) out.level = Math.min(LEVEL_MAX, lv);
  if (WARMUP_MODES.includes(warmup) && warmup !== 'own') out.warmup = warmup; // our plans never use "own" rows
  return out;
}

const MUSCLE_RX = /^[a-z][a-z-]{1,30}$/;
function cleanCustom(c) {
  const o = { id: c.id, n: String(c.n || '').trim().slice(0, 80), bp: c.bp };
  if (typeof c.desc === 'string' && c.desc) o.desc = c.desc.slice(0, 2000);
  if (typeof c.eq === 'string' && c.eq) o.eq = c.eq;
  const prim = (Array.isArray(c.primaries) ? c.primaries : []).filter(m => MUSCLE_RX.test(m));
  const sm = (Array.isArray(c.secondaries) ? c.secondaries : []).filter(m => MUSCLE_RX.test(m) && !prim.includes(m));
  if (prim[0]) o.tg = prim[0];
  if (prim.length) o.primaries = prim;
  if (sm.length) o.secondaries = sm;
  if (prim.length || sm.length) { o.muscleGroups = [...prim, ...sm]; o.mv = MUSCLE_MODEL; }
  return o;
}

function cleanWeek(w) {
  const out = {};
  if (!isMap(w)) return out;
  if (w.deload === true) out.deload = true;
  const r = Number(w.rpe);
  if (Number.isFinite(r) && r >= 6 && r <= 10) out.rpe = half(r);
  return out; // %1RM targets (`t`) are not in our plans
}

/** Checks a plan file and returns it read the way parsePlan reads it (rows cleaned). Throws PlanError. */
export function readPlan(raw) {
  let d = raw;
  if (typeof raw === 'string') { try { d = JSON.parse(raw); } catch { throw new PlanError('not-plan', 'not JSON'); } }
  if (!isMap(d) || !d.opengym_plan || !Array.isArray(d.routines)) throw new PlanError('not-plan', 'not an openGym plan file');
  const unit = d.unit == null ? 'kg' : d.unit;
  if (unit !== 'kg') throw new PlanError('unit', 'only kg plan files');
  if (d.routines.length === 0 || d.routines.length > MAX_ROUTINES) throw new PlanError('size', 'plan has no routines or too many');
  const customEx = (Array.isArray(d.customEx) ? d.customEx : []).filter(c => isMap(c) && typeof c.id === 'string' && c.id);
  const routines = d.routines.filter(r => isMap(r) && Array.isArray(r.ex)).map(r => {
    if (typeof r.name !== 'string' || !r.name.trim()) throw new PlanError('bad-routine', 'a routine has no name');
    if (r.ex.length > MAX_ROWS) throw new PlanError('size', `routine "${r.name}" has too many rows`);
    return { ...r, ex: r.ex.filter(e => isMap(e) && typeof e.id === 'string' && e.id).map(cleanRow) };
  });
  const seenName = new Set(), seenId = new Set();
  for (const r of routines) {
    const k = nameKey(r.name);
    if (seenName.has(k)) throw new PlanError('duplicate', `routine name "${r.name.trim()}" is in the plan twice`);
    if (r.id != null && seenId.has(String(r.id))) throw new PlanError('duplicate', `routine id "${String(r.id).slice(0, 40)}" is in the plan twice`);
    seenName.add(k); if (r.id != null) seenId.add(String(r.id));
  }
  const programmes = Array.isArray(d.programmes) && !(Number(d.programme_fmt) > 1) ? d.programmes.filter(isMap).slice(0, 32) : [];
  return { name: String(d.name || '').trim(), routines, customEx, week: isMap(d.week) ? d.week : {}, programmes };
}

/** Which of the plan's routine names the profile already has. */
export function alreadyThere(S, plan) {
  const have = new Set((Array.isArray(S?.routines) ? S.routines : []).filter(isMap).map(r => nameKey(r.name)));
  return plan.routines.map(r => r.name).filter(n => have.has(nameKey(n)));
}

/**
 * Merges `plan` (from readPlan) into the document `S` (mutated; pass a copy). Returns what it did:
 *   { status: 'added', routines, customEx, programmes, week: 'set'|'replaced'|'kept'|'off' }
 * `schedule`: true (default) sets the week only when the profile has none; false leaves it alone;
 * 'replace' writes it even when one exists ('replaced'; days the plan leaves out become rest days).
 *   { status: 'already', have: [names] }    nothing changed
 *   { status: 'unit' }                      profile not in kg, nothing changed
 */
export function mergeInto(S, plan, { schedule = true, now = Date.now(), id = newId } = {}) {
  if (S.unit != null && S.unit !== 'kg') return { status: 'unit', unit: String(S.unit).slice(0, 4) };
  const have = alreadyThere(S, plan);
  if (have.length) return { status: 'already', have };
  if (!Array.isArray(S.routines)) S.routines = [];
  if (!Array.isArray(S.customEx)) S.customEx = [];
  const exMap = idMap();
  let customs = 0;
  for (const c of plan.customEx) {
    const clean = cleanCustom(c);
    const same = S.customEx.find(x => isMap(x) && nameKey(x.n) === nameKey(clean.n) && x.bp === clean.bp);
    if (same) { exMap[c.id] = same.id; continue; }
    const nid = id();
    exMap[c.id] = nid;
    S.customEx.push({ ...clean, id: nid, ...(clean.secondaries ? { sm: clean.secondaries } : {}), custom: true });
    customs++;
  }
  const ridMap = idMap();
  for (const r of plan.routines) {
    const nid = id();
    ridMap[r.id] = nid;
    S.routines.push({
      id: nid,
      name: r.name.trim().slice(0, 80),
      ...(typeof r.emoji === 'string' && r.emoji ? { emoji: r.emoji } : {}),
      ...(typeof r.prog === 'string' && r.prog ? { prog: r.prog } : {}),
      ...(r.excludeFromProgression === true ? { excludeFromProgression: true } : {}),
      ex: r.ex.map(e => ({ ...clone(e), id: exMap[e.id] || e.id, ...(Array.isArray(e.subs) ? { subs: e.subs.map(x => exMap[x] || x) } : {}) })),
    });
  }
  let week = 'off';
  if (schedule) {
    const cur = isMap(S.week) ? S.week : {};
    const hasWeek = WEEK_DAYS.some(d => [].concat(cur[d] ?? []).length);
    if (hasWeek && schedule !== 'replace') week = 'kept';
    else {
      S.week = { ...cur };
      for (const d of WEEK_DAYS) delete S.week[d];
      for (const [d, v] of Object.entries(plan.week)) {
        if (!WEEK_DAYS.includes(d)) continue;
        const ids = [].concat(v).map(x => ridMap[x]).filter(Boolean);
        if (ids.length) S.week[d] = ids;
      }
      week = hasWeek ? 'replaced' : 'set';
    }
  }
  let programmes = 0;
  for (const p of plan.programmes) {
    const weeks = (Array.isArray(p.weeks) ? p.weeks : []).slice(0, MAX_WEEKS).map(cleanWeek);
    if (!weeks.length) weeks.push({});
    const days = {};
    for (const d of WEEK_DAYS) {
      const ids = [].concat(isMap(p.days) ? p.days[d] ?? [] : []).filter(x => typeof x === 'string').map(x => ridMap[x]).filter(Boolean);
      if (ids.length) days[d] = ids;
    }
    if (!Object.keys(days).length) continue; // a loop (`sequence`) programme is not in our plans
    const pid = id();
    S.programmes = { ...(isMap(S.programmes) ? S.programmes : {}), [pid]: { id: pid, name: String(p.name ?? '').trim().slice(0, 80), at: now, weeks, days } };
    programmes++;
  }
  return { status: 'added', routines: plan.routines.length, customEx: customs, programmes, week };
}

/**
 * One-off edit of a profile document `S` (mutated; pass a copy), the pure part of house.edit:
 *   1. renames: `rename` maps an exact old routine/programme name (compared as written, NFKC) to a
 *      new one. A routine rename is kept (reported in `kept`) when the new name equals another
 *      routine's name that is not itself being renamed away, or a new name another rename already
 *      took. Keys that match nothing are reported in `missing`. Programmes are renamed without the
 *      clash rule (their names are not unique keys).
 *   2. plan (optional, from readPlan): merged with mergeInto AFTER the renames, so a renamed
 *      routine counts as "already there". `weekReplace` asks for the plan's week to replace the
 *      profile's week even when one exists (days the plan leaves out become rest days).
 *      If mergeInto answers 'already' (the plan's routines are in the profile, e.g. after a rename),
 *      nothing is added, but when `weekReplace` is set the week is still built from the plan: each
 *      plan routine id -> plan routine NAME -> the profile's existing routine with that name.
 *      Plan routines with no match are skipped. 'unit' (profile not in kg) aborts the whole edit.
 * Returns { renamed: [[old,new]], kept: [old], missing: [old], plan: <mergeInto result>|null,
 *           week: 'replaced'|'kept'|'off', changed: bool }.
 */
export function applyEdit(S, { rename = {}, plan = null, weekReplace = false } = {}, opts = {}) {
  const renamed = [], kept = [], missing = [];
  const routines = Array.isArray(S.routines) ? S.routines.filter(isMap) : [];
  const progs = isMap(S.programmes) ? Object.values(S.programmes).filter(isMap) : [];
  // The name a rename writes: NFKC, trimmed (audit 23 Nov 2026: it was stored exactly as typed).
  const target = v => String(v).normalize('NFKC').trim().slice(0, 80);
  const entries = Object.entries(rename);
  // Match every key against the ORIGINAL names first, so a chain (A -> B, B -> C) renames each routine once.
  const hits = entries.map(([o]) => ({ rs: routines.filter(r => nameKey(r.name) === nameKey(o)), ps: progs.filter(p => nameKey(p.name) === nameKey(o)) }));
  // Which renames go ahead. A routine's old name is only free for another rename when that routine
  // really leaves it (its own rename goes ahead), so drop clashing renames until nothing clashes;
  // dropping one only frees fewer names, so this ends. A second key for the same name (case or NFKC)
  // is kept. Review fix 23 Nov 2026: before this, a rename onto a name whose rename was kept or a
  // no-op made two routines with the same name.
  // A rename is a no-op only when every name it hits is already exactly the new one, so a
  // case-only rename ("push day" -> "Push Day") goes ahead (audit 23 Nov 2026: it was dropped).
  const noop = i => [...hits[i].rs, ...hits[i].ps].every(x => x.name === target(entries[i][1]));
  const go = new Set(), seen = new Set();
  entries.forEach(([o], i) => {
    if ((hits[i].rs.length || hits[i].ps.length) && !noop(i) && !seen.has(nameKey(o))) go.add(i);
    seen.add(nameKey(o));
  });
  for (let again = true; again;) {
    again = false;
    const leaving = new Set([...go].filter(i => hits[i].rs.length).map(i => nameKey(entries[i][0])));
    const taken = new Set(routines.map(r => nameKey(r.name)).filter(k => !leaving.has(k)));
    for (const i of go) {
      if (!hits[i].rs.length) continue;
      const k = nameKey(entries[i][1]);
      if (taken.has(k)) { go.delete(i); again = true; break; }
      taken.add(k);
    }
  }
  entries.forEach(([oldName, newName], i) => {
    const { rs, ps } = hits[i];
    if (!rs.length && !ps.length) { missing.push(oldName); return; }
    if (noop(i)) return; // already exactly the name wanted: nothing to do
    if (!go.has(i)) { kept.push(oldName); return; }
    const nn = target(newName);
    for (const r of rs) r.name = nn;
    for (const p of ps) p.name = nn;
    renamed.push([oldName, nn]);
  });
  let did = null, week = 'off', weekUnmatched;
  const days = w => JSON.stringify(WEEK_DAYS.map(d => (isMap(w) ? [].concat(w[d] ?? []) : [])));
  const before = days(S.week);
  if (plan) {
    // A week replace from a plan that schedules none of its own routines would wipe the profile's
    // week to all rest days: refuse that part (audit 23 Nov 2026).
    const planIds = new Set(plan.routines.map(r => String(r.id)));
    const planDays = WEEK_DAYS.filter(d => Object.hasOwn(plan.week, d) && [].concat(plan.week[d]).some(x => planIds.has(String(x))));
    if (weekReplace && !planDays.length) { weekReplace = false; week = 'kept'; weekUnmatched = []; }
    did = mergeInto(S, plan, { schedule: weekReplace ? 'replace' : false, ...opts });
    if (did.status === 'unit') return { renamed, kept, missing, plan: did, week, changed: false, unit: true };
    if (did.status === 'already' && weekReplace) {
      const byName = new Map();
      for (const r of Array.isArray(S.routines) ? S.routines.filter(isMap) : []) if (!byName.has(nameKey(r.name))) byName.set(nameKey(r.name), r.id);
      const ridMap = idMap();
      for (const r of plan.routines) if (byName.has(nameKey(r.name))) ridMap[r.id] = byName.get(nameKey(r.name));
      // Every routine the plan's week names must be in the profile, or the week is left as it is
      // (a partly-present plan would otherwise lose those days silently; audit 23 Nov 2026).
      const used = new Set(planDays.flatMap(d => [].concat(plan.week[d]).map(String)));
      weekUnmatched = plan.routines.filter(r => used.has(String(r.id)) && !ridMap[r.id]).map(r => r.name);
      if (weekUnmatched.length) return { renamed, kept, missing, plan: did, week: 'kept', weekUnmatched, changed: renamed.length > 0 };
      // Like mergeInto: keep the week's other keys, replace only the day lists.
      const next = { ...(isMap(S.week) ? S.week : {}) };
      for (const d of WEEK_DAYS) delete next[d];
      for (const [d, v] of Object.entries(plan.week)) {
        if (!WEEK_DAYS.includes(d)) continue;
        const ids = [].concat(v).map(x => ridMap[x]).filter(Boolean);
        if (ids.length) next[d] = ids;
      }
      S.week = next;
      week = days(next) === before ? 'unchanged' : 'replaced';
    } else if (did.status === 'added' && week !== 'kept') week = did.week === 'set' || did.week === 'replaced' ? 'replaced' : did.week;
  }
  const changed = renamed.length > 0 || did?.status === 'added' || week === 'replaced';
  return { renamed, kept, missing, plan: did, week, changed, ...(weekUnmatched ? { weekUnmatched } : {}) };
}
