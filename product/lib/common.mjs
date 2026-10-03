// Kursor product scripts — shared by install.mjs, uninstall.mjs and build-bundle.mjs.
// Constants (VSCodium version, pinned hash, release assets), per-platform paths, logging, prompts,
// process helpers, download + sha256 verification, archive extraction and small fs utilities.
// Node >= 18, ESM, no dependencies outside node:*.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---- product constants ------------------------------------------------------------------------
export const PRODUCT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = path.resolve(PRODUCT_DIR, '..');

export const VSCODIUM_PINNED_VERSION = '1.135.06055';
export const VSCODIUM_VERSION = process.env.KURSOR_VSCODIUM_VERSION || VSCODIUM_PINNED_VERSION;
// Hashes known at release time; every other asset is verified against VSCodium's published .sha256 sidecar.
export const PINNED_SHA256 = {
  'linux-x64': 'c09d8ac8dd7f52b09ee159ee24b440541dfd8f937a0f6f88cc428c78e48ee1f2',
};
// Optional https URL of this repository: when set, Help › Report Issue / Documentation point at it.
export const REPO_URL = process.env.KURSOR_REPO_URL || 'https://github.com/brucegrootgames/kursor';

export const PLATFORMS = ['linux', 'darwin', 'win32'];
export const ARCHES = ['x64', 'arm64'];
export const PLATFORM_LABEL = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };

export function assetFor(platform, arch, version = VSCODIUM_VERSION) {
  const name = platform === 'linux'
    ? `VSCodium-linux-${arch}-${version}.tar.gz`
    : `VSCodium-${platform}-${arch}-${version}.zip`;
  return {
    name,
    url: `https://github.com/VSCodium/vscodium/releases/download/${version}/${name}`,
    pinned: version === VSCODIUM_PINNED_VERSION ? PINNED_SHA256[`${platform}-${arch}`] : undefined,
  };
}

// Hyprland binding added by --hypr-bind (focus an existing Kursor window or launch one through uwsm).
export const HYPR_BIND_MARKER = 'kursor:install';
export const HYPR_BIND_LINE =
  `o.bind("SUPER + SHIFT + K", "Kursor", "omarchy-launch-or-focus kursor 'uwsm-app -- kursor'") -- ${HYPR_BIND_MARKER}`;

