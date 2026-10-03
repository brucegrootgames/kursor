/**
 * Lazy loader for `@anthropic-ai/claude-agent-sdk`.
 *
 * The SDK is ESM-only ("type": "module"); this extension is compiled as CommonJS
 * (tsconfig `module: Node16`), so a static `import { query } from …` is a type
 * error (TS1479). Type-only imports carry `resolution-mode: import`, and the
 * runtime module is loaded once with a dynamic `import()` — esbuild folds that
 * into the CJS bundle, so nothing is loaded from disk at runtime.
 *
 * This file must stay free of `vscode` imports (it is also bundled into the
 * probe script under scripts/).
 */
export type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk', { with: { 'resolution-mode': 'import' } });

export type {
  Options as SdkOptions,
  Query as SdkQuery,
  SDKMessage,
  SDKUserMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKPartialAssistantMessage,
  SDKSystemMessage,
  PermissionResult,
  PermissionUpdate,
  PermissionMode as SdkPermissionMode,
  EffortLevel as SdkEffortLevel,
  CanUseTool,
  HookCallback,
  HookInput,
  HookJSONOutput,
  PreToolUseHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  ModelInfo,
  SlashCommand,
  SDKSessionInfo,
  SessionMessage,
  RewindFilesResult,
  SDKControlInterruptResponse,
} from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };

let sdkPromise: Promise<SdkModule> | undefined;

/** Load the SDK once. Rejections are not cached so a transient failure can be retried. */
export function loadSdk(): Promise<SdkModule> {
  if (!sdkPromise) {
    sdkPromise = import('@anthropic-ai/claude-agent-sdk').catch((err: unknown) => {
      sdkPromise = undefined;
      throw err;
    });
  }
  return sdkPromise;
}

/** True when `err` is an abort (ours or the SDK's). */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; message?: unknown };
  if (e.name === 'AbortError') return true;
  return typeof e.message === 'string' && /aborted by user|operation was aborted/i.test(e.message);
}

/** Error thrown by the bridge when a request was cancelled through its AbortSignal. */
export class BridgeAbortError extends Error {
  override readonly name = 'AbortError';
  constructor(message = 'The request was cancelled') {
    super(message);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
