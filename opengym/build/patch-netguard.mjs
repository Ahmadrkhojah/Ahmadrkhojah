// Build-time patch of openGym's net-guard.js (run once by the Dockerfile, after the
// ALLOWED_PRIVATE_IPS narrowing). Audit 23 Nov 2026: ALLOWED_PRIVATE_IPS 172.30.32.0/31 is the
// host's Supervisor-network address, so a plain-http webhook could reach EVERY port the host
// publishes (ha-mcp 9583, Mosquitto 1883, Google Drive Backup 1627, z2m 8485/8486, openGym 8780
// itself), not only Home Assistant, and its answer code told the sender which ports are open.
// This pins plain http:// webhooks to Home Assistant's own port 8123. Fails the build if the
// anchor is not there exactly once.
import fs from 'node:fs';
const file = process.argv[2] || '/app/net-guard.js';
const OLD = "  if (!host) return 'url is not valid';\n";
const NEW = OLD + "  if (plain && (u.port || '80') !== '8123') return 'plain http:// webhooks may only go to Home Assistant on port 8123';\n";
const src = fs.readFileSync(file, 'utf8');
const n = src.split(OLD).length - 1;
if (n !== 1) { console.error(`patch-netguard: expected the host line once, found ${n}`); process.exit(1); }
fs.writeFileSync(file, src.replace(OLD, NEW));
if (!fs.readFileSync(file, 'utf8').includes("(u.port || '80') !== '8123'")) { console.error('patch-netguard: did not land'); process.exit(1); }
console.log('patch-netguard: plain http webhooks pinned to port 8123');
