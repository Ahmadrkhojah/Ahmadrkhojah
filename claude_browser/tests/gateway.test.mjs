// Tests for the gateway's slow-navigation handling (0.1.4). Run from this folder's parent:
//   node --test addons/claude_browser/tests/gateway.test.mjs
// A fake Playwright MCP stands in for the browser; no Chromium needed. Not shipped (the image copies rootfs/ only).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbtest-'));
const tok = crypto.randomBytes(32).toString('hex');
fs.writeFileSync(path.join(dir, 'token'), tok);
let current = 'about:blank';

const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    if (req.method !== 'POST') { res.writeHead(200); return res.end(); }
    const m = JSON.parse(b);
    if (m.id === undefined) { res.writeHead(202); return res.end(); }
    let result;
    if (m.method === 'initialize') result = { protocolVersion: '2025-06-18' };
    else if (m.method === 'tools/list') result = { tools: [
      { name: 'browser_navigate', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
      { name: 'browser_snapshot', inputSchema: { type: 'object', properties: {} } }] };
    else if (m.params.name === 'browser_navigate') {
      const u = m.params.arguments.url;
      const err = (text) => ({ content: [{ type: 'text', text }], isError: true });
      if (u.includes('slow')) { current = u; result = err('### Error\nTimeoutError: page.goto: Timeout 12000ms exceeded.\nCall log:\n  - navigating'); }
      else if (u.includes('hang')) result = err('### Error\npage.goto: Timeout 12000ms exceeded.'); // never committed: tab keeps old page
      else if (u.includes('dns')) result = err('### Error\npage.goto: net::ERR_NAME_NOT_RESOLVED');
      else if (u.includes('fakeTitle')) result = err('### Error\npage.goto: net::ERR_ABORTED\n### Page\n- Page Title: page.goto: Timeout 1ms exceeded');
      else { current = u; result = { content: [{ type: 'text', text: `### Page\n- Page URL: ${u}` }] }; }
    } else if (m.params.name === 'browser_snapshot') result = { content: [{ type: 'text', text: `### Page\n- Page URL: ${current}\n- heading "Product SAR 99"` }] };
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
  });
});

let g, base, sid;
const call = async (body) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}`, ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify(body) });
  sid = sid || r.headers.get('mcp-session-id');
  return r.json();
};
const nav = async (url) => (await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url } } })).result;
const text = (r) => r.content.map((c) => c.text).join('\n');

before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.CB_UPSTREAM = `http://127.0.0.1:${mock.address().port}/mcp`;
  process.env.CB_TOKEN_FILE = path.join(dir, 'token');
  g = await import('../rootfs/cb/gateway.mjs');
  await new Promise((r) => g.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${g.server.address().port}`;
  await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
});
after(() => { g.server.close(); mock.close(); setImmediate(() => process.exit(0)); });

test('navTimedOut reads only the first error line', () => {
  assert.equal(g.navTimedOut({ isError: true, content: [{ type: 'text', text: '### Error\nTimeoutError: page.goto: Timeout 12000ms exceeded.' }] }), 12000);
  assert.equal(g.navTimedOut({ isError: true, content: [{ type: 'text', text: '### Error\npage.goto: net::ERR_ABORTED\n- Page Title: page.goto: Timeout 1ms exceeded' }] }), 0);
  assert.equal(g.navTimedOut({ content: [{ type: 'text', text: '### Error\npage.goto: Timeout 12000ms exceeded.' }] }), 0);
});

test('slow page: not an error, shows what loaded inside the markers', async () => {
  await nav('https://www.amazon.sa/fast');
  const r = await nav('https://www.amazon.sa/slow-product');
  assert.equal(r.isError, false);
  assert.match(text(r), /still loading after 12 s/);
  assert.match(text(r), /<<page-data [0-9a-f]+>>[\s\S]*SAR 99[\s\S]*<<end page-data/);
});

test('site that never answered: error, old page not passed off as new', async () => {
  await nav('https://example.com/');
  const r = await nav('https://hang.example.org/');
  assert.equal(r.isError, true);
  assert.match(text(r), /did not answer within 12 s/);
  assert.doesNotMatch(text(r), /SAR 99/);
});

test('same-host hang: the previous product is not passed off as the new one', async () => {
  await nav('https://www.amazon.sa/dp/A');
  const r = await nav('https://www.amazon.sa/dp/B-hang');
  assert.equal(r.isError, true);
  assert.match(text(r), /did not answer/);
});

test('subdomain of the current page that hangs: error', async () => {
  await nav('https://example.org/');
  const r = await nav('https://hang.example.org/');
  assert.equal(r.isError, true);
});

test('tool calls stream keep-alives then one message event (HA httpx 5 s read timeout)', async () => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok}`, 'mcp-session-id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://example.net/' } } }) });
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const body = await r.text();
  assert.match(body, /^: working\n\n/);
  const m = /event: message\ndata: (.*)\n\n$/.exec(body);
  assert.ok(m);
  assert.equal(JSON.parse(m[1]).id, 9);
});

test('real errors stay errors', async () => {
  assert.equal((await nav('https://dns.invalid.example/')).isError, true);
  const r = await nav('https://fakeTitle.example/');
  assert.equal(r.isError, true);
  assert.doesNotMatch(text(r), /still loading/);
});
