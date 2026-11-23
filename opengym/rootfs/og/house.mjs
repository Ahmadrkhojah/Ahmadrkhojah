// openGym app: the house sidecar (23 Nov 2026).
// Runs next to the API as the API's own user ("og"), started by run.sh once the API is up. It only
// talks to openGym's local admin socket (house-cmds.mjs) and, when a webhook id is set, POSTs small
// JSON events to Home Assistant's webhook at http://homeassistant:8123 (fixed, never configurable).
// It opens no port. If it stops, openGym keeps running; run.sh starts it again after 60 s.
//
// What it does, every POLL_MS:
//   1. Plans load themselves. /config/plans/manifest.json (this app's own config folder; on the host
//      /addon_configs/<slug>/plans/) names people: a tag, a label, how to find their profile (the
//      owner, the invite made for their tag, or their profile name) and a plan file in the same
//      folder. The first time a person's profile exists and has synced once, their plan is merged
//      in (house.plan), once. A plan already in the profile (same routine names) is never added again.
//   2. Invites ready to send. A person with `"invite": N` gets one invite code (house.invite), noted
//      "house:<tag> <label>". The code goes to /config/plans/invites.json (0600) and once to this app's
//      log; never to Home Assistant, git or the status file. Raising N makes a fresh code once.
//   3. The workout section follows openGym. The followed person's live-workout heartbeat (the app
//      sends it every 20 s while a workout is on screen) becomes {type:"live"} events: on at the
//      start, the sets done as they change, off when a new finished workout appears, or after
//      GONE_MS without a heartbeat (a locked phone can pause the heartbeat; it must not end it).
//   4. Weekly numbers. {type:"stats"} with this week's and last week's workouts and sets
//      (Sunday to Saturday, local time) and the app's own week streak, sent when they change and at
//      least every STATS_EVERY_MS. Home Assistant sends the Sunday recap from them.
//   5. One-off renames (rename_prefix) and one-off edits (edit): see the manifest notes below.
//      `"edit": {"id", "rename": {old: new}, "plan": "file.json", "week": "replace"}` is applied once
//      per edit id (house.edit: renames, then the optional plan, then the week replaced from that plan,
//      all in one backed-up write), after the person's own plan has been added. A new id applies again.
// State that must survive a restart: /data/opengym/house/state.json (applied plans, invite
// generations). Status for people and tools: /config/plans/status.json (no codes, no training data).
import fs from 'node:fs';
import path from 'node:path';

export const POLL_MS = 15000;
export const GONE_MS = 20 * 60000;
export const LIVE_REFRESH_MS = 120000;
export const STATS_EVERY_MS = 3 * 3600000;
const STATS_POLL_MS = 5 * 60000;
const USERS_EVERY = 4;
const PLAN_DIR = '/config/plans';
const STATE_DIR = '/data/opengym/house';
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const TAG_RX = /^[a-z][a-z0-9-]{1,20}$/;
const FILE_RX = /^[a-z0-9][a-z0-9-]{0,60}\.json$/;
const EDIT_ID_RX = /^[a-z0-9][a-z0-9-]{1,39}$/;
const HOOK_RX = /^[A-Za-z0-9_-]{16,128}$/;
// Control, zero-width, bidi-override and BOM characters: invisible in the app, so a name holding
// one looks like another name and never matches it (audit 23 Nov 2026).
const BAD_NAME_RX = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
// openGym's admin socket refuses a request line over 4096 characters (admin-socket.js MAX_LINE);
// the rename map must leave room for the rest of the house.edit message.
const RENAME_MAX_CHARS = 3200;
const log = (...a) => console.log('[house]', new Date().toISOString(), ...a);

/** Today's date in the house's time zone: UTC+3 all year, no DST (change UTC_OFFSET_H for another). */
export const UTC_OFFSET_H = 3;
export const localToday = (now = Date.now()) => new Date(now + UTC_OFFSET_H * 3600000).toISOString().slice(0, 10);
const nameKey = s => String(s || '').normalize('NFKC').trim().toLowerCase();
const label = s => String(s || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 30);

