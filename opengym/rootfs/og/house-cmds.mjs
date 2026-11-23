// openGym app: the house's commands on openGym's own admin socket (23 Nov 2026).
//
// openGym's admin socket (/app/admin-socket.js) is a Unix socket only the API's own user can open,
// in a 0700 directory; nothing listens on the network. Upstream answers one command ("recover").
// The Dockerfile adds one line in server.js so that commands named "house.*" come here, with the
// server's own in-memory data and functions. This is the safe way in: the server keeps db.json and
// the state files in memory and would overwrite any change made to them behind its back
// (admin-socket.js says so), so every change below goes through the server's own code, in its own
// process, saved and audited like an admin's or an API token's change.
//
// Commands (one JSON line in, one out; the sidecar house.mjs is the only caller):
//   house.users            profiles: id, name, created, owner, disabled, whether a document exists,
//                          and the NOTE of the invite they used (never the code)
//   house.invite {tag,label}  an invite code for a person, made exactly like the admin dashboard's
//                          "New code" (POST /api/admin/invites/new): note "house:<tag> <label>".
//                          One per tag: an unused one is returned again, never a second one.
//   house.plan {uid, file, schedule, dryRun, tag}
//                          merges the plan file /config/plans/<file> into that profile (plan-merge.mjs) and writes it with
//                          commitState(..., { overRead: true, stamped: false }), the same write as
//                          PUT /api/token/data. Refused for a profile with no document on the server.
//   house.rename {uid, prefix}  takes a name prefix (e.g. "Home · ") off that profile's routines and
//                          programmes, through the same write as house.plan (backup first). A name
//                          that would equal one of the profile's other routines is left as it is.
//                          Logged workouts are never touched.
//   house.edit {uid, id, rename, file, weekReplace, dryRun}
//                          a one-off edit in ONE read-modify-write (the sidecar applies each edit id once):
//                          renames routines/programmes by exact name (a rename that would clash with another
//                          routine is left as it is and listed in `kept`; unknown names in `missing`), then
//                          optionally merges the plan file /config/plans/<file> (renames first, so a renamed
//                          routine counts as already there), and with weekReplace sets the profile's week from
//                          that plan even when it has one. The logic is applyEdit() in plan-merge.mjs. One
//                          backup copy, one commitState, one audit line. Logged workouts are never touched.
//   house.live {uid}       the profile's live-workout heartbeat (POST /api/activity), or null
//   house.stats {uid, today}  workouts and sets of this week and last week (Sunday to Saturday,
//                          the house's week), the app's own week streak, and the last workout's id.
// Nothing here can read or change another profile than the uid it is given, and there is no
// command that returns training data beyond the counts above.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readPlan, mergeInto, applyEdit } from './plan-merge.mjs';
import { streakWeeks } from '/app/trainers/projections.js';
import { workoutPayload } from '/app/integrations/events.js';

const TAG_RX = /^[a-z][a-z0-9-]{1,20}$/;
const ISO_RX = /^\d{4}-\d{2}-\d{2}$/;
const UID_RX = /^[A-Za-z0-9_-]{1,80}$/;
const EDIT_ID_RX = /^[a-z0-9][a-z0-9-]{1,39}$/;
const FILE_RX = /^[a-z0-9][a-z0-9-]{0,60}\.json$/;
export const PLAN_DIR = '/config/plans';
export const BACKUP_DIR = '/data/opengym/house/backups';
const PLAN_MAX = 512 * 1024;
const NOTE = (tag, label) => `house:${tag} ${String(label || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim()}`.slice(0, 60);
const tagOfNote = note => (/^house:([a-z][a-z0-9-]{1,20})(\s|$)/.exec(String(note || '')) || [])[1] || null;

const DAY = 86400000;
const ms = d => Date.parse(d + 'T12:00:00Z');
const iso = t => new Date(t).toISOString().slice(0, 10);
const addDays = (d, n) => iso(ms(d) + n * DAY);
/** The Sunday of the Sunday-to-Saturday week `d` falls in. */
export const sundayOf = d => addDays(d, -new Date(ms(d)).getUTCDay());