// ---- locations --------------------------------------------------------------------------------
// Everything the installer touches, for one target platform. `system` selects the machine-wide
// location on macOS/Windows (never used on Linux: that install is always under $HOME).
export function kursorPaths(platform, { system = false, env = process.env, home = os.homedir() } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const j = (...a) => P.join(...a);
  const base = { platform, home, dataDir: j(home, '.kursor') }; // extensions/ + argv.json ($HOME/<dataFolderName>)

  if (platform === 'linux') {
    const cfg = env.XDG_CONFIG_HOME || j(home, '.config');
    const data = env.XDG_DATA_HOME || j(home, '.local', 'share');
    const cache = env.XDG_CACHE_HOME || j(home, '.cache');
    const appRoot = j(home, '.local', 'opt', 'kursor');
    return {
      ...base,
      appRoot,
      appDir: j(appRoot, 'resources', 'app'),
      cli: j(appRoot, 'bin', 'kursor'),
      electron: j(appRoot, 'kursor'),
      marker: j(appRoot, 'kursor-install.json'),
      binDir: j(home, '.local', 'bin'),
      wrapper: j(home, '.local', 'bin', 'kursor'),
      configRoot: j(cfg, 'Kursor'),
      userDir: j(cfg, 'Kursor', 'User'),
      flagsFile: j(cfg, 'kursor-flags.conf'),
      appsDir: j(data, 'applications'),
      iconDir: j(data, 'icons', 'hicolor'),
      mimeDir: j(data, 'mime'),
      mimeapps: j(cfg, 'mimeapps.list'),
      cacheDir: env.KURSOR_CACHE_DIR || j(cache, 'kursor'),
      omarchy: {
        hookDir: j(home, '.config', 'omarchy', 'hooks', 'theme-set.d'),
        hookFile: j(home, '.config', 'omarchy', 'hooks', 'theme-set.d', 'kursor-theme.hook'),
        defaultEditorFile: j(home, '.local', 'state', 'omarchy', 'defaults', 'editor'),
        skipToggle: j(home, '.local', 'state', 'omarchy', 'toggles', 'skip-kursor-theme-changes'),
        hyprBindings: j(home, '.config', 'hypr', 'bindings.lua'),
      },
    };
  }

  if (platform === 'darwin') {
    const appRoot = j(system ? '/Applications' : j(home, 'Applications'), 'Kursor.app');
    const contents = j(appRoot, 'Contents');
    const appSupport = j(home, 'Library', 'Application Support');
    return {
      ...base,
      system,
      appRoot,
      appDir: j(contents, 'Resources', 'app'),
      cli: j(contents, 'Resources', 'app', 'bin', 'kursor'),
      electron: j(contents, 'MacOS', 'VSCodium'),
      marker: j(contents, 'Resources', 'kursor-install.json'),
      binDir: j(home, '.local', 'bin'),
      cliLink: j(home, '.local', 'bin', 'kursor'),
      systemCliLink: '/usr/local/bin/kursor',
      configRoot: j(appSupport, 'Kursor'),
      userDir: j(appSupport, 'Kursor', 'User'),
      cacheDir: env.KURSOR_CACHE_DIR || j(home, 'Library', 'Caches', 'kursor'),
      stateFiles: [
        j(home, 'Library', 'Caches', 'Kursor'),
        j(home, 'Library', 'Saved Application State', 'com.kursor.editor.savedState'),
        j(home, 'Library', 'Preferences', 'com.kursor.editor.plist'),
      ],
    };
  }

  // win32
  const local = env.LOCALAPPDATA || j(home, 'AppData', 'Local');
  const roaming = env.APPDATA || j(home, 'AppData', 'Roaming');
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const appRoot = system ? j(programFiles, 'Kursor') : j(local, 'Programs', 'Kursor');
  return {
    ...base,
    system,
    appRoot,
    appDir: j(appRoot, 'resources', 'app'),
    exe: j(appRoot, 'Kursor.exe'),
    electron: j(appRoot, 'Kursor.exe'),
    cli: j(appRoot, 'bin', 'kursor.cmd'),
    cliJs: j(appRoot, 'resources', 'app', 'out', 'cli.js'),
    ico: j(appRoot, 'Kursor.ico'),
    marker: j(appRoot, 'kursor-install.json'),
    binDir: j(appRoot, 'bin'),
    configRoot: j(roaming, 'Kursor'),
    userDir: j(roaming, 'Kursor', 'User'),
    cacheDir: env.KURSOR_CACHE_DIR || j(local, 'kursor', 'cache'),
    startMenuLnk: j(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Kursor.lnk'),
    desktopLnk: j(env.USERPROFILE || home, 'Desktop', 'Kursor.lnk'),
  };
}

// Where product.json & friends live inside a (staged) application root.
export function appDirOf(platform, root) {
  return platform === 'darwin' ? path.join(root, 'Contents', 'Resources', 'app') : path.join(root, 'resources', 'app');
}
export function markerOf(platform, root) {
  return platform === 'darwin' ? path.join(root, 'Contents', 'Resources', 'kursor-install.json') : path.join(root, 'kursor-install.json');
}

// ---- output -----------------------------------------------------------------------------------
const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (colour ? `\x1b[${code}m${s}\x1b[0m` : s);
export const log = {
  step: (s) => console.log(`\n${c(34, '==>')} ${c(1, s)}`),
  info: (s) => console.log(`    ${s}`),
  ok: (s) => console.log(`    ${c(32, '✓')} ${s}`),
  warn: (s) => console.error(`    ${c(33, '!')} ${s}`),
  skip: (s) => console.log(`    ${c(2, '-')} ${s}`),
};

export class Fail extends Error {}
export function die(message) {
  throw new Fail(message);
}
// Wraps an entry point: Fail → "error: …" exit 1; anything else → stack trace exit 2.
export async function main(fn) {
  try {
    await fn();
  } catch (e) {
    if (e instanceof Fail) {
      console.error(`${c(31, 'error:')} ${e.message}`);
      process.exit(1);
    }
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(2);
  }
}

// ---- arguments --------------------------------------------------------------------------------
// parseArgs(argv, { flags: ['yes', ...], values: ['vsix', ...], aliases: { y: 'yes', h: 'help' } })
export function parseArgs(argv, spec) {
  const out = { _: [] };
  const aliases = spec.aliases || {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('-')) { out._.push(a); continue; }
    let value;
    if (a.startsWith('--') && a.includes('=')) { [a, value] = [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]; }
    let name = a.replace(/^--?/, '');
    if (aliases[name]) name = aliases[name];
    if (spec.flags.includes(name)) {
      if (value !== undefined) die(`${a} does not take a value`);
      out[name] = true;
    } else if (spec.values.includes(name)) {
      if (value === undefined) { value = argv[++i]; if (value === undefined) die(`${a} needs a value`); }
      out[name] = value;
    } else {
      die(`unknown option: ${a} (try --help)`);
    }
  }
  return out;
}

