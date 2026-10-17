import { describe, expect, it } from 'vitest';
import { decideSettle, SettleGateState, shouldVerifyOnSettle, type SettleGateInput, type VerificationRun } from '../src/core/settle.ts';

const pass: VerificationRun = { ok: true, results: [], cwd: '/p' };
const fail = (names: string[]): VerificationRun => ({
  ok: false,
  cwd: '/p',
  results: names.map((n) => ({ name: n, command: n, ok: false, output: `ERR from ${n}`, elapsedMs: 5, timedOut: false })),
});

const input = (over: Partial<SettleGateInput>): SettleGateInput => ({
  conversationKey: 'c1',
  editsSinceLastPass: true,
  verification: fail(['tsc']),
  ...over,
});

describe('decideSettle', () => {
  it('passes through when disabled or no edits', () => {
    const st = new SettleGateState();
    expect(decideSettle(input({ disabled: true }), st).continueRework).toBe(false);
    expect(decideSettle(input({ editsSinceLastPass: false }), st).continueRework).toBe(false);
  });

  it('fail-open: missing verification run passes', () => {
    const st = new SettleGateState();
    expect(decideSettle(input({ verification: null }), st).continueRework).toBe(false);
  });

  it('passing verification resets rework pressure', () => {
    const st = new SettleGateState();
    st.recordRework('c1');
    const d = decideSettle(input({ verification: pass }), st);
    expect(d.continueRework).toBe(false);
    expect(st.roundsFor('c1')).toBe(0);
  });

  it('failed verification requests rework with the failure report', () => {
    const st = new SettleGateState();
    const d = decideSettle(input({ verification: fail(['tsc', 'eslint']) }), st);
    expect(d.continueRework).toBe(true);
    expect(d.reworkRound).toBe(1);
    expect(d.message).toContain('tsc');
    expect(d.message).toContain('eslint');
    expect(d.message).toContain('ERR from tsc');
  });

  it('anti-loop: after maxReworks passes through with explicit still-failing message', () => {
    const st = new SettleGateState(2);
    st.recordRework('c1');
    st.recordRework('c1');
    const d = decideSettle(input({ verification: fail(['vitest']) }), st);
    expect(d.continueRework).toBe(false);
    expect(d.message).toContain('still failing');
    expect(d.message).toContain('NOT verified');
    // pressure reset so a later failure can rework again
    expect(st.roundsFor('c1')).toBe(0);
  });

  it('rework rounds are per-conversation', () => {
    const st = new SettleGateState(1);
    st.recordRework('a');
    expect(decideSettle(input({ conversationKey: 'b' }), st).continueRework).toBe(true);
    expect(decideSettle(input({ conversationKey: 'a' }), st).continueRework).toBe(false);
  });
});

describe('shouldVerifyOnSettle', () => {
  it('verifies only when dirty and enabled', () => {
    expect(shouldVerifyOnSettle({ editsSinceLastPass: true, disabled: false })).toBe(true);
    expect(shouldVerifyOnSettle({ editsSinceLastPass: false, disabled: false })).toBe(false);
    expect(shouldVerifyOnSettle({ editsSinceLastPass: true, disabled: true })).toBe(false);
  });
});
