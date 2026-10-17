import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheck, runChecks } from '../src/core/runner.ts';
import { DEFAULT_BUDGET } from '../src/core/settle.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'pqg-'));

describe('runCheck', () => {
  it('passes on exit 0, fails with tail output on non-zero', async () => {
    const cwd = tmp();
    try {
      const ok = await runCheck({ name: 'true', command: 'true' }, cwd, 1000, 500);
      expect(ok.ok).toBe(true);
      const bad = await runCheck({ name: 'fail', command: 'echo boom-line; exit 3' }, cwd, 1000, 500);
      expect(bad.ok).toBe(false);
      expect(bad.output).toContain('boom-line');
      expect(bad.timedOut).toBe(false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('kills runaway commands at the budget and reports timedOut', async () => {
    const cwd = tmp();
    try {
      const r = await runCheck({ name: 'slow', command: 'echo started; sleep 30' }, cwd, 300, 500);
      expect(r.ok).toBe(false);
      expect(r.timedOut).toBe(true);
      expect(r.output).toContain('started');
      expect(r.elapsedMs).toBeLessThan(5000);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('tail-truncates pathological output', async () => {
    const cwd = tmp();
    try {
      const r = await runCheck({ name: 'noisy', command: 'yes spam | head -c 200000' }, cwd, 5000, 300);
      expect(r.output.length).toBeLessThanOrEqual(400);
      expect(r.output).toContain('…(truncated)…');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('never rejects: spawn-level errors resolve fail-open', async () => {
    const r = await runCheck({ name: 'x', command: 'definitely-not-a-real-cmd-xyz' }, tmp(), 1000, 500);
    // command not found is a NONZERO exit from sh (caught by close), ok=false — that's fine.
    // What must never happen is a rejection; runCheck returns a result either way.
    expect(typeof r.ok).toBe('boolean');
  });
});

describe('runChecks', () => {
  it('runs sequentially and aggregates ok', async () => {
    const cwd = tmp();
    try {
      writeFileSync(join(cwd, 'ok.sh'), '#!/bin/sh\nexit 0\n');
      const run = await runChecks([
        { name: 'a', command: 'true' },
        { name: 'b', command: 'exit 1' },
      ], cwd, DEFAULT_BUDGET, 'edit');
      expect(run.ok).toBe(false);
      expect(run.results.map((r) => r.name)).toEqual(['a', 'b']);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('read-only mode runs at most one check under the tiny budget', async () => {
    const cwd = tmp();
    try {
      const run = await runChecks([
        { name: 'a', command: 'true' },
        { name: 'b', command: 'true' },
      ], cwd, DEFAULT_BUDGET, 'readOnly');
      expect(run.results).toHaveLength(1);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