// ---- processes --------------------------------------------------------------------------------
// run(cmd, args) → { ok, status, stdout, stderr, error }; never a shell, never throws.
export function run(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
    env: opts.env || process.env,
    cwd: opts.cwd,
    input: opts.input,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  return { ok: r.status === 0 && !r.error, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

// have('tar') → full path or null (PATH lookup, honouring PATHEXT on Windows).
export function have(cmd) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').toLowerCase().split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + (cmd.toLowerCase().endsWith(ext) ? '' : ext));
      try {
        if (!fs.statSync(p).isFile()) continue;
        if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch { /* next */ }
    }
  }
  return null;
}

// PowerShell (Windows integration). Scripts receive their inputs through environment variables
// (KURSOR_*), never by string interpolation, so paths with spaces or quotes cannot break them.
export function powershell(script, env = {}) {
  const exe = have('powershell.exe') || have('pwsh') || 'powershell.exe';
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return run(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { env: { ...process.env, ...env } });
}

// confirm(question, default) → boolean. `yes` answers everything; without a TTY the default applies.
export function confirm(question, def = false, yes = false) {
  if (yes) return true;
  if (!process.stdin.isTTY) return def;
  process.stdout.write(`    ${question} ${def ? '[Y/n]' : '[y/N]'} `);
  const buf = Buffer.alloc(256);
  let n = 0;
  try { n = fs.readSync(0, buf, 0, buf.length, null); } catch { process.stdout.write('\n'); return def; }
  const ans = buf.toString('utf8', 0, n).trim().toLowerCase();
  if (!ans) return def;
  return ans === 'y' || ans === 'yes';
}

// ---- files ------------------------------------------------------------------------------------
export const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
export const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
export const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
export const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
export const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
export const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
export function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }

export function writeFileAtomic(p, data, mode) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
  if (mode !== undefined && process.platform !== 'win32') fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, p);
}

// Seed a user file once; never overwrite what the user has. Returns true when written.
export function writeIfMissing(dest, content, mode = 0o644) {
  if (exists(dest)) { log.info(`kept existing ${dest}`); return false; }
  writeFileAtomic(dest, content, mode);
  log.ok(`wrote ${dest}`);
  return true;
}

// Literal replacement of every occurrence; returns false when `from` is absent. Keeps the file mode.
export function replaceInFile(file, from, to) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(from)) return false;
  fs.writeFileSync(file, text.split(from).join(to));
  return true;
}

