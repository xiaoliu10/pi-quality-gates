import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCheckCommands, default as qualityGates } from '../index.ts';
import type { PiExtensionAPI } from '../src/pi/pi-types.ts';

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
