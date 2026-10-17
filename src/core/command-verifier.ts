/**
 * Command-based verifier — the coding-scenario default. Discovers verify
 * commands (env PI_VERIFY_CMD → verify.sh → .pi/verify.sh) and runs them with
 * a wall-clock budget. Extracted from shell.ts (2026-10-17) so the settle gate
 * can accept a host-supplied {@link Verifier} while keeping {@link decideSettle}.
 *
 * Discipline: fail-open (runner explosion → null); budgeted (wall-clock cap);
 * dirty-tracking (only verify when an edit-class tool fired since last pass).
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runChecks } from './runner.ts';
import { DEFAULT_BUDGET, type CheckCommand, type VerificationRun } from './settle.ts';
import type { Verifier, VerifyContext } from './verifier.ts';

/** Verify command discovery: env PI_VERIFY_CMD (comma-sep) → verify.sh → .pi/verify.sh. */
export function resolveCheckCommands(cwd: string, env: NodeJS.ProcessEnv = process.env): CheckCommand[] {
	const commands: CheckCommand[] = [];
	const piVerify = env.PI_VERIFY_CMD?.trim();
	if (piVerify) {
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

/** Edit-class tool names that mark the session dirty (re-verify on next settle). */
export const EDIT_TOOLS = new Set(['edit', 'write']);

export interface CommandVerifierOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	runChecksImpl?: typeof runChecks;
	dirty?: Set<string>;
}

export class CommandVerifier implements Verifier {
	private readonly cwd: string;
	private readonly env: NodeJS.ProcessEnv;
	private readonly run: typeof runChecks;
	private readonly dirty: Set<string>;

	constructor(options: CommandVerifierOptions) {
		this.cwd = options.cwd;
		this.env = options.env ?? process.env;
		this.run = options.runChecksImpl ?? runChecks;
		this.dirty = options.dirty ?? new Set<string>();
	}

	markDirty(conversationKey: string): void { this.dirty.add(conversationKey); }
	isDirty(conversationKey: string): boolean { return this.dirty.has(conversationKey); }
	clearDirty(conversationKey: string): void { this.dirty.delete(conversationKey); }

	async verify(ctx: VerifyContext): Promise<VerificationRun | null> {
		const commands = resolveCheckCommands(ctx.cwd, this.env);
		if (!commands.length || !this.dirty.has(ctx.conversationKey)) return null;
		try {
			return await this.run(commands, ctx.cwd, DEFAULT_BUDGET, 'edit');
		} catch {
			return null;
		}
	}
}
