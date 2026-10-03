/**
 * SDKMessage → SessionEvent translation.
 *
 * Observed wire order (research B.1): system/init → system/status requesting →
 * rate_limit_event → stream_event message_start → content_block_start →
 * content_block_delta×N → **assistant** (complete block, BEFORE content_block_stop)
 * → content_block_stop → message_delta → message_stop → rate_limit_event → result.
 * Tool results arrive as `user` messages whose content is a tool_result block
 * (content string or block array). vscode-free.
 */
import type { PermissionMode } from '../../shared/protocol';
import type { SessionEvent } from './types';
import type { SDKMessage } from './sdk';

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Flatten a tool_result / user content payload into display text. */
export function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  const parts: string[] = [];
  for (const block of content) {
    if (!isDict(block)) continue;
    switch (block.type) {
      case 'text':
        parts.push(str(block.text) ?? '');
        break;
      case 'image': {
        const src = isDict(block.source) ? block.source : undefined;
        parts.push(`[image${src && typeof src.media_type === 'string' ? ` ${src.media_type}` : ''}]`);
        break;
      }
      case 'document':
        parts.push('[document]');
        break;
      case 'tool_result':
        parts.push(flattenContent(block.content));
        break;
      default:
        if (typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/** Text of a user message (ignores tool results and injected system reminders). */
export function userMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isDict(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image]');
  }
  return parts.join('\n');
}

const ASSISTANT_ERROR_TEXT: Record<string, string> = {
  authentication_failed: 'Not signed in to Claude Code. Run "Kursor: Sign in to Claude Code".',
  oauth_org_not_allowed: 'Your Claude organization does not allow this login.',
  account_on_hold: 'Your Claude account is on hold.',
  verification_required: 'Your Claude account needs verification.',
  billing_error: 'Billing problem with your Claude account.',
  rate_limit: 'Rate limited by the API.',
  overloaded: 'The API is overloaded; retrying.',
  invalid_request: 'The API rejected the request.',
  model_not_found: 'The selected model is not available.',
  server_error: 'The API returned a server error.',
  max_output_tokens: 'The response hit the maximum output length.',
  cloud_credential_error: 'Cloud provider credential error.',
  unknown: 'Unknown API error.',
};

export function describeAssistantError(code: string): string {
  return ASSISTANT_ERROR_TEXT[code] ?? `API error: ${code}`;
}

export class MessageTranslator {
  /** message_start id per parent_tool_use_id key, so block events can carry a messageId. */
  private readonly currentMessageId = new Map<string, string>();
  sessionId: string | undefined;

  private key(parent: string | null | undefined): string {
    return parent ?? '';
  }

  translate(msg: SDKMessage): SessionEvent[] {
    const m = msg as unknown as Dict;
    if (typeof m.session_id === 'string' && m.session_id) this.sessionId = m.session_id;
    switch (m.type) {
      case 'system':
        return this.system(m);
      case 'stream_event':
        return this.streamEvent(m);
      case 'assistant':
        return this.assistant(m);
      case 'user':
        return this.user(m);
      case 'result':
        return this.result(m);
      case 'rate_limit_event':
        return this.rateLimit(m);
      case 'auth_status': {
        const err = str(m.error);
        return err ? [{ type: 'error', message: err, fatal: false }] : [];
      }
      case 'tool_progress':
      case 'tool_use_summary':
      case 'prompt_suggestion':
      case 'conversation_reset':
      default:
        return [];
    }
  }

  private system(m: Dict): SessionEvent[] {
    switch (m.subtype) {
      case 'init':
        return [
          {
            type: 'init',
            sessionId: str(m.session_id) ?? '',
            model: str(m.model) ?? '',
            tools: Array.isArray(m.tools) ? m.tools.filter((t): t is string => typeof t === 'string') : [],
            permissionMode: (str(m.permissionMode) ?? 'default') as PermissionMode,
            claudeVersion: str(m.claude_code_version),
          },
        ];
      case 'status': {
        const events: SessionEvent[] = [];
        const status = m.status === 'requesting' || m.status === 'compacting' ? m.status : 'idle';
        events.push({ type: 'status', status });
        if (m.compact_result === 'failed') {
          events.push({ type: 'error', message: `Context compaction failed${str(m.compact_error) ? `: ${str(m.compact_error)}` : ''}`, fatal: false });
        }
        return events;
      }
      case 'permission_denied':
        return [
          {
            type: 'permissionDenied',
            toolUseId: str(m.tool_use_id) ?? '',
            toolName: str(m.tool_name) ?? '',
            message: str(m.message) ?? str(m.decision_reason) ?? 'Permission denied',
          },
        ];
      case 'thinking_tokens':
        return [{ type: 'thinkingProgress', estimatedTokens: num(m.estimated_tokens) ?? 0 }];
      case 'compact_boundary': {
        const meta = isDict(m.compact_metadata) ? m.compact_metadata : {};
        return [{ type: 'compacted', preTokens: num(meta.pre_tokens) ?? 0, postTokens: num(meta.post_tokens) }];
      }
      case 'api_retry': {
        const attempt = num(m.attempt);
        const max = num(m.max_retries);
        const delay = num(m.retry_delay_ms);
        const status = num(m.error_status);
        const detail = `Retrying${attempt !== undefined && max !== undefined ? ` (${attempt}/${max})` : ''}${status ? ` after HTTP ${status}` : ''}${
          delay ? ` in ${Math.round(delay / 1000)} s` : ''
        }${str(m.error) ? ` — ${describeAssistantError(str(m.error) ?? '')}` : ''}`;
        return [{ type: 'status', status: 'requesting', detail }];
      }
      case 'task_started':
        return [
          {
            type: 'task',
            taskId: str(m.task_id) ?? '',
            toolUseId: str(m.tool_use_id),
            description: str(m.description) ?? '',
            subagentType: str(m.subagent_type),
            phase: 'started',
          },
        ];
      case 'task_progress':
        return [
          {
            type: 'task',
            taskId: str(m.task_id) ?? '',
            toolUseId: str(m.tool_use_id),
            description: str(m.description) ?? '',
            subagentType: str(m.subagent_type),
            phase: 'progress',
            summary: str(m.summary),
            lastTool: str(m.last_tool_name),
          },
        ];
      case 'task_notification':
        return [
          {
            type: 'task',
            taskId: str(m.task_id) ?? '',
            toolUseId: str(m.tool_use_id),
            description: str(m.summary) ?? '',
            phase: 'done',
            summary: `${str(m.status) ?? 'completed'}${str(m.summary) ? `: ${str(m.summary)}` : ''}`,
          },
        ];
      case 'task_updated': {
        const patch = isDict(m.patch) ? m.patch : {};
        const status = str(patch.status);
        if (status === 'completed' || status === 'failed' || status === 'killed') {
          return [
            {
              type: 'task',
              taskId: str(m.task_id) ?? '',
              description: str(patch.description) ?? '',
              phase: 'done',
              summary: status === 'completed' ? undefined : `${status}${str(patch.error) ? `: ${str(patch.error)}` : ''}`,
            },
          ];
        }
        return [];
      }
      case 'model_refusal_no_fallback':
        return [{ type: 'error', message: str(m.content) ?? 'The model refused the request.', fatal: false }];
      case 'model_refusal_fallback':
        return [{ type: 'status', status: 'requesting', detail: 'The model refused; retrying with a fallback model' }];
      case 'informational': {
        const level = str(m.level);
        const content = str(m.content);
        if (content && level === 'warning') return [{ type: 'error', message: content, fatal: false }];
        return [];
      }
      case 'worker_shutting_down':
        return [{ type: 'error', message: `Claude Code is shutting down (${str(m.reason) ?? 'unknown reason'})`, fatal: false }];
      default:
        return [];
    }
  }

  private streamEvent(m: Dict): SessionEvent[] {
    const ev = isDict(m.event) ? m.event : undefined;
    if (!ev) return [];
    const parent = typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : null;
    const key = this.key(parent);
    switch (ev.type) {
      case 'message_start': {
        const message = isDict(ev.message) ? ev.message : {};
        const id = str(message.id) ?? str(m.uuid) ?? '';
        this.currentMessageId.set(key, id);
        return [{ type: 'streamStart', messageId: id, parentToolUseId: parent }];
      }
      case 'content_block_start': {
        const block = isDict(ev.content_block) ? ev.content_block : {};
        const index = num(ev.index) ?? 0;
        const messageId = this.currentMessageId.get(key) ?? '';
        switch (block.type) {
          case 'text':
            return [{ type: 'blockStart', messageId, index, blockType: 'text' }];
          case 'thinking':
          case 'redacted_thinking':
            return [{ type: 'blockStart', messageId, index, blockType: 'thinking' }];
          case 'tool_use':
          case 'server_tool_use':
          case 'mcp_tool_use':
            return [{ type: 'blockStart', messageId, index, blockType: 'tool_use', toolUseId: str(block.id), toolName: str(block.name) }];
          default:
            return [];
        }
      }
      case 'content_block_delta': {
        const delta = isDict(ev.delta) ? ev.delta : {};
        const index = num(ev.index) ?? 0;
        const messageId = this.currentMessageId.get(key) ?? '';
        switch (delta.type) {
          case 'text_delta':
            return [{ type: 'blockDelta', messageId, index, kind: 'text', delta: str(delta.text) ?? '' }];
          case 'thinking_delta':
            return [{ type: 'blockDelta', messageId, index, kind: 'thinking', delta: str(delta.thinking) ?? '' }];
          case 'input_json_delta':
            return [{ type: 'blockDelta', messageId, index, kind: 'input_json', delta: str(delta.partial_json) ?? '' }];
          default:
            return [];
        }
      }
      case 'content_block_stop':
        return [{ type: 'blockStop', messageId: this.currentMessageId.get(key) ?? '', index: num(ev.index) ?? 0 }];
      case 'message_stop':
        this.currentMessageId.delete(key);
        return [];
      default:
        return [];
    }
  }

  private assistant(m: Dict): SessionEvent[] {
    const message = isDict(m.message) ? m.message : {};
    const messageId = str(message.id) ?? str(m.uuid) ?? '';
    const parent = typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : null;
    const userMessageUuid = str(m.user_message_uuid);
    const error = str(m.error);
    const events: SessionEvent[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    for (const raw of content) {
      if (!isDict(raw)) continue;
      switch (raw.type) {
        case 'text':
          events.push({ type: 'assistantBlock', messageId, userMessageUuid, parentToolUseId: parent, block: { type: 'text', text: str(raw.text) ?? '' }, error });
          break;
        case 'thinking':
          events.push({ type: 'assistantBlock', messageId, userMessageUuid, parentToolUseId: parent, block: { type: 'thinking', thinking: str(raw.thinking) ?? '' }, error });
          break;
        case 'redacted_thinking':
          events.push({ type: 'assistantBlock', messageId, userMessageUuid, parentToolUseId: parent, block: { type: 'thinking', thinking: '' }, error });
          break;
        case 'tool_use':
        case 'server_tool_use':
        case 'mcp_tool_use':
          events.push({
            type: 'assistantBlock',
            messageId,
            userMessageUuid,
            parentToolUseId: parent,
            block: { type: 'tool_use', id: str(raw.id) ?? '', name: str(raw.name) ?? '', input: isDict(raw.input) ? raw.input : {} },
            error,
          });
          break;
        default:
          break;
      }
    }
    if (error && events.length === 0) {
      events.push({ type: 'error', message: describeAssistantError(error), fatal: false });
    }
    return events;
  }

  private user(m: Dict): SessionEvent[] {
    const message = isDict(m.message) ? m.message : {};
    const parent = typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : null;
    if (m.isReplay === true) {
      const uuid = str(m.uuid);
      if (!uuid) return [];
      return [{ type: 'userReplay', uuid, text: userMessageText(message.content) }];
    }
    const events: SessionEvent[] = [];
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isDict(block) || block.type !== 'tool_result') continue;
        events.push({
          type: 'toolResult',
          toolUseId: str(block.tool_use_id) ?? '',
          content: flattenContent(block.content),
          isError: block.is_error === true,
          raw: m.tool_use_result,
          parentToolUseId: parent,
        });
      }
    }
    return events;
  }

  private result(m: Dict): SessionEvent[] {
    const denials = Array.isArray(m.permission_denials) ? m.permission_denials : [];
    const errors = Array.isArray(m.errors) ? m.errors.filter((e): e is string => typeof e === 'string') : undefined;
    const startupFailure = str(m.startup_failure_reason);
    return [
      {
        type: 'result',
        subtype: str(m.subtype) ?? 'success',
        isError: m.is_error === true,
        result: str(m.result),
        errors: startupFailure ? [...(errors ?? []), `startup failure: ${startupFailure}`] : errors,
        costUsd: num(m.total_cost_usd) ?? 0,
        durationMs: num(m.duration_ms) ?? 0,
        numTurns: num(m.num_turns) ?? 0,
        permissionDenials: denials
          .filter(isDict)
          .map((d) => ({ toolName: str(d.tool_name) ?? '', toolUseId: str(d.tool_use_id) ?? '' })),
        terminalReason: str(m.terminal_reason),
        queuedTurnCount: num(m.queued_turn_count),
      },
    ];
  }

  private rateLimit(m: Dict): SessionEvent[] {
    const info = isDict(m.rate_limit_info) ? m.rate_limit_info : {};
    const windows = isDict(info.unifiedWindows) ? info.unifiedWindows : {};
    const five = isDict(windows.five_hour) ? windows.five_hour : undefined;
    const seven = isDict(windows.seven_day) ? windows.seven_day : undefined;
    const type = str(info.rateLimitType);
    const util = num(info.utilization);
    return [
      {
        type: 'rateLimit',
        status: str(info.status) ?? 'allowed',
        fiveHour: num(five?.utilization) ?? (type === 'five_hour' ? util : undefined),
        sevenDay: num(seven?.utilization) ?? (type === 'seven_day' ? util : undefined),
        resetsAt: num(five?.resetsAt) ?? num(info.resetsAt),
      },
    ];
  }
}