/** A person's `edit` field, checked strictly: { id, rename, plan, weekReplace } or { error }. */
export function readEdit(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { error: 'edit is not an object' };
  if (typeof e.id !== 'string' || !EDIT_ID_RX.test(e.id)) return { error: 'edit id must be 2-40 chars of a-z 0-9 -' };
  let rename = {};
  if (e.rename != null) {
    if (typeof e.rename !== 'object' || Array.isArray(e.rename)) return { error: 'edit rename is not a map' };
    const ents = Object.entries(e.rename);
    if (ents.length > 60) return { error: 'edit rename has more than 60 entries' };
    for (const [o, n] of ents) {
      if (typeof n !== 'string' || !o.trim() || o.length > 80 || !n.trim() || n.length > 80 || BAD_NAME_RX.test(o + n)) return { error: 'edit rename names must be 1-80 characters, no control or invisible characters' };
    }
    rename = Object.fromEntries(ents);
    if (JSON.stringify(rename).length > RENAME_MAX_CHARS) return { error: `edit rename is too long (at most ${RENAME_MAX_CHARS} characters as JSON; split it into two edits)` };
  }
  let plan = null;
  if (e.plan != null) {
    if (typeof e.plan !== 'string' || !FILE_RX.test(e.plan)) return { error: 'edit has a bad plan file name' };
    plan = e.plan;
  }
  if (e.week != null && e.week !== 'replace') return { error: 'edit week can only be "replace"' };
  if (e.week === 'replace' && !plan) return { error: 'edit week needs a plan' };
  if (!plan && !Object.keys(rename).length) return { error: 'edit has nothing to do' };
  return { id: e.id, rename, plan, weekReplace: e.week === 'replace' };
}

/** The manifest, checked; bad entries are left out with a reason. Never throws. */
export function readManifest(text) {
  let m;
  try { m = JSON.parse(text); } catch { return { people: [], follow: null, dryRun: true, problems: ['manifest is not JSON'] }; }
  const problems = [];
  const people = [];
  for (const p of Array.isArray(m?.people) ? m.people : []) {
    if (!p || !TAG_RX.test(String(p.tag || ''))) { problems.push('a person has no valid tag'); continue; }
    if (people.some(x => x.tag === p.tag)) { problems.push(`tag ${p.tag} twice`); continue; }
    const plan = p.plan == null ? null : String(p.plan);
    if (plan && !FILE_RX.test(plan)) { problems.push(`${p.tag}: bad plan file name`); continue; }
    const match = p.match && typeof p.match === 'object' ? p.match : {};
    let edit = null;
    if (p.edit != null) {
      const r = readEdit(p.edit);
      if (r.error) problems.push(`${p.tag}: ${r.error}`); else edit = r;
    }
    people.push({
      tag: p.tag, label: label(p.label) || p.tag, plan, schedule: p.schedule !== false,
      owner: match.owner === true,
      names: (Array.isArray(match.names) ? match.names : []).map(nameKey).filter(Boolean).slice(0, 5),
      invite: Number.isInteger(p.invite) && p.invite > 0 ? p.invite : 0,
      edit,
      renamePrefix: typeof p.rename_prefix === 'string' && p.rename_prefix.length >= 2 && p.rename_prefix.length <= 30 ? p.rename_prefix : null,
    });
  }
  const follow = people.some(p => p.tag === m?.follow) ? m.follow : null;
  return { people, follow, dryRun: m?.dry_run === true, problems };
}

/** Which profile is a person's: the owner, else the one that used their tag's invite, else by name. */
export function findUser(person, users, taken = new Set()) {
  const free = users.filter(u => !u.disabled && !taken.has(u.id));
  if (person.owner) return free.find(u => u.owner) || null;
  return free.find(u => !u.owner && u.inviteTag === person.tag)
    || free.find(u => !u.owner && !u.inviteTag && person.names.includes(nameKey(u.name)))
    || null;
}

/**
 * The live-workout state machine. `prev` is the last state ({ live, since, goneAt, sets, sentAt,
 * baseTotal, baseLast }); returns { next, event } where event is null or what to send.
 */