export function removePath(p, label = p) {
  if (!exists(p)) return false;
  rmrf(p);
  log.ok(`removed ${label}`);
  return true;
}

// Copy a directory tree preserving symlinks and modes (cp -R on Unix keeps .app bundles intact).
export function copyTree(src, dst) {
  ensureDir(path.dirname(dst));
  if (process.platform === 'win32') {
    fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    return;
  }
  const r = run('cp', process.platform === 'darwin' ? ['-R', '-p', src, dst] : ['-a', src, dst]);
  if (!r.ok) die(`copy failed: ${src} → ${dst}\n${r.stderr}`);
}

// Add one key to a JSONC settings.json without rewriting the rest of the file.
export function jsoncSetIfAbsent(file, key, valueJson) {
  ensureDir(path.dirname(file));
  if (!exists(file)) fs.writeFileSync(file, '{\n}\n');
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes(`"${key}"`)) { log.info(`settings.json already sets ${key} — left unchanged`); return false; }
  const i = text.indexOf('{');
  if (i < 0) die(`${file} does not look like a JSON object`);
  fs.writeFileSync(file, `${text.slice(0, i + 1)}\n  "${key}": ${valueJson},${text.slice(i + 1)}`);
  log.ok(`set ${key} = ${valueJson} in ${file}`);
  return true;
}

// Quote a path for a .desktop Exec= value (only when needed, per the Desktop Entry spec).
export function desktopQuote(p) {
  if (/^[A-Za-z0-9_./+:@,-]+$/.test(p)) return p;
  return `"${p.replace(/[\\"$`]/g, (m) => `\\${m}`)}"`;
}

// Leftovers of interrupted runs next to an application root (fixed prefix → only our own dirs).
export function cleanStaleSiblings(appRoot) {
  const dir = path.dirname(appRoot);
  const base = path.basename(appRoot);
  if (!isDir(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(`${base}.staging.`) || name.startsWith(`${base}.old.`)) rmrf(path.join(dir, name));
  }
}
export function makeStageDir(appRoot) {
  ensureDir(path.dirname(appRoot));
  return fs.mkdtempSync(`${appRoot}.staging.`);
}
// Replace appRoot with the staged tree: one rename each way (same filesystem by construction).
export function swapIn(stagedRoot, appRoot) {
  const old = `${appRoot}.old.${process.pid}`;
  if (exists(appRoot)) {
    try { fs.renameSync(appRoot, old); } catch (e) {
      die(`cannot replace ${appRoot} (${e.code}). Is Kursor running? Close it and retry.`);
    }
  }
  fs.renameSync(stagedRoot, appRoot);
  if (exists(old)) rmrf(old);
}

