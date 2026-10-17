# pi-quality-gates

Quality gates for [pi](https://github.com/earendil-works/pi) coding-agent: a **settle-time rework loop** (verification fails → the agent is forced to fix before finishing) plus **instant lint injection after edits** (diagnostics land in the tool result, next turn). Ships as a pi extension package; the core is host-agnostic so other pi hosts (e.g. pi-virtual-employee) can reuse it.

## Install

```sh
pi install npm:pi-quality-gates
```

Or for local development: `pi -e /path/to/pi-quality-gates/index.ts`.

## What it does

### 1. settle-gate (`agent_before_settle`)

When a conversation ends after edit/write-class tool calls, the gate runs your verification battery:

- **Fail → forced rework**: returns `{continue:true}` with a `custom_message` boundary entry listing the failing checks, so pi runs one more model turn to fix. Capped at `maxReworks` (default 2); after that it passes through with an explicit *"work is NOT verified"* message so the agent reports honestly instead of thrashing.
- **Pass → quiet**: nothing appended, zero context tax.

### 2. lint-inject (`tool_result`)

After an edit-class tool, a fast diagnostics battery (`tsc`/`lint`/`check`-shaped commands) runs and its findings are **appended to the tool result content** — the model sees the error in its next turn instead of at commit time. Clean runs stay silent.

## Command discovery

`PI_VERIFY_CMD` (comma-separated supported) → `<cwd>/verify.sh` → `<cwd>/.pi/verify.sh`. None found → the extension is a no-op (projects without gates are untouched).

## Discipline

- **The gate fails open, verification failure is what triggers rework.** Extension errors never wedge a host loop (mirrors pi's own fail-safe: a `tool_call` handler exception blocks the tool). Runner timeouts are enforced per check (`editPerCheckMs`, default 10s) because pi has no handler timeout upstream ([#9910](https://github.com/earendil-works/pi/issues/9910)).
- **Output is tail-truncated** so a screaming test suite can't flood the context.
- **No redacted content is ever reconstructed** — only command output from your own repo.

## Environment

| Variable | Meaning |
|---|---|
| `PI_VERIFY_CMD` | Verification battery, comma-separated (`npx tsc --noEmit, npx vitest run`) |
| `PI_QUALITY_GATES` | `off` disables the extension entirely |
| `PI_QUALITY_GATES_DEBUG` | `1` appends settle decisions to `/tmp/pqg-debug.log` |

## Tests

```sh
npm test          # 17 unit tests (settle decision table + runner budgets + command discovery)
node test/smoke-rework.mjs   # end-to-end against bundled pi 1.3.0 (RPC + scripted provider)
```

The smoke asserts the rework loop end-to-end (4 provider requests: 1 write + 2 reworks + 1 pass-through) **and** the control run without the extension (2 requests, no rework) — the failure half of the contract.

## Design notes

The design rationale (upstream API survey, pi-lens/pi-permission-system precedents, upstream issue constraints) lives in the pi-desktop repo: `docs/design/pi-quality-infrastructure.md`.