export function liveStep(prev, live, stats, now) {
  const p = prev || { live: false };
  if (live) {
    if (!p.live) {
      return { next: { live: true, since: now, goneAt: null, sets: live.setsDone, sentAt: now, baseTotal: stats?.total ?? null, baseLast: stats?.lastId ?? null },
        event: { type: 'live', live: true, sets: live.setsDone, sets_total: live.setsTotal, name: live.name, started_at: live.startedAt } };
    }
    const changed = live.setsDone !== p.sets || p.goneAt;
    if (changed || now - p.sentAt >= LIVE_REFRESH_MS) {
      return { next: { ...p, goneAt: null, sets: live.setsDone, sentAt: now },
        event: { type: 'live', live: true, sets: live.setsDone, sets_total: live.setsTotal, name: live.name, started_at: live.startedAt } };
    }
    return { next: { ...p, goneAt: null }, event: null };
  }
  if (!p.live) return { next: p, event: null };
  const goneAt = p.goneAt || now;
  const finished = !!stats && p.baseTotal != null && (stats.total !== p.baseTotal || stats.lastId !== p.baseLast);
  if (finished) return { next: { live: false }, event: { type: 'live', live: false, finished: true } };
  if (now - goneAt >= GONE_MS) return { next: { live: false }, event: { type: 'live', live: false, finished: false } };
  return { next: { ...p, goneAt }, event: null };
}

/** The stats event sent to Home Assistant (numbers only). */
export function statsEvent(s) {
  const wk = w => ({ start: w.start, end: w.end, workouts: w.workouts, sets: w.sets, minutes: w.minutes });
  return { type: 'stats', today: s.today, this_week: wk(s.thisWeek), last_week: wk(s.lastWeek), streak_weeks: s.streak };
}

/* ------------------------------------------------------------------ the running part */

function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, value, mode = 0o600) {
  const tmp = `${file}.tmp`;
  // A .tmp left by a crash (or put there by someone else) keeps ITS mode under writeFileSync's
  // `mode`, so remove it and create the file fresh (audit 23 Nov 2026; prepare.mjs does the same).
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode, flag: 'wx' });
  fs.renameSync(tmp, file);
}

let askAdminSocket = null; // openGym's own client (/app/admin-socket.js), loaded in main() so tests can import this file
async function ask(msg) {
  const r = await askAdminSocket(msg, { timeoutMs: 10000 });
  if (r && r.error) throw Object.assign(new Error(r.error), { answer: r });
  return r;
}

