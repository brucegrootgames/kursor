/**
 * ClaudeSession: the vscode-facing wrapper around one SdkSession.
 *
 * Responsibilities on top of sdkClient:
 *  - vscode.EventEmitter for `onEvent`, `running` bookkeeping (turn counter fed
 *    by `result.queued_turn_count` and interrupt receipts)
 *  - lazy/eager spawn with executable resolution, and **transparent resume**:
 *    when the process dies (or a mode switch requires a respawn) the next
 *    `send()` recreates it with `resume: sessionId`
 *  - runtime model / effort / permission mode / chat mode changes
 *  - control calls (rewindFiles, getContextUsage, supportedModels/Commands)
 *    with timeouts so a dead process never hangs a caller
 */
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ChatMode, EffortLevel, ModelOption, PermissionMode, SlashCommandOption } from '../../shared/protocol';
import type { Logger } from '../util/log';
import type { ClaudeSession, PermissionDecision, RewindResult, SessionEvent, SessionStartOptions, UserTurn } from './types';
import { createSdkSession, type SdkExitInfo, type SdkSession } from './sdkClient';
import { errorMessage } from './sdk';

const CONTROL_TIMEOUT_MS = 20_000;

export interface SessionSpawnContext {
  /** Resolve the executable and the child env; throws with a user-facing message when unavailable. */
  resolveSpawn(): Promise<{ claudePath: string; env: Record<string, string | undefined> }>;
  /** Called once when the session is disposed (registry bookkeeping). */
  onDispose?(session: ClaudeSessionImpl): void;
}

