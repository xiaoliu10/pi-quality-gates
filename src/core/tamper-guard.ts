/**
 * Tamper guard: the structural answer to reward hacking (arXiv 2503.11926 —
 * "agents quickly learn that it is easier to modify the testing framework
 * such that tests trivially pass rather than implement a genuine solution").
 *
 * A verify command that the agent can edit is a gate whose keys were handed
 * to the person being graded. Prompt-level rules help (anti-hack guidelines
 * cut measured hack rates) but they are not structural. This module makes
 * tampering *detectable*:
 *
 *  1. at turn start, record a baseline: `git stash create` (no working-tree
 *     side effects — the ref only), or a HEAD commit hash when clean;
 *  2. before running the verify battery at settle, list the paths the
 *     battery depends on (verify script + test source dirs) and compare
 *     their blob ids at baseline vs now;
 *  3. a mismatch ⇒ the gate itself was touched: do NOT run the battery
 *     (its green would be meaningless), hand the diff back to the model.
 *
 * Non-git projects degrade to "unknown" (no baseline) — the caller decides
 * (default: run the battery, but withhold the success token so a forged
 * "verified" claim cannot reach the user report).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;

export type TamperBaseline = { kind: 'stash' | 'head'; ref: string; paths: Map<string, string> };

export type TamperVerdict =
  | { kind: 'clean' }
  | { kind: 'tampered'; changed: string[]; detail: string }
  | { kind: 'unknown'; reason: string };

const run = async (args: string[], cwd: string, stdin?: string): Promise<string> => {
  // execFile options typing lacks `input` in this @types/node version — spawn
  // explicitly for the one stdin path (hash-object --stdin-paths).
  if (stdin !== undefined) {
    const { spawn } = await import('node:child_process');
    return new Promise<string>((resolve, reject) => {
      const child = spawn('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, timeout: GIT_TIMEOUT_MS });
      let out = '';
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('error', reject);
      child.on('close', () => resolve(out));
      child.stdin.end(stdin);
    });
  }
  const r = await exec('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  return r.stdout ?? '';
};

/** Paths the verify battery reads. Kept intentionally broad for test sources. */
export function verifyDependencyPaths(cwd: string, verifyCommand: string): string[] {
  const paths = ['verify.sh', join('.pi', 'verify.sh')];
  if (verifyCommand) paths.push(verifyCommand);
  // Test source layouts across ecosystems; a missing path is simply not tracked.
  for (const dir of ['test', 'tests', 'spec', '__tests__', 'src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts']) {
    if (existsSync(join(cwd, dir))) paths.push(dir);
  }
  return paths;
}

const blobIds = async (ref: string, paths: string[], cwd: string): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  try {
    // `git ls-tree -r <ref> -- <paths>`: pathspec limits output to the battery's deps.
    const listing = await run(['ls-tree', '-r', ref, '--', ...paths], cwd);
    for (const line of listing.split('\n')) {
      const m = line.match(/^\d+\s+blob\s+([0-9a-f]+)\t(.+)$/);
      if (m) out.set(m[2], m[1]);
    }
  } catch { /* unreadable at that ref — caller treats the map as empty */ }
  return out;
};

/** Hash the WORKTREE files (not any ref): the only truth source for uncommitted edits. */
const worktreeBlobIds = async (paths: string[], cwd: string): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  try {
    // Two invocations total (measured: per-file hashing = 10s in a temp repo,
    // each spawn pays full git startup; the dependency set is small):
    //   1. ls-files expands the pathspecs (directories like `tests/` become
    //      their tracked files) — one call, NUL-separated.
    //   2. hash-object hashes the WORKTREE copies of those files in one call
    //      (positional args; --stdin-paths dropped one id in testing).
    const tracked = await run(['ls-files', '-z', '--', ...paths], cwd);
    const existing = tracked.split('\0').filter(Boolean);
    if (!existing.length) return out;
    const listing = await run(['hash-object', ...existing], cwd);
    const ids = listing.split('\n').filter(Boolean);
    existing.forEach((p, i) => { if (ids[i]) out.set(p, ids[i]); });
  } catch { /* git broken — empty map; caller reports unknown via try */ }
  return out;
};

/** Record a baseline at turn start. Returns undefined when git is unavailable. */
export async function captureBaseline(cwd: string, verifyCommand: string): Promise<TamperBaseline | undefined> {
  try {
    const isRepo = (await run(['rev-parse', '--is-inside-work-tree'], cwd)).trim();
    if (isRepo !== 'true') return undefined;
    const paths = verifyDependencyPaths(cwd, verifyCommand);
    // Baseline = the WORKTREE content at turn start (hash-object), plus a stash
    // ref for the diff summary. `git stash create` writes a dangling commit
    // WITHOUT touching the working tree — safe mid-task.
    const worktree = await worktreeBlobIds(paths, cwd);
    try {
      const ref = (await run(['stash', 'create'], cwd)).trim();
      if (ref) return { kind: 'stash', ref, paths: worktree };
    } catch { /* clean tree — no stash ref needed; worktree map IS the baseline */ }
    const head = (await run(['rev-parse', 'HEAD'], cwd)).trim();
    if (head) return { kind: 'head', ref: head, paths: worktree };
    // Unborn HEAD (fresh repo) still has a usable worktree baseline.
    return worktree.size ? { kind: 'head', ref: '', paths: worktree } : undefined;
  } catch {
    return undefined; // not a git project (or git broken) — degrade to unknown
  }
}

/** Compare the battery's dependency paths against the baseline. */
export async function checkTamper(baseline: TamperBaseline | undefined, cwd: string, verifyCommand: string): Promise<TamperVerdict> {
  if (!baseline) return { kind: 'unknown', reason: '无 git 基线（非 git 项目或 git 不可用）' };
  try {
    const paths = verifyDependencyPaths(cwd, verifyCommand);
    // Working-tree truth: hash-object each dependency path (untracked new files
    // appear here too — `git ls-tree <ref>` cannot see them). Untracked = new
    // test files created since the baseline, which is exactly the tamper shape.
    const current = await worktreeBlobIds(paths, cwd);
    const changed: string[] = [];
    for (const [p, id] of baseline.paths) {
      const nowId = current.get(p);
      if (nowId === undefined) {
        // Deleted from the index — also a tamper signal (test removed).
        changed.push(`${p} (已删除)`);
      } else if (nowId !== id) changed.push(p);
    }
    // New test files that didn't exist at baseline are reported too.
    for (const p of current.keys()) if (!baseline.paths.has(p)) changed.push(`${p} (新增)`);
    if (!changed.length) return { kind: 'clean' };
    const detail = await diffSummary(baseline.ref, cwd);
    return { kind: 'tampered', changed, detail };
  } catch (e) {
    return { kind: 'unknown', reason: `比对失败：${(e as Error).message?.slice(0, 120) ?? String(e)}` };
  }
}

async function diffSummary(baselineRef: string, cwd: string): Promise<string> {
  try {
    const out = await run(['diff', '--stat', `${baselineRef}`, '--', 'verify.sh', '.pi/verify.sh', 'test', 'tests', 'spec', '__tests__'], cwd);
    return out.trim().slice(0, 600) || '(无 diff 输出)';
  } catch { return '(diff 读取失败)'; }
}
