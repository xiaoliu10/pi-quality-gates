import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCheckCommands, default as qualityGates } from '../index.ts';
import type { PiExtensionAPI } from '../src/pi/pi-types.ts';
import type { VerificationRun } from '../src/core/settle.ts';

describe('resolveCheckCommands', () => {
  it('env wins and supports comma-separated battery', () => {
    const cmds = resolveCheckCommands('/any', { PI_VERIFY_CMD: 'npx tsc --noEmit, npx vitest run' });
    expect(cmds).toEqual([
      { name: 'npx', command: 'npx tsc --noEmit' },
      { name: 'npx', command: 'npx vitest run' },
    ]);
  });

  it('discovers verify.sh then .pi/verify.sh; none → empty (no-op)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pqg-disc-'));
    try {
      expect(resolveCheckCommands(cwd, {})).toEqual([]);
      writeFileSync(join(cwd, 'verify.sh'), '#!/bin/sh\n');
      expect(resolveCheckCommands(cwd, {})).toEqual([{ name: 'verify.sh', command: 'sh verify.sh' }]);
      rmSync(join(cwd, 'verify.sh'));
      mkdirSync(join(cwd, '.pi'));
      writeFileSync(join(cwd, '.pi', 'verify.sh'), '#!/bin/sh\n');
      expect(resolveCheckCommands(cwd, {})).toEqual([{ name: 'verify.sh', command: 'sh .pi/verify.sh' }]);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

describe('extension shell wiring', () => {
  it('PI_QUALITY_GATES=off registers no handlers', () => {
    const handlers: Record<string, unknown> = {};
    const pi = { on: (evt: string) => { handlers[evt] = true; } } as unknown as PiExtensionAPI;
    qualityGates(pi, { env: { PI_QUALITY_GATES: 'off' } });
    expect(Object.keys(handlers)).toEqual([]);
  });

  it('registers tool_call / agent_before_settle / tool_result when enabled', () => {
    const handlers: string[] = [];
    const pi = { on: (evt: string) => handlers.push(evt) } as unknown as PiExtensionAPI;
    qualityGates(pi, { env: {} });
    expect(handlers).toEqual(['tool_call', 'agent_before_settle', 'tool_result']);
  });
});

describe('pluggable verifier', () => {
  it('a custom verifier is consulted and its VerificationRun flows through decideSettle', async () => {
    const calls: string[] = [];
    let verificationRun: VerificationRun = { ok: false, cwd: '/p', results: [{ name: 'evidence', command: 'self-verify', ok: false, output: '金额未核对', elapsedMs: 1, timedOut: false }] };
    const customVerifier = {
      async verify() { calls.push('verify'); return verificationRun; },
    };
    const settleResults: Array<{ continue?: boolean; entries?: unknown[] }> = [];
    const pi = {
      cwd: '/p',
      on: (evt: string, handler: (event?: unknown) => unknown | Promise<unknown>) => {
        if (evt === 'agent_before_settle') {
          // Drive two settle boundaries: first FAIL (rework), then PASS.
          (pi as unknown as { _settle: (h: (e?: unknown) => unknown | Promise<unknown>) => Promise<void> })._settle = async (h) => { settleResults.push((await handler()) as { continue?: boolean; entries?: unknown[] }); };
        }
      },
    } as unknown as PiExtensionAPI & { _settle: (h: (e?: unknown) => unknown | Promise<unknown>) => Promise<void> };
    qualityGates(pi, { env: {}, verifier: customVerifier });

    await pi._settle(() => undefined); // boundary 1: FAIL → rework
    verificationRun = { ok: true, cwd: '/p', results: [] };
    await pi._settle(() => undefined); // boundary 2: PASS → pass-through

    expect(calls).toEqual(['verify', 'verify']);
    expect(settleResults[0].continue).toBe(true); // first FAIL → rework
    expect(settleResults[0].entries?.[0]).toMatchObject({ type: 'custom_message', customType: 'quality-gates' });
    expect(settleResults[1]).toBeUndefined(); // PASS → no continuation
  });

  it('a custom verifier returning null skips verification (no trigger this boundary)', async () => {
    const customVerifier = { async verify() { return null; } };
    let result: unknown = 'untouched';
    const pi = {
      cwd: '/p',
      on: (evt: string, handler: () => unknown | Promise<unknown>) => {
        if (evt === 'agent_before_settle') result = handler();
      },
    } as unknown as PiExtensionAPI;
    qualityGates(pi, { env: {}, verifier: customVerifier });
    expect(await result).toBeUndefined(); // null verification → no continuation
  });
});
