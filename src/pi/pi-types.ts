/**
 * Minimal structural types for the pi extension shell. We deliberately do NOT
 * depend on @earendil-works/pi-coding-agent at compile time — pi loads the
 * extension with its own runtime and passes the API object; structural typing
 * keeps the package installable without a pi peer dependency.
 */

/** Real pi 1.3.0 shapes (types.d.ts L931+): tool_call carries `toolName`,
 *  `input` and `toolCallId`; tool_result carries `toolName`, `content` (the
 *  content blocks, mutable for handlers that want to append), `toolCallId`. */
export interface PiToolCallEvent {
  type: 'tool_call';
  toolName: string;
  input: Record<string, unknown>;
  toolCallId: string;
}

export interface PiToolResultEvent {
  type: 'tool_result';
  toolName: string;
  content?: Array<{ type: string; text?: string }>;
  toolCallId: string;
  isError?: boolean;
}

export interface PiBoundaryDraft {
  type: 'custom' | 'custom_message' | 'context_edit' | 'compaction';
  customType?: string;
  content?: string;
  display?: string;
  data?: unknown;
  targetId?: string;
  replacement?: string;
}

export interface PiBeforeSettleResult {
  continue?: boolean;
  entries?: PiBoundaryDraft[];
}

export interface PiExtensionAPI {
  on(event: string, handler: (event: any, ctx?: any) => unknown | Promise<unknown>): void;
  /** Relative to the session's project cwd when available. */
  readonly cwd?: string;
}

/** Edit-class tool names in pi core (v1 scope: explicit file editors only). */
export const EDIT_TOOLS = new Set(['edit', 'write']);
