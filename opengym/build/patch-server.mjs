// Build-time patch of openGym's server.js (run once by the Dockerfile, not shipped): one line in
// front of the admin socket's "unknown command" sends "house.*" commands to /og/house-cmds.mjs with
// the server's own data and functions (rootfs/og/house-cmds.mjs explains why). Exits non-zero, and
// so fails the build, if upstream's line is not there exactly once or the patch did not land.
import fs from 'node:fs';
const file = process.argv[2] || '/app/server.js';
const OLD = "    if (!msg || msg.cmd !== 'recover') return { error: 'unknown command' };";
const NEW = "    if (msg && typeof msg.cmd === 'string' && msg.cmd.startsWith('house.')) return (await import('/og/house-cmds.mjs')).handle(msg, { db, saveDb, audit, CLI_REQ, readStateStrict, UNREADABLE, commitState, livePresence, isOwner, isAdmin, records });";
const src = fs.readFileSync(file, 'utf8');
const n = src.split(OLD).length - 1;
if (n !== 1) { console.error(`patch-server: expected the admin socket line once, found ${n}`); process.exit(1); }
if (!src.includes('startAdminSocket({') || !src.includes('function commitState(')) { console.error('patch-server: upstream changed'); process.exit(1); }
fs.writeFileSync(file, src.replace(OLD, NEW + '\n' + OLD));
console.log('patch-server: house commands wired into the admin socket');
