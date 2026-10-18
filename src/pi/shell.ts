/**
 * pi extension shell: settle-gate + commit-gate + lint-inject (2026-10-18 v0.2.0).
 *
 * Wiring (pi extension runtime):
 * - tool_call: observe edit/write-class calls → mark the session dirty; PLUS
 *   the commit gate (absorbed from the retired desktop verify-gate): a
 *   `git commit`/`git push` while dirty runs the verify battery synchronously
 *   and BLOCKS the call on failure with the tail of the output, so the model
 *   cannot ship unverified work through git (client-side git hooks are
 *   bypassable with --no-verify; a harness-layer gate is not).
 * - agent_before_settle ("final actionable boundary"): ask the {@link Verifier}
 *   whether to verify; on a failed {@link VerificationRun}, hand it to the
 *   shared {@link decideSettle} core → return {continue:true, entries:[custom_message]}
 *   so pi runs one more model turn with the failure report. Anti-loop caps
 *   consecutive reworks at maxReworks (default 2) then passes through with an
 *   explicit "still failing" message.
 * - tool_result: after an edit-class tool, run a fast diagnostics battery and
 *   append findings to the result content; after a passing verify-like command,
 *   collapse its output to one line (context-efficient backpressure).
 *
 * Keys: conversation state is bucketed by the session cwd (research round found
 * the shipped 0.1.0 hardcoded 'default'; per-process sessions made it mostly
 * benign, but cwd-keying is the correct semantics and defends in-process
 * multi-conversation hosts).
 *
 * Failure discipline: fail-open by default (a broken gate must never wedge the
 * host loop); set PI_QUALITY_GATES_MODE=closed for fail-closed on the commit
 * gate (gate's own crash → block the commit). Settle stays fail-open either
 * way — its only failure mode is "no extra turn", which must never wedge runs.
 * Budgeted long work (pi has no handler timeouts upstream, #9910); no-op when
 * no verify commands are discoverable.
 */

import { appendFileSync } from 'node:fs';
import { SettleGateState, decideSettle, type SettleGateInput } from '../core/settle.ts';
import { runChecks } from '../core/runner.ts';
import type { VerificationRun } from '../core/settle.ts';
import { DEFAULT_BUDGET } from '../core/settle.ts';
import { CommandVerifier, EDIT_TOOLS, resolveCheckCommands } from '../core/command-verifier.ts';
import { captureBaseline, checkTamper, type TamperBaseline } from '../core/tamper-guard.ts';
import type { Verifier, VerifyContext } from '../core/verifier.ts';
import type { PiBoundaryDraft, PiExtensionAPI, PiBeforeSettleResult, PiToolCallEvent, PiToolResultEvent } from './pi-types.ts';

export { CommandVerifier, resolveCheckCommands, EDIT_TOOLS } from '../core/command-verifier.ts';
export type { Verifier, VerifyContext } from '../core/verifier.ts';

export interface QualityGatesOptions {
	maxReworks?: number;
	disabled?: boolean;
	env?: NodeJS.ProcessEnv;
	/** Verification strategy. Default: {@link CommandVerifier} (coding scenario). */
	verifier?: Verifier;
}

/** Commands whose gate semantics matter: `git commit` / `git push` (the shipping moment). */
export const GATE_COMMAND_RE = /\bgit\s+(commit|push)\b/;

/** Verify-like invocations whose SUCCESS output collapses to one line. */
const VERIFY_LIKE_RE = /(\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check|verify)\b|\b(vitest|jest|tsc|eslint|prettier|pytest|cargo|go)\s+(test|build|run|fmt|clippy)?\b|\bmake\b|\bverify\.sh\b)/;

const COMMIT_GATE_TIMEOUT_MS = 120_000;
const BLOCK_TAIL_CHARS = 1500;

const tail = (s: string, n = BLOCK_TAIL_CHARS) => (s.length > n ? `…(truncated)…\n${s.slice(-n)}` : s);

