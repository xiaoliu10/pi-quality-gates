/**
 * pi-quality-gates — settle-time rework loop + instant lint injection.
 *
 * Ships as a pi extension package (package.json `pi.extensions`). See
 * src/pi/shell.ts for the wiring and docs/ for the design rationale.
 */
export { default } from './src/pi/shell.ts';
export { resolveCheckCommands } from './src/pi/shell.ts';
export { decideSettle, SettleGateState, DEFAULT_BUDGET } from './src/core/settle.ts';
export { runChecks, runCheck } from './src/core/runner.ts';
