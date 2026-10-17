/**
 * pi extension shell: settle-gate + lint-inject (pluggable verifier, 2026-10-17).
 *
 * Wiring (pi 1.3.0 extension runtime):
 * - tool_call: observe edit/write-class calls → mark the session dirty (for
 *   the default {@link CommandVerifier}; custom verifiers may ignore dirtiness).
 * - agent_before_settle ("final actionable boundary"): ask the {@link Verifier}
 *   whether to verify; on a failed {@link VerificationRun}, hand it to the
 *   shared {@link decideSettle} core → return {continue:true, entries:[custom_message]}
 *   so pi runs one more model turn with the failure report. Anti-loop caps
 *   consecutive reworks at maxReworks (default 2) then passes through with an
 *   explicit "still failing" message.
 * - tool_result: after an edit-class tool, run a fast diagnostics battery and
 *   append findings to the result content so the model sees them next turn.
 *
 * Pluggable verifier: trigger + verify live in a {@link Verifier} strategy.
 * Default {@link CommandVerifier} = coding scenario (env/verify.sh commands +
 * edit-dirty tracking). A host like VE supplies its own Verifier (evidence-round
 * self-verification for autonomous tasks) while reusing {@link decideSettle} +
 * {@link SettleGateState} — one decision core, two verification mechanisms.
 *
 * Discipline: fail-open (extension errors pass through — a broken gate must
 * never wedge the host loop); budgeted long work (pi has no handler timeouts
 * upstream, #9910); no-op when no verify commands are discoverable.
 */

import { appendFileSync } from 'node:fs';
import { SettleGateState, decideSettle, type SettleGateInput, type VerificationRun } from '../core/settle.ts';
import { runChecks } from '../core/runner.ts';
import { DEFAULT_BUDGET } from '../core/settle.ts';
import { CommandVerifier, EDIT_TOOLS, resolveCheckCommands } from '../core/command-verifier.ts';
import type { Verifier, VerifyContext } from '../core/verifier.ts';
import type { PiBoundaryDraft, PiExtensionAPI, PiBeforeSettleResult, PiToolCallEvent, PiToolResultEvent } from './pi-types.ts';

export { CommandVerifier, resolveCheckCommands, EDIT_TOOLS } from '../core/command-verifier.ts';
export type { Verifier, VerifyContext } from '../core/verifier.ts';

export interface QualityGatesOptions {
	maxReworks?: number;
	disabled?: boolean;
	env?: NodeJS.ProcessEnv;
	/** Verification strategy. Default: {@link CommandVerifier} (coding scenario).
	 * A host supplies its own to bridge a different mechanism (VE: evidence-round)
	 * while reusing the settle decision core. */
	verifier?: Verifier;
}

export default function qualityGates(pi: PiExtensionAPI, options: QualityGatesOptions = {}) {
	const env = options.env ?? process.env;
	const disabled = options.disabled ?? env.PI_QUALITY_GATES === 'off';
	if (env.PI_QUALITY_GATES_DEBUG) appendFileSync('/tmp/pqg-debug.log', `[quality-gates] factory invoked, disabled=${disabled}\n`);
	if (disabled) return;
	const state = new SettleGateState(options.maxReworks ?? 2);
	const cwd = pi.cwd ?? process.cwd();

	// Default verifier: command-mode with edit-dirty tracking. A host-supplied
	// verifier owns its own trigger/verify; the dirty set is shared so the
	// lint-inject path (tool_result) can still see edit-class calls.
	const dirty = new Set<string>();
	const verifier: Verifier = options.verifier ?? new CommandVerifier({ cwd, env, dirty });
	const commandVerifier = verifier instanceof CommandVerifier ? verifier : undefined;

	pi.on('tool_call', (event: PiToolCallEvent) => {
		// The default verifier keys on edit-dirtiness; custom verifiers ignore it.
		if (EDIT_TOOLS.has(event.toolName)) dirty.add('default');
		return undefined;
	});

	pi.on('agent_before_settle', async (): Promise<PiBeforeSettleResult | undefined> => {
		try {
			const ctx: VerifyContext = { conversationKey: 'default', messages: [], cwd };
			const verification = await verifier.verify(ctx);
			if (!verification) return undefined;
			const input: SettleGateInput = {
				conversationKey: 'default',
				editsSinceLastPass: true, // a non-null verification means the host wanted to verify
				verification,
				disabled,
			};
			const decision = decideSettle(input, state);
			if (env.PI_QUALITY_GATES_DEBUG) appendFileSync(env.PI_QUALITY_GATES_DEBUG_LOG || '/tmp/pqg-debug.log', `[quality-gates] settle: verif=${verification.ok ? 'ok' : 'fail'} continue=${decision.continueRework} round=${decision.reworkRound}\n`);
			if (verification.ok && commandVerifier) commandVerifier.clearDirty('default');
			if (!decision.message) return decision.continueRework ? { continue: true } : undefined;
			const draft: PiBoundaryDraft = { type: 'custom_message', customType: 'quality-gates', content: decision.message, display: decision.message };
			return { continue: decision.continueRework, entries: [draft] };
		} catch {
			return undefined; // fail-open, always
		}
	});

	pi.on('tool_result', async (event: PiToolResultEvent) => {
		try {
			if (!EDIT_TOOLS.has(event.toolName ?? '') || !event.content) return undefined;
			const commands = resolveCheckCommands(cwd, env).filter((c: { command: string }) => /tsc|lint|check/.test(c.command));
			if (!commands.length) return undefined;
			const run2 = await runChecks(commands.slice(0, 2), cwd, { ...DEFAULT_BUDGET, editPerCheckMs: 5_000 }, 'edit');
			if (run2.ok) return undefined; // quiet when clean — no context tax
			const report = run2.results.filter((r) => !r.ok).map((r) => `### ${r.name}\n${r.output}`).join('\n\n');
			event.content.push({ type: 'text', text: `[quality-gates] Diagnostics after this edit:\n\n${report}` });
			return { content: event.content };
		} catch {
			return undefined; // never break the tool result
		}
	});
}
