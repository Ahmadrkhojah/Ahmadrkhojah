// Claude Browser: Chromium sandbox probe.
//
// Started by run.sh as the same user (node) and with the same environment as Playwright MCP.
// It launches Chromium with the SAME launch options Playwright MCP will use (read from the
// generated config: browser name, channel, headless, args), so the answer is true for the
// browser that really runs, not for a different build. (0.1.0 launched with no channel, so
// Playwright picked "chromium-headless-shell", which this image does not ship: the probe always
// failed, the sandbox was switched off, and Playwright MCP's own launch would have failed the
// same way. 0.1.1 sets channel "chromium" = the full Chromium the image ships, new headless mode.)
//
// Usage: node sandbox-probe.mjs <pw-config.json> <path to playwright-core>
// Prints one JSON line: {"sandbox":bool,"starts":bool,"reason":string}
// Exit code: 0 sandbox works, 2 the container refuses the sandbox (sandboxed launch failed twice
// with a sandbox error and the unsandboxed launch works), 3 anything else. run.sh keeps the sandbox ON for anything but 2 (fail closed).
// Not copied from the MCP launch: --disable-blink-features, tracesDir and signal handling; none of
// them touch the sandbox.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [configPath, corePath] = process.argv.slice(2);
// Playwright puts Chromium's own log in the error text; these words mean the sandbox itself failed.
const SANDBOX_ERROR = /sandboxing failed|no usable sandbox|zygote|namespace|setuid|seccomp|CLONE_NEWUSER|running as root without --no-sandbox/i;
const firstLine = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 300);

function report(result, code) {
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(code);
}

let pw;
let base;
try {
  pw = createRequire(import.meta.url)(corePath);
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  const name = cfg?.browser?.browserName ?? 'chromium';
  if (name !== 'chromium') report({ sandbox: false, starts: false, reason: `unexpected browserName ${name}` }, 3);
  // Same options as the real launch, except the proxy points at a dead port: the filtering proxy
  // is not running yet, and any stray background request must fail rather than go out directly.
  base = { ...(cfg.browser.launchOptions ?? {}), proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' } };
} catch (e) {
  report({ sandbox: false, starts: false, reason: `probe setup failed: ${firstLine(e)}` }, 3);
}

async function tryLaunch(chromiumSandbox) {
  const browser = await pw.chromium.launch({ ...base, chromiumSandbox, timeout: 30000 });
  try {
    // A page proves the renderer (the sandboxed process) really starts, not only the browser.
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.setContent('<p>ok</p>');
  } finally {
    await browser.close();
  }
}

// A slow first start (cold Pi) must not switch the sandbox off: the sandboxed launch gets two tries.
let sandboxError = '';
let sandboxRefused = false;
for (let attempt = 1; attempt <= 2; attempt++) {
  try {
    await tryLaunch(true);
    report({ sandbox: true, starts: true, reason: attempt === 1 ? 'sandbox works' : 'sandbox works (second try)' }, 0);
  } catch (e) {
    sandboxError = firstLine(e);
    sandboxRefused = SANDBOX_ERROR.test(String(e?.message ?? e));
  }
}
// A failure that is not about the sandbox (timeout, out of memory) never switches it off.
if (!sandboxRefused) report({ sandbox: false, starts: false, reason: `sandboxed launch failed, not a sandbox error: ${sandboxError}` }, 3);
try {
  await tryLaunch(false);
  report({ sandbox: false, starts: true, reason: sandboxError }, 2);
} catch (e2) {
  report({ sandbox: false, starts: false, reason: firstLine(e2) }, 3);
}