const FALLBACK_MODELS: ModelOption[] = [
  { value: '', label: 'Default', description: "Claude Code's default model" },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'fable', label: 'Fable' },
];

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export class ClaudeSessionImpl implements ClaudeSession {
  readonly id = randomUUID();
  private readonly emitter = new vscode.EventEmitter<SessionEvent>();
  readonly onEvent = this.emitter.event;

  private client: SdkSession | undefined;
  private spawning: Promise<SdkSession | undefined> | undefined;
  private _sessionId: string | undefined;
  private pendingTurns = 0;
  private disposed = false;
  /** Set when the live process no longer matches the wanted mode (Ask → Agent/Plan): respawn on next idle send. */
  private needsRespawn = false;
  private readonly current: { mode: ChatMode; permissionMode: PermissionMode; model: string; effort: EffortLevel };
  private modelsCache: ModelOption[] | undefined;
  private commandsCache: SlashCommandOption[] | undefined;

  constructor(
    private readonly spawnContext: SessionSpawnContext,
    private readonly options: SessionStartOptions,
    private readonly log: Logger,
  ) {
    this._sessionId = options.resume;
    this.current = {
      mode: options.mode,
      permissionMode: options.permissionMode,
      model: options.model ?? '',
      effort: options.effort ?? '',
    };
    // Spawn eagerly so `init` (models, commands, session id) arrives before the first send.
    void this.ensureClient();
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  get running(): boolean {
    return this.pendingTurns > 0;
  }

  // --- process lifecycle ---------------------------------------------------

  private ensureClient(): Promise<SdkSession | undefined> {
    if (this.disposed) return Promise.resolve(undefined);
    if (this.client && !this.client.closed) return Promise.resolve(this.client);
    if (this.spawning) return this.spawning;
    this.spawning = this.spawn().finally(() => {
      this.spawning = undefined;
    });
    return this.spawning;
  }

  private async spawn(): Promise<SdkSession | undefined> {
    let spawnInfo: { claudePath: string; env: Record<string, string | undefined> };
    try {
      spawnInfo = await this.spawnContext.resolveSpawn();
    } catch (err) {
      this.emitter.fire({ type: 'error', message: errorMessage(err), fatal: true });
      return undefined;
    }
    const resume = this._sessionId;
    this.log.info(`spawning claude session ${this.id.slice(0, 8)} (${resume ? `resume ${resume}` : 'new'}, mode=${this.current.mode}, cwd=${this.options.cwd})`);
    let client: SdkSession | undefined;
    try {
      const created = await createSdkSession(
        {
          claudePath: spawnInfo.claudePath,
          env: spawnInfo.env,
          cwd: this.options.cwd,
          mode: this.current.mode,
          permissionMode: this.current.permissionMode,
          model: this.current.model,
          effort: this.current.effort,
          resume,
          appendSystemPrompt: this.options.appendSystemPrompt,
          additionalDirectories: this.options.additionalDirectories,
        },
        {
          log: this.log,
          onEvent: (event) => this.handleEvent(event),
          onExit: (info) => this.handleExit(client, info),
        },
      );
      client = created;
    } catch (err) {
      this.emitter.fire({ type: 'error', message: `Could not start Claude Code: ${errorMessage(err)}`, fatal: true });
      return undefined;
    }
    if (this.disposed) {
      client.close();
      return undefined;
    }
    this.client = client;
    this.needsRespawn = false;
    this.modelsCache = undefined;
    this.commandsCache = undefined;
    return client;
  }

  private handleEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'init':
        if (event.sessionId) this._sessionId = event.sessionId;
        this.commandsCache = undefined;
        break;
      case 'result':
        this.pendingTurns = event.queuedTurnCount ?? Math.max(0, this.pendingTurns - 1);
        break;
      default:
        break;
    }
    this.emitter.fire(event);
  }

  private handleExit(client: SdkSession | undefined, info: SdkExitInfo): void {
    if (client && this.client !== client) return; // a superseded process
    this.client = undefined;
    const hadTurns = this.pendingTurns;
    this.pendingTurns = 0;
    if (this.disposed || info.aborted) return;
    const reason = info.error ?? (info.signal ? `Claude Code was killed by ${info.signal}` : `Claude Code exited with code ${info.code ?? 'unknown'}`);
    this.log.warn(`session ${this.id.slice(0, 8)} process ended unexpectedly: ${reason}`);
    this.emitter.fire({
      type: 'error',
      message: `${reason}. ${this._sessionId ? 'The conversation will be resumed with your next message.' : 'A new process will be started with your next message.'}${
        hadTurns ? ' The interrupted turn was not completed.' : ''
      }`,
      fatal: true,
    });
    this.emitter.fire({ type: 'exit', code: info.code });
  }

  // --- ClaudeSession -------------------------------------------------------

  send(turn: UserTurn): void {
    if (this.disposed) return;
    this.pendingTurns++;
    void (async () => {
      try {
        if (this.needsRespawn && this.client && this.pendingTurns <= 1) {
          this.log.info(`respawning session ${this.id.slice(0, 8)} for mode ${this.current.mode}`);
          const old = this.client;
          this.client = undefined;
          old.close();
        }
        const client = await this.ensureClient();
        if (!client) {
          this.pendingTurns = Math.max(0, this.pendingTurns - 1);
          return;
        }
        client.send(turn);
      } catch (err) {
        this.pendingTurns = Math.max(0, this.pendingTurns - 1);
        this.log.error('send failed', err);
        this.emitter.fire({ type: 'error', message: `Could not send the message: ${errorMessage(err)}`, fatal: false });
      }
    })();
  }

  async interrupt(): Promise<void> {
    const client = this.client;
    if (!client || !this.running) return;
    const receipt = await client.interrupt();
    if (receipt) this.pendingTurns = Math.min(this.pendingTurns, 1 + receipt.still_queued.length);
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const client = this.client;
    if (!client || !client.respondPermission(requestId, decision)) {
      this.log.warn(`respondPermission: unknown request ${requestId}`);
    }
  }

  async setModel(model: string): Promise<void> {
    this.current.model = model;
    const client = this.client;
    if (!client || client.closed) return;
    await withTimeout(client.query.setModel(model || undefined), CONTROL_TIMEOUT_MS, 'setModel');
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    this.current.effort = effort;
    const client = this.client;
    if (!client || client.closed) return;
    await withTimeout(client.query.applyFlagSettings({ effortLevel: effort || null }), CONTROL_TIMEOUT_MS, 'setEffort');
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.current.permissionMode = mode;
    const client = this.client;
    if (!client || client.closed || this.current.mode !== 'agent') return; // ask/plan pin their own mode
    await withTimeout(client.query.setPermissionMode(mode), CONTROL_TIMEOUT_MS, 'setPermissionMode');
  }

  async setMode(mode: ChatMode): Promise<void> {
    this.current.mode = mode;
    const client = this.client;
    if (!client || client.closed) return;
    client.setAskMode(mode === 'ask');
    if (mode !== 'ask' && client.spawnedMode === 'ask') this.needsRespawn = true;
    const target: PermissionMode = mode === 'ask' ? 'default' : mode === 'plan' ? 'plan' : this.current.permissionMode;
    await withTimeout(client.query.setPermissionMode(target), CONTROL_TIMEOUT_MS, 'setMode');
  }

  async rewindFiles(userMessageUuid: string, dryRun = false): Promise<RewindResult> {
    const client = await this.ensureClient();
    if (!client) return { canRewind: false, error: 'Claude Code is not running' };
    try {
      const r = await withTimeout(client.query.rewindFiles(userMessageUuid, { dryRun }), CONTROL_TIMEOUT_MS, 'rewindFiles');
      return { canRewind: r.canRewind, filesChanged: r.filesChanged, error: r.error };
    } catch (err) {
      return { canRewind: false, error: errorMessage(err) };
    }
  }

  async contextUsage(): Promise<{ usedTokens: number; maxTokens: number; breakdown?: { label: string; tokens: number }[] } | undefined> {
    const client = this.client;
    if (!client || client.closed) return undefined;
    try {
      const r = await withTimeout(client.query.getContextUsage(), CONTROL_TIMEOUT_MS, 'getContextUsage');
      return {
        usedTokens: r.totalTokens,
        maxTokens: r.maxTokens,
        breakdown: r.categories.filter((c) => c.kind === 'used' && c.tokens > 0).map((c) => ({ label: c.name, tokens: c.tokens })),
      };
    } catch (err) {
      this.log.debug(`getContextUsage failed: ${errorMessage(err)}`);
      return undefined;
    }
  }

  async supportedModels(): Promise<ModelOption[]> {
    if (this.modelsCache) return this.modelsCache;
    const client = await this.ensureClient();
    if (!client) return FALLBACK_MODELS;
    try {
      const infos = await withTimeout(client.query.supportedModels(), CONTROL_TIMEOUT_MS, 'supportedModels');
      const models = infos.map<ModelOption>((m) => ({
        value: m.value === 'default' ? '' : m.value,
        label: m.displayName,
        description: m.description,
        resolvedModel: m.resolvedModel,
        supportsEffort: m.supportsEffort,
        effortLevels: m.supportedEffortLevels,
      }));
      if (!models.some((m) => m.value === '')) models.unshift(FALLBACK_MODELS[0]);
      this.modelsCache = models;
      return models;
    } catch (err) {
      this.log.debug(`supportedModels failed: ${errorMessage(err)}`);
      return FALLBACK_MODELS;
    }
  }

  async supportedCommands(): Promise<SlashCommandOption[]> {
    if (this.commandsCache) return this.commandsCache;
    const client = await this.ensureClient();
    if (!client) return [];
    try {
      const commands = await withTimeout(client.query.supportedCommands(), CONTROL_TIMEOUT_MS, 'supportedCommands');
      const out = commands.map<SlashCommandOption>((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint || undefined }));
      this.commandsCache = out;
      return out;
    } catch (err) {
      this.log.debug(`supportedCommands failed: ${errorMessage(err)}`);
      return [];
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const client = this.client;
    this.client = undefined;
    this.pendingTurns = 0;
    try {
      client?.close();
    } catch (err) {
      this.log.debug(`close failed: ${errorMessage(err)}`);
    }
    this.emitter.dispose();
    try {
      this.spawnContext.onDispose?.(this);
    } catch (err) {
      this.log.debug(`onDispose failed: ${errorMessage(err)}`);
    }
  }
}
