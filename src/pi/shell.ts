/**
 * pi extension shell: settle-gate + lint-inject.
 *
 * Wiring (pi 1.3.0 extension runtime, verified against npm tarball types.d.ts):
 * - tool_call: observe edit/write-class calls → mark the session dirty.
 * - agent_before_settle ("final actionable boundary"): if dirty, run the
 *   check battery; on failure return {continue:true, entries:[custom_message]}
 *   so pi runs one more model turn with the failure report. Anti-loop caps
 *   consecutive reworks at maxReworks (default 2) then passes through with an
 *   explicit "still failing" message.
 * - tool_result: after an edit-class tool, run a fast diagnostics battery and
 *   append findings to the result content so the model sees them next turn.
 *
 * Discipline:
 * - The gate itself is fail-open: extension errors pass through (a broken
 *   gate must never wedge the host loop). Verification FAILURE is what
 *   triggers rework — never extension crashes.
 * - All long work is budgeted; pi has no handler timeouts upstream (#9910).
 * - No-op when no verify commands are discoverable, so projects without
 *   gates are untouched.
 */

import { existsSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { SettleGateState, shouldVerifyOnSettle, decideSettle, type CheckCommand, type SettleGateInput, type VerificationRun } from '../core/settle.ts';
import { runChecks } from '../core/runner.ts';
import { DEFAULT_BUDGET } from '../core/settle.ts';
import { EDIT_TOOLS, type PiBoundaryDraft, type PiExtensionAPI, type PiBeforeSettleResult, type PiToolCallEvent, type PiToolResultEvent } from './pi-types.ts';

/** Verify command discovery, same contract as the existing verify-gate: env → verify.sh → .pi/verify.sh. */
export function resolveCheckCommands(cwd: string, env: NodeJS.ProcessEnv = process.env): CheckCommand[] {
  const commands: CheckCommand[] = [];
  const piVerify = env.PI_VERIFY_CMD?.trim();
  if (piVerify) {
    // Comma-separated so hosts can express "tsc --noEmit, vitest run".
    for (const c of piVerify.split(',').map((s) => s.trim()).filter(Boolean)) commands.push({ name: c.split(/\s+/)[0], command: c });
    return commands;
  }
  try {
    for (const rel of ['verify.sh', join('.pi', 'verify.sh')]) {
      const p = join(cwd, rel);
      if (existsSync(p) && statSync(p).isFile()) { commands.push({ name: 'verify.sh', command: `sh ${rel}` }); break; }
    }
  } catch { /* no fs access — no commands */ }
  return commands;
}

export interface QualityGatesOptions {
  maxReworks?: number;
  disabled?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Override for tests. */
  runChecksImpl?: typeof runChecks;
}

export default function qualityGates(pi: PiExtensionAPI, options: QualityGatesOptions = {}) {
  const env = options.env ?? process.env;
  const disabled = options.disabled ?? env.PI_QUALITY_GATES === 'off';
  if (env.PI_QUALITY_GATES_DEBUG) appendFileSync('/tmp/pqg-debug.log', `[quality-gates] factory invoked, disabled=${disabled}\n`);
  if (disabled) return;
  const state = new SettleGateState(options.maxReworks ?? 2);
  const run = options.runChecksImpl ?? runChecks;
  const dirty = new Set<string>(); // conversation keys with edits since last pass
  const cwd = pi.cwd ?? process.cwd();

  pi.on('tool_call', (event: PiToolCallEvent) => {
    if (EDIT_TOOLS.has(event.toolName)) dirty.add('default');
    return undefined;
  });

  pi.on('agent_before_settle', async (): Promise<PiBeforeSettleResult | undefined> => {
    try {
      const commands = resolveCheckCommands(cwd, env);
      if (!commands.length || !dirty.has('default')) return undefined;
      let verification: VerificationRun | null = null;
      try {
        verification = await run(commands, cwd, DEFAULT_BUDGET, 'edit');
      } catch {
        verification = null; // runner exploded → fail-open pass
      }
      const input: SettleGateInput = {
        conversationKey: 'default',
        editsSinceLastPass: dirty.has('default'),
        verification,
        disabled,
      };
      const decision = decideSettle(input, state);
      if (env.PI_QUALITY_GATES_DEBUG) appendFileSync(env.PI_QUALITY_GATES_DEBUG_LOG || '/tmp/pqg-debug.log', `[quality-gates] settle: dirty=${input.editsSinceLastPass} verif=${input.verification ? (input.verification.ok ? 'ok' : 'fail') : 'null'} continue=${decision.continueRework}\n`);
      if (verification?.ok) dirty.delete('default');
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
      const commands = resolveCheckCommands(cwd, env).filter((c) => /tsc|lint|check/.test(c.command));
      if (!commands.length) return undefined;
      const run2 = await run(commands.slice(0, 2), cwd, { ...DEFAULT_BUDGET, editPerCheckMs: 5_000 }, 'edit');
      if (run2.ok) return undefined; // quiet when clean — no context tax
      const report = run2.results.filter((r) => !r.ok).map((r) => `### ${r.name}\n${r.output}`).join('\n\n');
      event.content.push({ type: 'text', text: `[quality-gates] Diagnostics after this edit:\n\n${report}` });
      return { content: event.content };
    } catch {
      return undefined; // never break the tool result
    }
  });
}
