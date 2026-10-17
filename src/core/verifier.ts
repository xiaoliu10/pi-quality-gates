/**
 * Pluggable verifier strategy (2026-10-17). The settle gate has three concerns:
 *   1. TRIGGER  — should this boundary verify? (coding: an edit happened;
 *                 autonomous: a task-done claim was made)
 *   2. VERIFY   — run the checks → {@link VerificationRun} (coding: shell
 *                 commands; autonomous: an evidence round the model performs)
 *   3. DECIDE   — pass / rework / release, with anti-loop cap
 * #3 is host-agnostic ({@link decideSettle} + {@link SettleGateState}); #1+#2
 * are host-specific, so they collapse into a Verifier. The shell asks "verify?"
 * and the verifier returns null (skip) or a VerificationRun → decideSettle.
 * One decision core serves both pi (command-mode) and VE (evidence-mode).
 */
import type { VerificationRun } from './settle.ts';

/** What the verifier sees at a settle boundary. */
export interface VerifyContext {
	conversationKey: string;
	/** The session's transcript view at the boundary — evidence-based verifiers
	 * inspect the last assistant message(s) to decide whether to verify. */
	readonly messages: ReadonlyArray<{ role: string; content: unknown }>;
	cwd: string;
}

/**
 * A verification strategy. Returns null to skip this boundary; returns a
 * {@link VerificationRun} to feed {@link decideSettle}. Implementations MUST be
 * fail-open: an internal failure returns null (a broken verifier must never
 * wedge the host settle loop — CC #102649 lesson).
 */
export interface Verifier {
	verify(ctx: VerifyContext): Promise<VerificationRun | null>;
}