export default function qualityGates(pi: PiExtensionAPI, options: QualityGatesOptions = {}) {
	const env = options.env ?? process.env;
	const disabled = options.disabled ?? env.PI_QUALITY_GATES === 'off';
	if (env.PI_QUALITY_GATES_DEBUG) appendFileSync('/tmp/pqg-debug.log', `[quality-gates] factory invoked, disabled=${disabled}\n`);
	if (disabled) return;
	const failClosed = env.PI_QUALITY_GATES_MODE === 'closed';
	const state = new SettleGateState(options.maxReworks ?? 2);
	const cwd = pi.cwd ?? process.cwd();
	// Conversation bucket: keyed by the session cwd. A pi process serves one
	// session today; cwd-keying keeps the semantics honest for in-process hosts.
	const ck = () => cwd;

	const dirty = new Set<string>();
	// Tamper guard baseline: captured at turn start (worktree hashes of the
	// battery's dependency paths). undefined = no git / capture failed.
	let baseline: TamperBaseline | undefined;
	const verifier: Verifier = options.verifier ?? new CommandVerifier({ cwd, env, dirty });
	const commandVerifier = verifier instanceof CommandVerifier ? verifier : undefined;

	pi.on('turn_start', () => {
		// Fresh turn ⇒ new baseline. Cheap when the tree is small; a slow hash-object
		// on a huge test tree is still bounded by the git timeout. Capture failure
		// leaves baseline undefined (checkTamper → unknown → withhold token).
		void captureBaseline(cwd, env.PI_VERIFY_CMD ?? '').then((b) => { baseline = b; }, () => { baseline = undefined; });
	});

	pi.on('tool_call', async (event: PiToolCallEvent) => {
		try {
			if (EDIT_TOOLS.has(event.toolName)) { dirty.add(ck()); return undefined; }
			if (event.toolName !== 'bash') return undefined;
			const cmd = String(event.input?.command ?? '');
			if (!GATE_COMMAND_RE.test(cmd)) return undefined;
			// Clean tree (nothing dirty since the last passing verify) ships as-is.
			if (!commandVerifier || !commandVerifier.isDirty(ck())) return undefined;
			// Tamper guard: the battery's own dependencies changed since the turn
			// began ⇒ its green would be meaningless. Block with the diff.
			const tamper = await checkTamper(baseline, cwd, env.PI_VERIFY_CMD ?? '');
			if (tamper.kind === 'tampered') {
				return { block: true, reason: `[quality-gates] 检测到验证基础设施被改动（门的钥匙不能交给被考核者）：\n${tamper.changed.map((c: string) => `- ${c}`).join('\n')}\n\n${tamper.detail}\n请改代码而不是改检查；如确需改测试，向用户说明理由。` };
			}
			const checks = resolveCheckCommands(cwd, env);
			if (!checks.length) return undefined;
			let run: VerificationRun;
			try {
				// Budgeted synchronous gate: the commit must not proceed while the
				// battery runs; upstream gives us no handler timeout (#9910).
				const deadline = { ...DEFAULT_BUDGET, editPerCheckMs: COMMIT_GATE_TIMEOUT_MS };
				run = await runChecks(checks, cwd, deadline, 'edit'); // commit gate gets the full per-check budget
			} catch (e) {
				// Gate's own crash: fail-open by default; MODE=closed blocks the commit.
				if (failClosed) return { block: true, reason: `[quality-gates] verify 执行失败（fail-closed 模式拦截提交）：${String((e as Error)?.message ?? e).slice(0, 200)}` };
				return undefined;
			}
			if (run.ok) { commandVerifier.clearDirty(ck()); return undefined; }
			return { block: true, reason: `verify 未通过，先修复再提交：\n${tail(run.results.filter(r => !r.ok).map(r => `### ${r.name}\n${r.output}`).join('\n\n'))}` };
		} catch (e) {
			if (failClosed) return { block: true, reason: `[quality-gates] 门异常（fail-closed 模式拦截）：${String((e as Error)?.message ?? e).slice(0, 200)}` };
			return undefined; // fail-open
		}
	});

	pi.on('agent_before_settle', async (): Promise<PiBeforeSettleResult | undefined> => {
		try {
			// Tampered battery: skip the run (its result would be worthless) and
			// hand the tamper report back for one more model turn.
			const tamper = await checkTamper(baseline, cwd, env.PI_VERIFY_CMD ?? '');
			if (tamper.kind === 'tampered') {
				const draft: PiBoundaryDraft = { type: 'custom_message', customType: 'quality-gates', content: `验证基础设施在本次轮次中被改动：\n${tamper.changed.map((c: string) => `- ${c}`).join('\n')}\n\n${tamper.detail}\n\n改动代码让检查通过，而不是改检查本身。`, display: '检测到验证被改动' };
				return { continue: true, entries: [draft] };
			}
			const ctx: VerifyContext = { conversationKey: ck(), messages: [], cwd };
			const verification = await verifier.verify(ctx);
			if (!verification) return undefined;
			const input: SettleGateInput = {
				conversationKey: ck(),
				editsSinceLastPass: true,
				verification,
				disabled,
			};
			const decision = decideSettle(input, state);
			if (env.PI_QUALITY_GATES_DEBUG) appendFileSync(env.PI_QUALITY_GATES_DEBUG_LOG || '/tmp/pqg-debug.log', `[quality-gates] settle: verif=${verification.ok ? 'ok' : 'fail'} continue=${decision.continueRework} round=${decision.reworkRound}\n`);
			if (verification.ok && commandVerifier) commandVerifier.clearDirty(ck());
			if (!decision.message) return decision.continueRework ? { continue: true } : undefined;
			const draft: PiBoundaryDraft = { type: 'custom_message', customType: 'quality-gates', content: decision.message, display: decision.message };
			return { continue: decision.continueRework, entries: [draft] };
		} catch {
			return undefined; // fail-open, always — settle must never wedge a run
		}
	});

	pi.on('tool_result', async (event: PiToolResultEvent) => {
		try {
			const cmd = String((event as { input?: { command?: string } }).input?.command ?? '');
			// Backpressure: a PASSING verify-like command collapses to one line —
			// the model keeps the signal without paying context for the noise.
			if (event.toolName === 'bash' && !event.isError && VERIFY_LIKE_RE.test(cmd) && event.content) {
				return { content: [{ type: 'text', text: `✓ ${cmd.slice(0, 80)} passed (output collapsed by quality-gates; re-run to see)` }] };
			}
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
