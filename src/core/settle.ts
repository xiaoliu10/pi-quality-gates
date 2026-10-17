/**
 * Host-agnostic core types for pi-quality-gates.
 *
 * Nothing in src/core may import from pi — these types describe the *shapes*
 * the host adapters (pi extension shell, ve engine) must supply. Keeping the
 * core pure is what lets pi and pi-virtual-employee share one implementation.
 */

/** A single deterministic check to run against a working tree. */
export interface CheckCommand {
  /** Human label used in reports ("tsc", "eslint", "vitest"). */
  name: string;
  /** Shell command executed with `sh -c` in the project cwd. */
  command: string;
}

/** Outcome of one check. */
export interface CheckResult {
  name: string;
  command: string;
  ok: boolean;
  /** Combined stdout+stderr, tail-truncated by the runner budget. */
  output: string;
  /** Milliseconds actually spent (for budget accounting in reports). */
  elapsedMs: number;
  /** True if the runner killed the command at the budget deadline. */
  timedOut: boolean;
}

/** Result of running the full check battery. */
export interface VerificationRun {
  ok: boolean;
  results: CheckResult[];
  /** Project cwd the checks ran in. */
  cwd: string;
}

/**
 * Wall-clock budget for running checks, borrowed from pi-lens' production
 * contract: read-only tools never wait for analyzers; edit-path work is
 * capped hard so a gate can never wedge the host loop.
 */
export interface BudgetPolicy {
  /** Max ms for the whole battery when triggered from a read-only context. */
  readOnlyMs: number;
  /** Max ms per check when triggered after an edit. */
  editPerCheckMs: number;
  /** Max chars of combined output kept per check (tail kept). */
  outputTailChars: number;
}

export const DEFAULT_BUDGET: BudgetPolicy = {
  readOnlyMs: 500,
  editPerCheckMs: 10_000,
  outputTailChars: 4_000,
};

/**
 * One settle-time verdict. `continueRework` asks the host to run another
 * model turn; `message` is shown to the model so it knows what failed.
 * Consecutive-rework guarding (anti infinite loop) lives in SettleGateState.
 */
export interface SettleDecision {
  continueRework: boolean;
  /** Why the gate wants another turn; empty when passing through. */
  message: string;
  /** Which round of forced rework this is (0 = pass-through). */
  reworkRound: number;
}

/**
 * Per-conversation mutable state for the settle gate. Hosts own storage:
 * the pi shell keeps one instance per live session; ve keys by conversation.
 */
export class SettleGateState {
  readonly maxReworks: number;
  private rounds = new Map<string, number>();

  constructor(maxReworks = 2) {
    this.maxReworks = maxReworks;
  }

  roundsFor(conversationKey: string): number {
    return this.rounds.get(conversationKey) ?? 0;
  }

  /** Record a forced rework; returns the new round count. */
  recordRework(conversationKey: string): number {
    const next = this.roundsFor(conversationKey) + 1;
    this.rounds.set(conversationKey, next);
    return next;
  }

  /** Called when a verification run passes or the user acts — resets pressure. */
  reset(conversationKey: string): void {
    this.rounds.delete(conversationKey);
  }
}

/** Inputs the settle gate needs from the host, all plain data. */
export interface SettleGateInput {
  conversationKey: string;
  /** Did this conversation see edit/write-class tool calls since the last pass? */
  editsSinceLastPass: boolean;
  /** Most recent verification run, if the host ran one. */
  verification: VerificationRun | null;
  /** Settle gate disabled entirely (host switch, e.g. PI_QUALITY_GATES=off). */
  disabled?: boolean;
}

/**
 * The settle decision. Discipline:
 * - fail-open: if `verification` is null (host failed to run checks) we pass.
 *   A broken gate must never wedge a conversation (CC #102649 lesson: silent
 *   breakage is the worst failure mode; our counterpart is explicit pass).
 * - anti-loop: after maxReworks consecutive forced turns we pass and say so,
 *   so the model can report honestly instead of thrashing.
 */
export function decideSettle(input: SettleGateInput, state: SettleGateState): SettleDecision {
  if (input.disabled || !input.editsSinceLastPass) return { continueRework: false, message: '', reworkRound: 0 };
  const verification = input.verification;
  if (!verification) return { continueRework: false, message: '', reworkRound: 0 };
  if (verification.ok) {
    state.reset(input.conversationKey);
    return { continueRework: false, message: '', reworkRound: 0 };
  }
  const failed = verification.results.filter((r) => !r.ok);
  const round = state.roundsFor(input.conversationKey);
  if (round >= state.maxReworks) {
    state.reset(input.conversationKey);
    const names = failed.map((f) => f.name).join(', ');
    return {
      continueRework: false,
      message: `[quality-gates] Verification still failing after ${state.maxReworks} rework rounds (${names}). Pass this through to the user verbatim: work is NOT verified; list the failing checks and their tails.`,
      reworkRound: round + 1,
    };
  }
  state.recordRework(input.conversationKey);
  const detail = failed
    .map((f) => `## ${f.name} failed (${f.command})\n${f.output}`)
    .join('\n\n');
  return {
    continueRework: true,
    message: `[quality-gates] Settle blocked: verification failed. Fix these, then finish again.\n\n${detail}`,
    reworkRound: round + 1,
  };
}

/** True when the host should run the check battery before settling. */
export function shouldVerifyOnSettle(input: Pick<SettleGateInput, 'editsSinceLastPass' | 'disabled'>): boolean {
  return !input.disabled && input.editsSinceLastPass;
}
