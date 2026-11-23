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
//   - programmes: added over the new routines, never started.
// House rules on top (stricter than the app):
//   - a plan whose routine names are already in the profile is not added again (no duplicates):
//     planMerge reports `already` and changes nothing;
//   - the week is only written when the profile has no week yet, so a week someone set is kept;
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
const clone = v => JSON.parse(JSON.stringify(v));
const clampInt = (v, [lo, hi, def]) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
const restSec = v => { const n = Math.round(Number(v)) || 0; return n > 0 ? n : 0; };
const half = v => Math.round(v * 2) / 2;

/** An id the way the app's uid() makes one (base36 time + 5 random base36 characters). */
export function newId(rand = crypto.randomBytes) {
  const r = BigInt('0x' + rand(4).toString('hex')).toString(36).padStart(5, '0').slice(-5);
  return Date.now().toString(36) + r;
}

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
  const programmes = Array.isArray(d.programmes) && !(Number(d.programme_fmt) > 1) ? d.programmes.filter(isMap).slice(0, 32) : [];
  return { name: String(d.name || '').trim(), routines, customEx, week: isMap(d.week) ? d.week : {}, programmes };
}

const nameKey = s => String(s || '').normalize('NFKC').trim().toLowerCase();

/** Which of the plan's routine names the profile already has. */
export function alreadyThere(S, plan) {
  const have = new Set((Array.isArray(S?.routines) ? S.routines : []).filter(isMap).map(r => nameKey(r.name)));
  return plan.routines.map(r => r.name).filter(n => have.has(nameKey(n)));
}

/**
 * Merges `plan` (from readPlan) into the document `S` (mutated; pass a copy). Returns what it did:
 *   { status: 'added', routines, customEx, programmes, week: 'set'|'kept'|'off' }
 *   { status: 'already', have: [names] }    nothing changed
 *   { status: 'unit' }                      profile not in kg, nothing changed
 */
export function mergeInto(S, plan, { schedule = true, now = Date.now(), id = newId } = {}) {
  if (S.unit != null && S.unit !== 'kg') return { status: 'unit', unit: String(S.unit).slice(0, 4) };
  const have = alreadyThere(S, plan);
  if (have.length) return { status: 'already', have };
  if (!Array.isArray(S.routines)) S.routines = [];
  if (!Array.isArray(S.customEx)) S.customEx = [];
  const exMap = {};
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
  const ridMap = {};
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
    if (hasWeek) week = 'kept';
    else {
      S.week = { ...cur };
      for (const d of WEEK_DAYS) delete S.week[d];
      for (const [d, v] of Object.entries(plan.week)) {
        if (!WEEK_DAYS.includes(d)) continue;
        const ids = [].concat(v).map(x => ridMap[x]).filter(Boolean);
        if (ids.length) S.week[d] = ids;
      }
      week = 'set';
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
