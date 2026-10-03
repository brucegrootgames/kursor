#!/usr/bin/env node
/**
 * Probe the vscode-free bridge core (src/extension/claude/sdkClient.ts) against
 * the real `claude` binary. Costs two model calls on the user's subscription.
 *
 *   node scripts/probe-bridge.mjs            # bundles itself with esbuild, then runs the bundle
 *   node scripts/probe-bridge.mjs --json     # print raw events as JSON lines
 *
 * 1. starts a streaming-input session in a temp dir, sends "Reply with exactly: pong",
 *    prints every SessionEvent until the `result`, then closes the session;
 * 2. runs one `runOneShot("Say hi in 3 words")` with a custom system prompt and streams deltas.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(here), '..');

async function bundleAndRun() {
  const esbuild = await import('esbuild');
  const outDir = mkdtempSync(path.join(process.env.KURSOR_PROBE_TMP || os.tmpdir(), 'kursor-probe-'));
  const outfile = path.join(outDir, 'probe-bridge.cjs');
  await esbuild.build({
    entryPoints: [here],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    external: ['esbuild', 'vscode'],
    logLevel: 'warning',
    define: { 'import.meta.url': 'importMetaUrl' },
    banner: { js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;" },
  });
  const r = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, KURSOR_PROBE_BUNDLED: '1' },
  });
  rmSync(outDir, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}

function makeLogger(prefix = '') {
  const w = (level) => (msg, ...args) => {
    if (level === 'debug' && !process.env.KURSOR_PROBE_DEBUG) return;
    console.error(`[${level}]${prefix} ${msg}${args.length ? ' ' + args.map((a) => (a instanceof Error ? a.stack : JSON.stringify(a))).join(' ') : ''}`);
  };
  return { info: w('info'), warn: w('warn'), error: w('error'), debug: w('debug'), show() {}, child: (p) => makeLogger(`${prefix}[${p}]`) };
}

function summarize(event) {
  switch (event.type) {
    case 'init':
      return `init session=${event.sessionId} model=${event.model} mode=${event.permissionMode} cli=${event.claudeVersion} tools=${event.tools.length}`;
    case 'blockDelta':
      return `blockDelta[${event.index}] ${event.kind} ${JSON.stringify(event.delta)}`;
    case 'assistantBlock':
      return `assistantBlock ${event.block.type} ${JSON.stringify(event.block.type === 'text' ? event.block.text : event.block.type === 'thinking' ? event.block.thinking : event.block.name)} userMessageUuid=${event.userMessageUuid}`;
    case 'userReplay':
      return `userReplay uuid=${event.uuid} text=${JSON.stringify(event.text)}`;
    case 'result':
      return `result ${event.subtype} isError=${event.isError} turns=${event.numTurns} cost=$${event.costUsd.toFixed(4)} ${event.durationMs}ms result=${JSON.stringify(event.result)} queued=${event.queuedTurnCount}`;
    case 'rateLimit':
      return `rateLimit ${event.status} 5h=${event.fiveHour} 7d=${event.sevenDay}`;
    case 'status':
      return `status ${event.status}${event.detail ? ` (${event.detail})` : ''}`;
    default:
      return `${event.type} ${JSON.stringify(event).slice(0, 200)}`;
  }
}

async function main() {
  const json = process.argv.includes('--json');
  const log = makeLogger();
  const { resolveClaudeExecutable } = await import('../src/extension/claude/resolvePath.ts');
  const { buildChildEnv } = await import('../src/extension/claude/env.ts');
  const { probeClaudeStatus } = await import('../src/extension/claude/status.ts');
  const { createSdkSession, runOneShot } = await import('../src/extension/claude/sdkClient.ts');

  const t0 = Date.now();
  const stamp = () => `+${String(Date.now() - t0).padStart(5)}ms`;

  const resolved = await resolveClaudeExecutable({ configuredPath: process.env.KURSOR_CLAUDE_PATH || '', log });
  if (!resolved) {
    console.error('claude executable not found');
    process.exit(2);
  }
  const env = buildChildEnv({ loginPath: resolved.loginPath });
  console.log(`${stamp()} executable: ${resolved.path} (${resolved.source})`);
  const status = await probeClaudeStatus(resolved.path, env);
  console.log(`${stamp()} status: ${JSON.stringify(status)}`);
  if (!status.ok) process.exit(2);

  // 1. streaming session -----------------------------------------------------
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'kursor-probe-cwd-'));
  console.log(`${stamp()} session cwd: ${cwd}`);
  let resolveResult;
  const gotResult = new Promise((r) => (resolveResult = r));
  let exitInfo;
  const session = await createSdkSession(
    {
      claudePath: resolved.path,
      env,
      cwd,
      mode: 'agent',
      permissionMode: 'acceptEdits',
      model: process.env.KURSOR_PROBE_MODEL || 'haiku',
      appendSystemPrompt: 'You are running inside a probe script. Keep answers minimal.',
    },
    {
      log: log.child('session'),
      onEvent: (event) => {
        if (json) console.log(JSON.stringify({ t: Date.now() - t0, ...event }));
        else console.log(`${stamp()} ${summarize(event)}`);
        if (event.type === 'result') resolveResult(event);
      },
      onExit: (info) => {
        exitInfo = info;
        console.log(`${stamp()} exit ${JSON.stringify(info)}`);
        resolveResult(undefined);
      },
    },
  );
  session.send({ text: 'Reply with exactly: pong' });
  const result = await Promise.race([gotResult, new Promise((r) => setTimeout(() => r('timeout'), 90_000))]);
  console.log(`${stamp()} sessionId=${session.sessionId} result=${result === 'timeout' ? 'TIMEOUT' : result ? result.result : 'exited'}`);
  session.close();
  await Promise.race([session.done, new Promise((r) => setTimeout(r, 8_000))]);
  console.log(`${stamp()} session closed (exit=${JSON.stringify(exitInfo)})`);

  // 2. one-shot -------------------------------------------------------------
  let streamed = '';
  const text = await runOneShot(
    {
      systemPrompt: 'You are a terse assistant. Answer with plain text only, no markdown.',
      prompt: 'Say hi in 3 words',
      model: process.env.KURSOR_PROBE_MODEL || 'haiku',
      cwd,
      onDelta: (d) => {
        streamed += d;
        process.stdout.write(json ? '' : d);
      },
    },
    { claudePath: resolved.path, env, log: log.child('oneShot') },
  );
  if (!json) process.stdout.write('\n');
  console.log(`${stamp()} oneShot result=${JSON.stringify(text)} streamed=${JSON.stringify(streamed)}`);

  rmSync(cwd, { recursive: true, force: true });
  process.exit(0);
}

if (!process.env.KURSOR_PROBE_BUNDLED) {
  bundleAndRun().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error('probe failed:', err);
    process.exit(1);
  });
}