// ---- download + verification ------------------------------------------------------------------
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function httpsGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': 'kursor-installer', Accept: '*/*' } }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        return resolve(httpsGet(new URL(headers.location, url).toString(), redirects + 1));
      }
      if (statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${statusCode} for ${url}`)); }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error(`timeout fetching ${url}`)));
  });
}

export async function fetchText(url) {
  const res = await httpsGet(url);
  let data = '';
  res.setEncoding('utf8');
  for await (const chunk of res) data += chunk;
  return data;
}

export async function fetchToFile(url, dest) {
  const res = await httpsGet(url);
  const total = Number(res.headers['content-length'] || 0);
  const showProgress = process.stderr.isTTY;
  let done = 0, lastPct = -1;
  ensureDir(path.dirname(dest));
  const out = fs.createWriteStream(dest);
  await new Promise((resolve, reject) => {
    res.on('data', (chunk) => {
      done += chunk.length;
      if (showProgress && total) {
        const pct = Math.floor((done / total) * 100);
        if (pct !== lastPct) { lastPct = pct; process.stderr.write(`\r    downloading ${(done / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB (${pct}%)`); }
      }
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });
  if (showProgress && total) process.stderr.write('\n');
}

// Expected hash: pinned value for a known asset, otherwise VSCodium's .sha256 sidecar (cached).
export async function expectedSha256(asset, cacheDir) {
  if (asset.pinned) return asset.pinned;
  const side = path.join(cacheDir, `${asset.name}.sha256`);
  let text = isFile(side) ? fs.readFileSync(side, 'utf8') : '';
  if (!/^[0-9a-f]{64}\b/.test(text)) {
    log.info(`fetching checksum ${asset.url}.sha256`);
    try { text = await fetchText(`${asset.url}.sha256`); } catch (e) { die(`could not download ${asset.url}.sha256 (${e.message})`); }
    ensureDir(cacheDir);
    fs.writeFileSync(side, text);
  }
  const m = /^([0-9a-f]{64})\b/.exec(text.trim());
  if (!m) die(`unparseable checksum file ${side}`);
  return m[1];
}

// Ensures a verified archive in the cache and returns { file, sha256 }.
export async function ensureAsset(asset, cacheDir, { forceDownload = false } = {}) {
  ensureDir(cacheDir);
  const file = path.join(cacheDir, asset.name);
  const expected = await expectedSha256(asset, cacheDir);
  if (isFile(file) && !forceDownload) {
    log.info(`verifying cached ${file}`);
    if ((await sha256File(file)) === expected) { log.ok(`sha256 ok — reusing cached download`); return { file, sha256: expected }; }
    log.warn('cached archive failed verification; downloading again');
    rmrf(file);
  }
  log.info(`downloading ${asset.url}`);
  const part = `${file}.part`;
  try { await fetchToFile(asset.url, part); } catch (e) { rmrf(part); die(`download failed: ${asset.url} (${e.message})`); }
  const actual = await sha256File(part);
  if (actual !== expected) { rmrf(part); die(`sha256 mismatch for ${asset.name}: expected ${expected}, got ${actual}`); }
  fs.renameSync(part, file);
  fs.writeFileSync(path.join(cacheDir, `${asset.name}.sha256`), `${expected}  ${asset.name}\n`);
  log.ok(`downloaded and verified (sha256 ${expected})`);
  return { file, sha256: expected };
}

// ---- extraction -------------------------------------------------------------------------------
// Tools are chosen by the *host*: ditto on macOS (keeps symlinks, exec bits and resource forks),
// tar.exe (bsdtar, ships with Windows 10+) or Expand-Archive on Windows, bsdtar/unzip elsewhere.
export function extractArchive(archive, dest) {
  ensureDir(dest);
  const host = process.platform;
  const attempts = [];
  if (archive.endsWith('.tar.gz')) {
    attempts.push(['tar', ['-xzf', archive, '-C', dest]]);
  } else {
    if (host === 'darwin') attempts.push(['ditto', ['-x', '-k', archive, dest]]);
    if (host === 'win32') attempts.push(['tar', ['-xf', archive, '-C', dest]]);
    attempts.push(['bsdtar', ['-xf', archive, '-C', dest]]);
    attempts.push(['unzip', ['-q', '-o', archive, '-d', dest]]);
    if (host === 'win32') attempts.push(['__expand-archive__', []]);
  }
  for (const [tool, args] of attempts) {
    if (tool === '__expand-archive__') {
      const r = powershell('Expand-Archive -LiteralPath $env:KURSOR_ZIP -DestinationPath $env:KURSOR_DEST -Force',
        { KURSOR_ZIP: archive, KURSOR_DEST: dest });
      if (r.ok) return 'Expand-Archive';
      die(`Expand-Archive failed:\n${r.stderr}`);
    }
    if (!have(tool)) continue;
    const r = run(tool, args);
    if (r.ok) return tool;
    die(`${tool} failed while extracting ${archive}:\n${r.stderr || r.stdout}`);
  }
  die(`no extraction tool found for ${archive} (need ${archive.endsWith('.tar.gz') ? 'tar' : 'unzip, bsdtar or ditto'})`);
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
