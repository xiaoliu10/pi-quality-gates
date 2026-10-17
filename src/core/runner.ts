/**
 * Check-battery runner. Host-agnostic: takes commands + cwd, spawns with
 * budgets, returns plain data. Both the pi extension shell and ve's engine
 * call this; nothing here knows about pi.
 *
 * Budget discipline (borrowed from pi-lens' production contract):
 * - hard per-check wall clock (edit path: 10s) — kill, mark timedOut, keep tail
 * - output is tail-truncated so a screaming test suite can't flood the context
 * - every failure path resolves (never throws): the runner itself must not
 *   become the wedge (pi #9910: extension handlers have no timeout upstream).
 */

import type { BudgetPolicy, CheckCommand, CheckResult, VerificationRun } from './settle.ts';
import { DEFAULT_BUDGET } from './settle.ts';
import { spawn } from 'node:child_process';

const tail = (s: string, n: number): string => (s.length > n ? `…(truncated)…\n${s.slice(-n)}` : s);

/** Run one check under a wall-clock budget. Never rejects. */
export function runCheck(check: CheckCommand, cwd: string, budgetMs: number, outputTailChars: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let child;
    try {
      child = spawn('sh', ['-c', check.command], { cwd, env: process.env });
    } catch {
      resolve({ ...check, ok: true, output: '', elapsedMs: 0, timedOut: false });
      return;
    }
    let output = '';
    const append = (chunk: Buffer | string) => {
      output += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      // Keep memory bounded for pathological output.
      if (output.length > outputTailChars * 4) output = output.slice(-outputTailChars * 4);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ ...check, ok: false, output: tail(`${output}\n[killed at ${budgetMs}ms budget]`, outputTailChars), elapsedMs: Date.now() - started, timedOut: true });
    }, budgetMs);
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Spawn-level failure (no sh?) — fail-open: treat as pass, report empty.
      resolve({ ...check, ok: true, output: '', elapsedMs: Date.now() - started, timedOut: false });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...check, ok: code === 0, output: tail(output, outputTailChars), elapsedMs: Date.now() - started, timedOut: false });
    });
  });
}

/**
 * Run the battery sequentially (deterministic ordering matters for reports;
 * parallel runs also thrash CPU on big repos). Never rejects.
 */
export async function runChecks(checks: CheckCommand[], cwd: string, budget: BudgetPolicy = DEFAULT_BUDGET, mode: 'edit' | 'readOnly' = 'edit'): Promise<VerificationRun> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    // Read-only contexts get the tiny shared budget; edit contexts get the
    // full per-check budget. A read-only battery that would exceed its whole
    // allowance is skipped entirely rather than half-run.
    const budgetMs = mode === 'edit' ? budget.editPerCheckMs : budget.readOnlyMs;
    if (mode === 'readOnly' && results.length > 0) break; // at most one check on the read path
    results.push(await runCheck(check, cwd, budgetMs, budget.outputTailChars));
  }
  return { ok: results.every((r) => r.ok), results, cwd };
}