let hook = null;
const hookErrors = new Map();
async function post(event) {
  if (!hook) return false;
  try {
    const res = await fetch(`http://homeassistant:8123/api/webhook/${hook}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    hookErrors.delete(event.type);
    return true;
  } catch (e) {
    if (!hookErrors.has(event.type)) log(`webhook ${event.type} not delivered (${e.message}); will retry quietly`);
    hookErrors.set(event.type, Date.now());
    return false;
  }
}

async function main() {
  ({ askAdminSocket } = await import('/app/admin-socket.js'));
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const cfg = loadJson('/tmp/og/house.json', {});
  hook = HOOK_RX.test(String(cfg.webhook || '')) ? cfg.webhook : null;
  log(`started; Home Assistant events ${hook ? 'on' : 'off (no house_webhook option)'}`);
  const st = loadJson(STATE_FILE, {});
  st.applied = st.applied || {};
  st.invites = st.invites || {};
  let lastStatus = '';
  let live = { live: false };
  let stats = null, statsAt = 0, statsSent = '', statsSentAt = 0;
  let users = null, tick = 0;

  for (;;) {
    const status = { updated: new Date().toISOString(), webhook: !!hook, problems: [], people: {} };
    try {
      const manifestText = fs.existsSync(path.join(PLAN_DIR, 'manifest.json')) ? fs.readFileSync(path.join(PLAN_DIR, 'manifest.json'), 'utf8') : null;
      const man = manifestText ? readManifest(manifestText) : { people: [], follow: null, dryRun: true, problems: ['no manifest'] };
      status.problems.push(...man.problems);
      status.dryRun = man.dryRun;
      // The profile list (it reads every profile's file) only every USERS_EVERY polls.
      if (!users || ++tick % USERS_EVERY === 0) users = (await ask({ cmd: 'house.users' })).users;
      const taken = new Set();
      // One decision per poll: which profile is whose. The rename, edit and follow steps use this
      // map, never their own findUser call, so two people can never act on one profile (audit 23 Nov 2026).
      const userOfTag = new Map();

      for (const person of man.people) {
        const row = { label: person.label };
        status.people[person.tag] = row;
        // Invite codes
        if (person.invite && !person.owner && (st.invites[person.tag]?.gen || 0) < person.invite && man.dryRun) {
          row.inviteDryRun = 'would make an invite code';
        } else if (person.invite && !person.owner && (st.invites[person.tag]?.gen || 0) < person.invite) {
          try {
            const r = await ask({ cmd: 'house.invite', tag: person.tag, label: person.label, again: person.invite > 1 });
            const codes = loadJson(path.join(PLAN_DIR, 'invites.json'), {});
            codes[person.tag] = { label: person.label, code: r.code, created: new Date().toISOString() };
            writeJson(path.join(PLAN_DIR, 'invites.json'), codes, 0o600);
            st.invites[person.tag] = { gen: person.invite, at: new Date().toISOString() };
            writeJson(STATE_FILE, st);
            // The one place a code is printed, like the first-profile invite (Home Assistant admins only).
            log(`invite code for ${person.label}: ${r.code}   (one use; also in plans/invites.json)`);
          } catch (e) {
            if (e.answer?.used) { st.invites[person.tag] = { gen: person.invite, at: new Date().toISOString(), used: true }; writeJson(STATE_FILE, st); }
            else row.inviteError = e.message;
          }
        }
        row.invite = st.invites[person.tag] ? (st.invites[person.tag].used ? 'used' : 'made') : (person.invite ? 'pending' : 'none');
        // Their profile
        const u = findUser(person, users, taken);
        if (u) taken.add(u.id);
        userOfTag.set(person.tag, u);
        row.profile = u ? (u.synced ? 'synced' : 'made, not synced yet') : 'not yet';
        if (u?.inviteTag === person.tag) row.invite = 'used';
        // Their plan
        const done = st.applied[person.tag];
        if (done) {
          row.plan = done.status; row.planAt = done.at;
          row.result = { routines: done.routines ?? null, programmes: done.programmes ?? null, customEx: done.customEx ?? null, week: done.week ?? null, have: done.have ?? null, backup: done.backup || null };
        }
        else if (!person.plan) row.plan = 'none';
        else if (!u || !u.synced) row.plan = 'waiting for the profile';
        else {
          try {
            const r = await ask({ cmd: 'house.plan', uid: u.id, file: person.plan, schedule: person.schedule, dryRun: man.dryRun, tag: person.tag });
            row.plan = man.dryRun ? `dry run: would be ${r.status}` : r.status;
            row.result = { routines: r.routines ?? null, programmes: r.programmes ?? null, customEx: r.customEx ?? null, week: r.week ?? null, have: r.have ? r.have.length : null, backup: r.backup || null };
            if (!man.dryRun) {
              st.applied[person.tag] = { status: r.status, uid: u.id, at: new Date().toISOString(), ...row.result, sha256: r.sha256 || null };
              writeJson(STATE_FILE, st);
              log(`plan ${person.plan} for ${person.label}: ${r.status}${r.routines ? ` (${r.routines} routines, week ${r.week})` : ''}`);
              tick = USERS_EVERY - 1; // fresh profile list next poll
              await post({ type: 'plan', tag: person.tag, label: person.label, status: r.status, routines: r.routines || 0, programmes: r.programmes || 0, week: r.week || null });
            }
          } catch (e) {
            row.plan = `not yet: ${e.message}`;
          }
        }
      }

      // One-off renames: take a name prefix off a person's routines and programmes, once per prefix.
      st.renamed = st.renamed || {};
      for (const person of man.people) {
        if (!person.renamePrefix) continue;
        const row = status.people[person.tag];
        const done = st.renamed[person.tag];
        if (done && done.prefix === person.renamePrefix) { row.rename = { status: done.status, at: done.at, count: done.renamed.length, renamed: done.renamed, kept: done.kept, twice: done.twice, backup: done.backup || null }; continue; }
        const u = userOfTag.get(person.tag);
        if (!u || !u.synced) { row.rename = { status: 'waiting for the profile' }; continue; }
        try {
          const r = await ask({ cmd: 'house.rename', uid: u.id, prefix: person.renamePrefix, dryRun: man.dryRun });
          row.rename = { status: r.status, count: r.renamed.length, renamed: r.renamed, kept: r.kept, twice: r.twice, backup: r.backup || null };
          if (!man.dryRun) {
            st.renamed[person.tag] = { prefix: person.renamePrefix, at: new Date().toISOString(), status: r.status, renamed: r.renamed, kept: r.kept, twice: r.twice, backup: r.backup || null };
            writeJson(STATE_FILE, st);
            log(`rename for ${person.label}: ${r.status}, ${r.renamed.length} names`);
          }
        } catch (e) { row.rename = { status: `not yet: ${e.message}` }; }
      }

      // One-off edits: renames, an extra plan and a week replace, once per edit id (after the person's own plan).
      st.edited = st.edited || {};
      for (const person of man.people) {
        const ed = person.edit;
        if (!ed) continue;
        const row = status.people[person.tag];
        const done = st.edited[person.tag]?.[ed.id];
        if (done) { row.edit = { id: ed.id, status: done.status, at: done.at, renamed: done.renamed, kept: done.kept, missing: done.missing, plan: done.plan, week: done.week, ...(done.weekUnmatched ? { weekUnmatched: done.weekUnmatched } : {}), backup: done.backup || null }; continue; }
        const u = userOfTag.get(person.tag);
        if (!u || !u.synced) { row.edit = { id: ed.id, status: 'waiting for the profile' }; continue; }
        if (person.plan && !st.applied[person.tag]) { row.edit = { id: ed.id, status: 'waiting for the plan' }; continue; }
        try {
          const r = await ask({ cmd: 'house.edit', uid: u.id, id: ed.id, rename: ed.rename, file: ed.plan, weekReplace: ed.weekReplace, dryRun: man.dryRun });
          const res = { status: r.status, renamed: r.renamed, kept: r.kept, missing: r.missing, plan: r.plan ? r.plan.status : null, week: r.week, ...(r.weekUnmatched ? { weekUnmatched: r.weekUnmatched } : {}), backup: r.backup || null };
          row.edit = { id: ed.id, ...res };
          if (!man.dryRun) {
            (st.edited[person.tag] = st.edited[person.tag] || {})[ed.id] = { at: new Date().toISOString(), ...res };
            writeJson(STATE_FILE, st);
            log(`edit ${ed.id} for ${person.label}: ${r.status}, ${r.renamed.length} names, week ${r.week}`);
            tick = USERS_EVERY - 1;
          }
        } catch (e) { row.edit = { id: ed.id, status: `not yet: ${e.message}` }; }
      }

      // Live workout + weekly numbers of the followed person
      const fp = man.people.find(p => p.tag === man.follow);
      const fu = fp ? userOfTag.get(fp.tag) || null : null;
      status.follow = fp ? { tag: fp.tag, profile: !!fu } : null;
      if (fu) {
        const now = Date.now();
        const { live: l } = await ask({ cmd: 'house.live', uid: fu.id });
        // Fresh numbers while a workout runs (the "finished" check) and at its start (the baseline).
        const needStats = !stats || now - statsAt >= STATS_POLL_MS || live.live || !!l || localToday(now) !== stats.today;
        if (needStats) { stats = await ask({ cmd: 'house.stats', uid: fu.id, today: localToday(now) }); statsAt = now; }
        const step = liveStep(live, l, stats, now);
        if (step.event) {
          const ok = await post(step.event);
          // An "off" that did not reach Home Assistant is sent again next time.
          live = (ok || step.event.live) ? step.next : live;
        } else live = step.next;
        status.follow.live = !!live.live;
        const ev = statsEvent(stats);
        const key = JSON.stringify(ev);
        if (key !== statsSent || now - statsSentAt >= STATS_EVERY_MS) {
          if (await post(ev)) { statsSent = key; statsSentAt = now; }
        }
      }
    } catch (e) {
      status.problems.push(`poll: ${e.message}`);
    }
    // The status file changes only when something in it does (besides the time).
    const { updated: _u, ...body } = status;
    const key = JSON.stringify(body);
    if (key !== lastStatus) {
      try { writeJson(path.join(PLAN_DIR, 'status.json'), status, 0o644); lastStatus = key; }
      catch (e) { if (!lastStatus.startsWith('!')) log(`status not written: ${e.message}`); lastStatus = '!' + key; }
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { log('stopped:', e.message); process.exit(1); });
}
