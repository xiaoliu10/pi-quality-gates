/**
 * Integration smoke: the settle-gate rework loop, verified end-to-end against
 * the bundled pi runtime (1.3.0) in RPC mode with a scripted OpenAI-compatible
 * server. Mirrors the shape proven in pi-desktop's tests/rpc-full-args-smoke.mjs.
 *
 * Scenario:
 *  - turn 1: model calls write (dirty flag set), then says "done"
 *  - agent_before_settle: verify.sh fails (SIMULATED-FAIL) → forced rework
 *  - rounds 2..3: more forced turns (anti-loop cap = 2), then an explicit
 *    "still failing / NOT verified" pass-through
 *
 * Asserts (run-don't-read):
 *  A) WITH the extension: >=4 provider requests; requests 3+ carry the
 *     quality-gates marker and the failing check output; hello.txt written.
 *  B) WITHOUT the extension (control): 2 requests only — no rework. This is
 *     the "fails when the feature breaks" half of the contract.
 *
 * Run: node test/smoke-rework.mjs
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { PiRpcClient } from '/Users/jason/projects/opensource/pi-desktop/src/main/pi/rpc-client.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = '/Users/jason/projects/opensource/pi-desktop/resources/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
if (!existsSync(cli)) { console.error('bundled pi cli not found; run from a machine with pi-desktop checked out'); process.exit(1); }

const childEnv = (extra = {}) => { const e = { ...process.env, ...extra }; delete e.PI_PACKAGE_DIR; delete e.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT; return e; };

// ── scripted provider ────────────────────────────────────────────────────────
const requests = [];
const projectDir = mkdtempSync(join(tmpdir(), 'pqg-smoke-proj-'));
const helloPath = join(projectDir, 'hello.txt');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => body += d);
  req.on('end', () => {
    requests.push(body); lastRequestAt = Date.now();
    // Request-count routing: exactly one scripted write call on the first
    // provider request, plain text afterwards. Matching on body content does
    // NOT work — pi's tool-result requests still contain the original write
    // call text, which loops the same tool forever and never settles.
    const isToolCallTurn = requests.length === 1;
    const wantsStream = /"stream"\s*:\s*true/.test(body);
    const reply = (obj) => {
      if (!wantsStream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const choice = obj.choices?.[0]?.message;
      if (choice?.tool_calls) {
        for (const tc of choice.tool_calls) res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: choice?.content ?? 'done' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n'); res.end();
    };
    // Key the scripted replies off the conversation: once a toolResult for
    // call_1 is in the request, stop calling tools and answer (otherwise pi
    // loops the same write forever and never reaches the settle boundary).
    if (isToolCallTurn) {
      reply({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: helloPath, content: 'hello' }) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      return;
    }
    reply({ choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ── fixture project + agent dir ──────────────────────────────────────────────
writeFileSync(join(projectDir, 'verify.sh'), '#!/bin/sh\necho SIMULATED-FAIL\nexit 1\n');
const agentDir = join(projectDir, 'agent'); mkdirSync(agentDir);
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false }, packages: [] }));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'offline-pqg': { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'dummy-local-only', models: [{ id: 'smoke', name: 'smoke', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 512 }] } } }));

const sessionDir = join(projectDir, 'sessions'); mkdirSync(sessionDir);
const sessionFile = join(sessionDir, 'smoke.jsonl');
const baseEnv = childEnv({ PI_CODING_AGENT_DIR: agentDir, PI_VERIFY_CMD: 'sh verify.sh' });
const baseArgs = ['--mode', 'rpc', '--session', sessionFile, '--session-dir', sessionDir, '--no-approve', '--model', 'smoke', '--tools', 'write'];

const seenTypes = [];
let lastRequestAt = Date.now();
async function run(withExtension) {
  requests.length = 0;
  const args = [cli, ...baseArgs];
  if (withExtension) args.push('-e', process.env.PQG_SMOKE_EXT || join(root, 'index.ts'));
  const client = new PiRpcClient(process.execPath, args, projectDir, baseEnv);
  const closed = new Promise((resolve) => client.on('closed', resolve));
  seenTypes.length = 0; lastRequestAt = Date.now();
  const events = [];
  client.on('event', (e) => { seenTypes.push(e.type); events.push(`${e.type}:${JSON.stringify(e).slice(0, 120)}`); lastRequestAt = Date.now(); });
  const res = await client.request('prompt', { message: 'write hello.txt with the word hello, then say done' }, 180000);
  // RPC `prompt` only reports "started". The settle boundary can force extra
  // turns, so waiting for the FIRST settled event is wrong (it fires before
  // rework). Wait until the provider has been quiet for a while, or the cap.
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (seenTypes.some((t) => /settled/.test(t)) && Date.now() - lastRequestAt > 10000) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (process.env.PQG_SMOKE_TRACE) console.error('TRACE: settled=', seenTypes.some(t=>/settled/.test(t)), 'lastReqAge=', Date.now()-lastRequestAt, 'events=', events.slice(-6).join(' | '));
  const transcriptTail = existsSync(sessionFile) ? readFileSync(sessionFile, 'utf8') : '';
  return { res, requests: requests.length, bodies: [...requests], client, closed, events, transcriptTail };
}

console.log('── A) with extension ──');
const a = await run(true);
console.error('A events:', a.events?.join(','));
console.error('A transcript tail:', (a.transcriptTail || '').slice(-600));
const marked = a.bodies.filter((b) => b.includes('quality-gates')).length;
const failShown = a.bodies.some((b) => b.includes('SIMULATED-FAIL'));
const stillFailing = a.bodies.some((b) => b.includes('NOT verified')) || a.bodies.some((b) => b.includes('quality-gates'));
const wrote = existsSync(helloPath) && readFileSync(helloPath, 'utf8').includes('hello');
console.log(`requests=${a.requests} gate-marked=${marked} failShown=${failShown} stillFailing=${stillFailing} wrote=${wrote}`);

await a.closed.catch(() => {});
console.log('── B) control (no extension) ──');
const b = await run(false);
console.log(`requests=${b.requests}`);

await b.closed.catch(() => {});
server.close();
let ok = true;
if (!(a.requests >= 4 && marked >= 2 && failShown && stillFailing && wrote)) { ok = false; console.error('FAIL: rework loop did not behave (A)'); }
if (!(b.requests === 2)) { ok = false; console.error(`FAIL: control run should be plain 2 requests (B), got ${b.requests}`); }
rmSync(projectDir, { recursive: true, force: true });
console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(ok ? 0 : 1);