function userOf(ctx, uid) {
  if (typeof uid !== 'string' || !UID_RX.test(uid)) return null;
  return ctx.db.users.find(u => u.id === uid) || null;
}

/** Counts for the days [from, to] (ISO, inclusive) of a document's workouts. */
export function tally(S, from, to) {
  let workouts = 0, sets = 0, minutes = 0;
  for (const w of Array.isArray(S?.workouts) ? S.workouts : []) {
    if (!w || typeof w !== 'object' || typeof w.d !== 'string' || !ISO_RX.test(w.d.slice(0, 10))) continue;
    const d = w.d.slice(0, 10);
    if (d < from || d > to) continue;
    workouts++;
    const p = workoutPayload(w, S);
    sets += p.totals.sets || 0;
    minutes += p.durationMin || 0;
  }
  return { start: from, end: to, workouts, sets, minutes };
}

export async function handle(msg, ctx) {
  const { db, saveDb, audit, CLI_REQ } = ctx;
  const owner = db.users.find(u => ctx.isOwner(u)) || null;
  switch (msg.cmd) {
    case 'house.users': {
      return {
        users: db.users.map(u => {
          const inv = u.invitedBy ? db.invites.find(i => i.code === u.invitedBy) : null;
          const S = ctx.readStateStrict(u.id);
          return {
            id: u.id, name: String(u.name || '').slice(0, 60), created: u.created || null,
            owner: ctx.isOwner(u), disabled: !!u.disabled, synced: !!S && S !== ctx.UNREADABLE,
            unit: S && S !== ctx.UNREADABLE ? (S.unit || 'kg') : null,
            inviteTag: inv ? tagOfNote(inv.note) : null, inviteNote: inv ? String(inv.note || '').slice(0, 60) : null,
          };
        }),
      };
    }
    case 'house.invite': {
      if (!TAG_RX.test(String(msg.tag || ''))) return { error: 'bad tag' };
      if (!owner) return { error: 'no owner profile yet' };
      const mine = db.invites.filter(i => tagOfNote(i.note) === msg.tag);
      const open = mine.find(i => !i.usedBy && !i.revoked);
      if (open) return { code: open.code, created: false, note: open.note };
      if (mine.some(i => i.usedBy) && msg.again !== true) return { error: 'already used', used: true };
      let code;
      do { code = crypto.randomBytes(8).toString('hex').toUpperCase(); } while (db.invites.some(i => i.code === code));
      const invite = { code, note: NOTE(msg.tag, msg.label), createdBy: owner.id, created: new Date().toISOString() };
      db.invites.push(invite);
      saveDb();
      // Audited like the dashboard's: the actor is the owner (whose house runs this); the code is
      // in the audit line exactly as upstream writes it for every invite.
      audit(CLI_REQ, 'admin.invite.create', { user: owner, msg: code });
      return { code, created: true, note: invite.note };
    }
    case 'house.plan': {
      const u = userOf(ctx, msg.uid);
      if (!u) return { error: 'no such profile' };
      if (u.disabled) return { error: 'profile disabled' };
      if (!FILE_RX.test(String(msg.file || ''))) return { error: 'bad file name' };
      let plan, text;
      try {
        const f = path.join(PLAN_DIR, msg.file);
        const st = fs.lstatSync(f);
        if (!st.isFile() || st.size > PLAN_MAX) return { error: 'plan file missing or too big' };
        text = fs.readFileSync(f, 'utf8');
      } catch { return { error: 'plan file missing' }; }
      try { plan = readPlan(text); } catch (e) { return { error: 'bad plan', code: e.code || 'bad', detail: String(e.message).slice(0, 120) }; }
      // Read, merge and write without an await in between, so no request can write in between
      // (the same rule as server.js writeStateAs).
      const cur = ctx.readStateStrict(u.id);
      if (cur === ctx.UNREADABLE) return { error: 'state unreadable' };
      if (!cur) return { error: 'not synced', code: 'not-synced' };
      const next = JSON.parse(JSON.stringify(cur));
      const did = mergeInto(next, plan, { schedule: msg.schedule !== false });
      if (did.status !== 'added' || msg.dryRun === true) return { ...did, dryRun: msg.dryRun === true, rev: cur._rev || 0 };
      // Rollback copy of the profile as it was, before the write (0600, the API user's own folder).
      fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
      const bak = path.join(BACKUP_DIR, `state-${u.id}-${Date.now()}.json`);
      fs.writeFileSync(bak, JSON.stringify(cur), { mode: 0o600, flag: 'wx' });
      for (const k of ['routines', 'customEx']) if (Array.isArray(next[k])) next[k] = ctx.records(next[k]);
      const done = ctx.commitState(u.id, cur, next, { overRead: true, stamped: false });
      if (done.status !== 200) return { error: 'write refused', status: done.status, body: done.body };
      audit(CLI_REQ, 'token.write', { user: u, msg: `house plan ${String(msg.tag || '').slice(0, 20)}: ${did.routines} routines` });
      return { ...did, rev: done.body.rev, backup: path.basename(bak), sha256: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) };
    }
    case 'house.rename': {
      const u = userOf(ctx, msg.uid);
      if (!u) return { error: 'no such profile' };
      if (u.disabled) return { error: 'profile disabled' };
      const prefix = typeof msg.prefix === 'string' ? msg.prefix : '';
      if (prefix.length < 2 || prefix.length > 30 || /[\u0000-\u001f]/.test(prefix)) return { error: 'bad prefix' };
      const cur = ctx.readStateStrict(u.id);
      if (cur === ctx.UNREADABLE) return { error: 'state unreadable' };
      if (!cur) return { error: 'not synced', code: 'not-synced' };
      const next = JSON.parse(JSON.stringify(cur));
      const key = s => String(s || '').normalize('NFKC').trim().toLowerCase();
      const routines = Array.isArray(next.routines) ? next.routines.filter(r => r && typeof r === 'object') : [];
      const others = new Set(routines.filter(r => !String(r.name || '').startsWith(prefix)).map(r => key(r.name)));
      const renamed = [], kept = [];
      for (const r of routines) {
        const name = String(r.name || '');
        if (!name.startsWith(prefix)) continue;
        const nn = name.slice(prefix.length).trim().slice(0, 80);
        if (!nn || others.has(key(nn))) { kept.push(name); continue; }
        r.name = nn;
        renamed.push([name, nn]);
      }
      const progs = next.programmes && typeof next.programmes === 'object' && !Array.isArray(next.programmes) ? Object.values(next.programmes) : [];
      for (const p of progs) {
        if (!p || typeof p !== 'object') continue;
        const name = String(p.name || '');
        if (!name.startsWith(prefix)) continue;
        const nn = name.slice(prefix.length).trim().slice(0, 80);
        if (!nn) { kept.push(name); continue; }
        p.name = nn;
        renamed.push([name, nn]);
      }
      const counts = {};
      for (const r of routines) counts[key(r.name)] = (counts[key(r.name)] || 0) + 1;
      const twice = Object.entries(counts).filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`).slice(0, 40);
      if (!renamed.length || msg.dryRun === true) return { status: renamed.length ? 'would rename' : 'nothing to rename', renamed, kept, twice, dryRun: msg.dryRun === true };
      fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
      const bak = path.join(BACKUP_DIR, `state-${u.id}-${Date.now()}.json`);
      fs.writeFileSync(bak, JSON.stringify(cur), { mode: 0o600, flag: 'wx' });
      for (const k of ['routines', 'customEx']) if (Array.isArray(next[k])) next[k] = ctx.records(next[k]);
      const done = ctx.commitState(u.id, cur, next, { overRead: true, stamped: false });
      if (done.status !== 200) return { error: 'write refused', status: done.status, body: done.body };
      audit(CLI_REQ, 'token.write', { user: u, msg: `house rename: ${renamed.length} names` });
      return { status: 'renamed', renamed, kept, twice, backup: path.basename(bak), rev: done.body.rev };
    }
    case 'house.edit': {
      const u = userOf(ctx, msg.uid);
      if (!u) return { error: 'no such profile' };
      if (u.disabled) return { error: 'profile disabled' };
      if (!EDIT_ID_RX.test(String(msg.id || ''))) return { error: 'bad edit id' };
      const ren = msg.rename == null ? {} : msg.rename;
      if (!ren || typeof ren !== 'object' || Array.isArray(ren) || Object.keys(ren).length > 60) return { error: 'bad rename map' };
      for (const [o, n] of Object.entries(ren)) {
        if (typeof n !== 'string' || !o.trim() || o.length > 80 || !n.trim() || n.length > 80 || /[\u0000-\u001f]/.test(o + n)) return { error: 'bad rename map' };
      }
      let plan = null, text = null;
      if (msg.file != null) {
        if (!FILE_RX.test(String(msg.file))) return { error: 'bad file name' };
        try {
          const f = path.join(PLAN_DIR, msg.file);
          const st = fs.lstatSync(f);
          if (!st.isFile() || st.size > PLAN_MAX) return { error: 'plan file missing or too big' };
          text = fs.readFileSync(f, 'utf8');
        } catch { return { error: 'plan file missing' }; }
        try { plan = readPlan(text); } catch (e) { return { error: 'bad plan', code: e.code || 'bad', detail: String(e.message).slice(0, 120) }; }
      } else if (msg.weekReplace === true) return { error: 'week replace needs a plan' };
      // Read, change and write without an await in between (see house.plan).
      const cur = ctx.readStateStrict(u.id);
      if (cur === ctx.UNREADABLE) return { error: 'state unreadable' };
      if (!cur) return { error: 'not synced', code: 'not-synced' };
      const next = JSON.parse(JSON.stringify(cur));
      const did = applyEdit(next, { rename: ren, plan, weekReplace: msg.weekReplace === true });
      if (did.unit) return { error: 'profile not in kg', plan: did.plan };
      const out = { renamed: did.renamed, kept: did.kept, missing: did.missing, plan: did.plan, week: did.week };
      if (!did.changed || msg.dryRun === true) return { status: did.changed ? 'would edit' : 'nothing to change', ...out, dryRun: msg.dryRun === true, rev: cur._rev || 0 };
      fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
      const bak = path.join(BACKUP_DIR, `state-${u.id}-${Date.now()}.json`);
      fs.writeFileSync(bak, JSON.stringify(cur), { mode: 0o600, flag: 'wx' });
      for (const k of ['routines', 'customEx']) if (Array.isArray(next[k])) next[k] = ctx.records(next[k]);
      const done = ctx.commitState(u.id, cur, next, { overRead: true, stamped: false });
      if (done.status !== 200) return { error: 'write refused', status: done.status, body: done.body };
      audit(CLI_REQ, 'token.write', { user: u, msg: `house edit ${msg.id}: ${did.renamed.length} names${did.plan?.status === 'added' ? `, plan ${did.plan.routines} routines` : ''}, week ${did.week}` });
      return { status: 'edited', ...out, backup: path.basename(bak), rev: done.body.rev };
    }
    case 'house.live': {
      const u = userOf(ctx, msg.uid);
      if (!u) return { error: 'no such profile' };
      const p = ctx.livePresence(u.id);
      return { live: p ? { name: String(p.name || '').slice(0, 60), setsDone: +p.setsDone || 0, setsTotal: +p.setsTotal || 0, startedAt: +p.startedAt || null } : null };
    }
    case 'house.stats': {
      const u = userOf(ctx, msg.uid);
      if (!u) return { error: 'no such profile' };
      if (!ISO_RX.test(String(msg.today || ''))) return { error: 'bad date' };
      const S = ctx.readStateStrict(u.id);
      if (S === ctx.UNREADABLE) return { error: 'state unreadable' };
      const doc = S || {};
      const sun = sundayOf(msg.today);
      const list = Array.isArray(doc.workouts) ? doc.workouts.filter(w => w && typeof w === 'object') : [];
      const last = list.reduce((a, w) => (!a || String(w.d) > String(a.d) || (w.d === a.d && (+w.end || 0) > (+a.end || 0)) ? w : a), null);
      return {
        today: msg.today,
        thisWeek: tally(doc, sun, addDays(sun, 6)),
        lastWeek: tally(doc, addDays(sun, -7), addDays(sun, -1)),
        streak: streakWeeks(doc, msg.today),
        total: list.length,
        lastId: last && last.id != null ? String(last.id).slice(0, 80) : null,
      };
    }
    default:
      return { error: 'unknown command' };
  }
}
