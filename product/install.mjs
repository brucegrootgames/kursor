#!/usr/bin/env node
// Kursor installer — a rebranded VSCodium plus the Kursor extension, for Linux, macOS and Windows.
// Node >= 18, no dependencies. Normally started through install.sh / install.cmd, which locate Node.
//
//   node product/install.mjs [options]
//
//   --vsix <path>        extension package to install (default: dist/kursor.vsix, or kursor.vsix in a bundle)
//   --no-extension       skip installing the extension (editor only)
//   --with-icons         also install PKief.material-icon-theme from Open VSX and select it
//   --force-download     ignore the cached archive and download VSCodium again
//   --from <dir>         install a tree staged earlier (a release bundle's app/ or Kursor.app) instead of downloading
//   --yes, -y            no questions (overwrite an existing --stage-only directory, …)
//   --dry-run            print the plan and exit without touching anything
//   --stage-only <dir>   download + verify + extract + rebrand into <dir>, install nothing
//   --platform <p>       with --stage-only: linux | darwin | win32 (default: this machine)
//   --arch <a>           with --stage-only: x64 | arm64 (default: this machine)
//   -h, --help           this text
//
//   Linux (Omarchy):     --no-omarchy  skip the theme hook      --hypr-bind  SUPER + SHIFT + K binding
//                        --default-editor  make Kursor Omarchy's default editor
//   macOS / Windows:     --system  install for all users (/Applications, %ProgramFiles% — needs write access)
//   Windows:             --desktop-shortcut  also put Kursor.lnk on the desktop     --no-protocol  skip kursor://
//
// Where things go (user install):
//   Linux    ~/.local/opt/kursor, ~/.local/bin/kursor, ~/.config/Kursor/User, ~/.kursor, ~/.config/kursor-flags.conf
//   macOS    ~/Applications/Kursor.app, ~/.local/bin/kursor → Kursor.app/…/bin/kursor, ~/Library/Application Support/Kursor/User, ~/.kursor
//   Windows  %LOCALAPPDATA%\Programs\Kursor (+ bin on the user Path), Start Menu\Kursor.lnk, %APPDATA%\Kursor\User, %USERPROFILE%\.kursor
//
// Environment: KURSOR_CACHE_DIR (download cache), KURSOR_VSCODIUM_VERSION (verified against VSCodium's
// published .sha256), KURSOR_REPO_URL (Help-menu links). Idempotent: re-running upgrades the application
// directory and refreshes launchers/shortcuts, but never overwrites settings.json, keybindings.json,
// argv.json or the flags file once they exist. No sudo anywhere.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ARCHES, PLATFORMS, PLATFORM_LABEL, PRODUCT_DIR, REPO_DIR, VSCODIUM_VERSION, assetFor, cleanStaleSiblings,
  copyTree, die, ensureAsset, ensureDir, exists, extractArchive, have, isFile, jsoncSetIfAbsent, kursorPaths, log,
  main, makeStageDir, markerOf, nowIso, parseArgs, readJson, rmrf, run, swapIn, writeIfMissing, writeJson,
} from './lib/common.mjs';
import { describeTree, rebrand } from './lib/rebrand.mjs';
import * as linux from './lib/platform-linux.mjs';
import * as darwin from './lib/platform-darwin.mjs';
import * as win32 from './lib/platform-win32.mjs';

const usage = () => {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  console.log(src.slice(1, src.findIndex((l) => l.startsWith('import '))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n').trim());
};

// Headless CLI of a (staged or installed) tree. Windows runs the exe as Node directly — exactly what
// bin\kursor.cmd does — so no cmd.exe quoting is involved.
function cliFor(platform, root) {
  if (platform === 'win32') {
    return (args) => run(path.join(root, 'Kursor.exe'), [path.join(root, 'resources', 'app', 'out', 'cli.js'), ...args],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' } });
  }
  const cli = platform === 'darwin' ? path.join(root, 'Contents', 'Resources', 'app', 'bin', 'kursor') : path.join(root, 'bin', 'kursor');
  return (args) => run(cli, args);
}

// A release bundle has app/ (or app/Kursor.app) and kursor.vsix next to this script.
function prebuiltRoot(platform, dir) {
  if (!dir) return null;
  const root = platform === 'darwin' && path.basename(dir) !== 'Kursor.app' ? path.join(dir, 'Kursor.app') : dir;
  return isFile(markerOf(platform, root)) ? root : null;
}

function argvJsonFor(platform) {
  const linuxDefault = fs.readFileSync(path.join(PRODUCT_DIR, 'defaults', 'argv.json'), 'utf8');
  if (platform === 'linux') return linuxDefault;
  // The GNOME keyring choice only makes sense on Linux; macOS and Windows use their own keychains.
  return linuxDefault.split('\n').filter((l) => !/password-store|GNOME keyring/.test(l)).join('\n').replace(/\{\s*\}/, '{\n}');
}

await main(async () => {
  const opts = parseArgs(process.argv.slice(2), {
    flags: ['no-extension', 'with-icons', 'force-download', 'yes', 'dry-run', 'help', 'no-omarchy', 'hypr-bind', 'default-editor',
      'system', 'desktop-shortcut', 'no-protocol'],
    values: ['vsix', 'from', 'stage-only', 'platform', 'arch'],
    aliases: { y: 'yes', h: 'help' },
  });
  if (opts.help) return usage();

  // ---- target --------------------------------------------------------------------------------
  const host = process.platform, hostArch = process.arch;
  const platform = opts.platform || host;
  const arch = opts.arch || hostArch;
  const stageOnly = opts['stage-only'] ? path.resolve(opts['stage-only']) : null;
  if (!PLATFORMS.includes(platform)) die(`unsupported platform ${platform} (linux, darwin, win32)`);
  if (!ARCHES.includes(arch)) die(`unsupported arch ${arch} (x64, arm64)`);
  if (!stageOnly && (platform !== host || arch !== hostArch)) die('--platform/--arch select a foreign target and need --stage-only; an install always targets this machine');
  if (opts.system && platform === 'linux') die('--system is for macOS/Windows; on Linux Kursor always installs under $HOME');
  const yes = !!opts.yes;
  const paths = kursorPaths(platform, { system: !!opts.system });
  const cacheDir = kursorPaths(host).cacheDir;
  const asset = assetFor(platform, arch);

  const bundleApp = prebuiltRoot(platform, path.join(PRODUCT_DIR, 'app'));
  const from = opts.from ? prebuiltRoot(platform, path.resolve(opts.from)) : bundleApp;
  if (opts.from && !from) die(`--from ${opts.from}: no Kursor tree for ${platform} found there (missing kursor-install.json marker)`);
  if (from) {
    const m = readJson(markerOf(platform, from));
    if (m.platform !== platform || m.arch !== arch) die(`${from} was staged for ${m.platform}-${m.arch}, this machine is ${platform}-${arch}`);
  }
  const withExtension = !opts['no-extension'] && !stageOnly;
  const vsix = path.resolve(opts.vsix || (isFile(path.join(PRODUCT_DIR, 'kursor.vsix')) ? path.join(PRODUCT_DIR, 'kursor.vsix') : path.join(REPO_DIR, 'dist', 'kursor.vsix')));
  const omarchy = platform === 'linux' && host === 'linux' && linux.omarchyAvailable();
  const withOmarchy = omarchy && !opts['no-omarchy'];

  // ---- preflight -----------------------------------------------------------------------------
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 18) die(`Node.js 18 or newer is required (this is ${process.versions.node})`);
  if (host !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) die('run this as your normal user, not root — everything installs into your own account');
  if (!from) {
    const needs = asset.name.endsWith('.tar.gz') ? ['tar'] : host === 'darwin' ? ['ditto', 'unzip'] : host === 'win32' ? ['tar', 'powershell.exe'] : ['bsdtar', 'unzip'];
    if (!needs.some(have)) die(`no extraction tool found (need one of: ${needs.join(', ')})`);
  }
  if (withExtension && !isFile(vsix)) {
    die(`extension package not found: ${vsix}\n       Build it first:   npm install && npm run package\n       …or pass --vsix <path>, or --no-extension to install the editor only.`);
  }
  for (const [flag, ok] of [['hypr-bind', platform === 'linux'], ['default-editor', platform === 'linux'], ['no-omarchy', platform === 'linux'],
    ['desktop-shortcut', platform === 'win32'], ['no-protocol', platform === 'win32']]) {
    if (opts[flag] && !ok) log.warn(`--${flag} has no effect on ${PLATFORM_LABEL[platform]}`);
  }

  // ---- plan ----------------------------------------------------------------------------------
  log.step('Kursor installer');
  log.info(`target: ${PLATFORM_LABEL[platform]} ${arch}${platform !== host || arch !== hostArch ? `   (host: ${PLATFORM_LABEL[host] || host} ${hostArch})` : ''}`);
  log.info(`VSCodium ${VSCODIUM_VERSION}: ${from ? `prebuilt ${from}` : asset.url}`);
  if (stageOnly) {
    log.info(`mode: --stage-only → ${stageOnly}${platform === 'darwin' ? '/Kursor.app' : ''} (nothing is installed)`);
  } else {
    log.info(`install: ${paths.appRoot}`);
    log.info(`command: ${platform === 'win32' ? paths.cli : platform === 'darwin' ? paths.cliLink : paths.wrapper}    settings: ${paths.userDir}    extensions: ${path.join(paths.dataDir, 'extensions')}`);
    log.info(withExtension ? `extension: ${vsix}` : 'extension: skipped (--no-extension)');
    if (platform === 'linux') {
      const plan = omarchy ? [withOmarchy ? 'theme hook' : 'theme hook skipped (--no-omarchy)', opts['default-editor'] && 'default editor'] : ["not detected (no 'omarchy' command)"];
      if (opts['hypr-bind']) plan.push('SUPER + SHIFT + K binding');
      log.info(`omarchy: ${plan.filter(Boolean).join(', ')}`);
    }
    if (platform === 'win32') log.info(`windows: Start Menu shortcut${opts['desktop-shortcut'] ? ' + desktop shortcut' : ''}, user Path, ${opts['no-protocol'] ? 'no kursor:// protocol' : 'kursor:// protocol'}`);
    if (platform === 'darwin') log.info(`macos: ad-hoc codesign, quarantine cleared, CLI symlink${paths.system ? 's (~/.local/bin, /usr/local/bin)' : ' (~/.local/bin)'}`);
  }
  if (opts['dry-run']) { log.info('dry run — stopping here'); return; }
  if (!stageOnly && host === 'linux' && linux.kursorRunning(paths)) log.warn('Kursor is running. The upgrade proceeds; restart Kursor afterwards to pick it up.');
  if (!stageOnly && host === 'win32' && win32.kursorRunning()) die('Kursor.exe is running — close it first (its files are locked while it runs)');

  // ---- 1. archive ----------------------------------------------------------------------------
  const total = stageOnly ? 2 : 6;
  log.step(`1/${total}  VSCodium ${VSCODIUM_VERSION}`);
  let sha256;
  let archive = null;
  if (from) {
    sha256 = readJson(markerOf(platform, from)).assetSha256;
    log.info(`using prebuilt tree (asset sha256 ${sha256})`);
  } else {
    ({ file: archive, sha256 } = await ensureAsset(asset, cacheDir, { forceDownload: !!opts['force-download'] }));
  }

  // ---- 2. extract + rebrand (+ swap in) ------------------------------------------------------
  const target = stageOnly || paths.appRoot;
  log.step(`2/${total}  ${stageOnly ? 'Staging' : 'Installing'} ${platform === 'darwin' && stageOnly ? path.join(target, 'Kursor.app') : target}`);
  if (stageOnly && exists(target) && fs.readdirSync(target).length) {
    if (!yes) die(`${target} exists and is not empty (pass --yes to replace it)`);
    rmrf(target);
  }
  let extractDir;
  try {
    if (!stageOnly) cleanStaleSiblings(target);
    extractDir = makeStageDir(target);
  } catch (e) {
    die(`cannot write to ${path.dirname(target)} (${e.code})${opts.system ? ' — run from an elevated/admin terminal or drop --system' : ''}`);
  }
  let stagedRoot;
  try {
    if (from) {
      stagedRoot = path.join(extractDir, platform === 'darwin' ? 'Kursor.app' : 'app');
      log.info(`copying ${from}`);
      copyTree(from, stagedRoot);
    } else {
      log.info(`extracting with ${extractArchive(archive, extractDir)} into ${extractDir}`);
      stagedRoot = rebrand(platform, extractDir, { platform, arch, sha256 });
    }
    if (stageOnly) {
      if (platform === 'darwin') { ensureDir(target); fs.renameSync(stagedRoot, path.join(target, 'Kursor.app')); } else fs.renameSync(stagedRoot, target);
    } else {
      swapIn(stagedRoot, target);
      const marker = readJson(paths.marker);
      marker.installedAt = nowIso();
      marker.installedTo = paths.appRoot;
      writeJson(paths.marker, marker);
    }
  } finally {
    if (exists(extractDir)) rmrf(extractDir);
  }
  const root = stageOnly ? (platform === 'darwin' ? path.join(target, 'Kursor.app') : target) : paths.appRoot;
  log.ok(`${stageOnly ? 'staged' : 'installed'} ${root}`);
  for (const line of describeTree(platform, root)) log.info(line);
  const cli = cliFor(platform, root);

  if (stageOnly) {
    const deferred = platform === 'darwin' ? 'codesign --force --deep --sign -, xattr -dr com.apple.quarantine, CLI symlink'
      : platform === 'win32' ? 'rcedit (exe icon), Start Menu shortcut, user Path, kursor:// registry key' : 'wrapper, desktop entries, icons, MIME, Omarchy';
    if (platform === host) {
      const r = cli(['--version']);
      if (r.ok) log.ok(`staged CLI --version → ${r.stdout.trim().split('\n')[0]}`); else log.warn(`staged CLI --version failed: ${r.stderr.trim()}`);
    } else {
      log.skip(`CLI --version not executed on this platform (${PLATFORM_LABEL[platform]} binary on ${PLATFORM_LABEL[host] || host})`);
    }
    log.skip(`${PLATFORM_LABEL[platform]} integration not executed in --stage-only: ${deferred}`);
    log.info(`Install this tree on a ${PLATFORM_LABEL[platform]} ${arch} machine with:  node install.mjs --from "${root}"`);
    return;
  }

  // ---- 3. platform integration ---------------------------------------------------------------
  log.step(`3/${total}  ${platform === 'linux' ? 'Command, desktop entries, icons' : platform === 'darwin' ? 'Signing, command' : 'Shortcuts, Path, protocol'}`);
  if (platform === 'linux') {
    linux.installWrapper(paths);
    linux.installFlagsFile(paths);
    linux.installIcons(paths);
    linux.installDesktopEntries(paths);
    linux.installMime(paths);
  } else if (platform === 'darwin') {
    darwin.codesignApp(paths.appRoot);
    darwin.installCliLinks(paths);
  } else {
    win32.installShortcuts(paths, { desktop: !!opts['desktop-shortcut'] });
    win32.addToUserPath(paths);
    if (!opts['no-protocol']) win32.registerProtocol(paths);
  }

  // ---- 4. seeded user files ------------------------------------------------------------------
  log.step(`4/${total}  Default settings (only written when missing)`);
  writeIfMissing(path.join(paths.dataDir, 'argv.json'), argvJsonFor(platform));
  writeIfMissing(path.join(paths.userDir, 'settings.json'), fs.readFileSync(path.join(PRODUCT_DIR, 'defaults', 'settings.json')));
  writeIfMissing(path.join(paths.userDir, 'keybindings.json'), fs.readFileSync(path.join(PRODUCT_DIR, 'defaults', 'keybindings.json')));

  // ---- 5. extension --------------------------------------------------------------------------
  log.step(`5/${total}  Kursor extension`);
  const retryHint = `"${paths.cli}" --install-extension "${vsix}" --force`;
  if (withExtension) {
    log.info(`installing ${path.basename(vsix)} into ${path.join(paths.dataDir, 'extensions')}`);
    const r = cli(['--install-extension', vsix, '--force']);
    if (!r.ok) { console.error(r.stdout, r.stderr); die(`extension install failed. Retry by hand:  ${retryHint}`); }
    log.ok(r.stdout.trim().split('\n').filter(Boolean).pop() || 'installed');
  } else {
    log.info(`skipped (--no-extension). Later:  ${retryHint}`);
  }
  if (opts['with-icons']) {
    const id = 'PKief.material-icon-theme';
    let present = cli(['--list-extensions']).stdout.toLowerCase().split(/\r?\n/).includes(id.toLowerCase());
    if (present) log.ok(`${id} already installed`);
    else if (cli(['--install-extension', id]).ok) { present = true; log.ok(`installed ${id} from Open VSX`); }
    else log.warn(`could not install ${id} from Open VSX (offline?) — skipping the icon theme`);
    if (present) jsoncSetIfAbsent(path.join(paths.userDir, 'settings.json'), 'workbench.iconTheme', '"material-icon-theme"');
  }

  // ---- 6. omarchy ----------------------------------------------------------------------------
  if (platform === 'linux') {
    log.step(`6/${total}  Omarchy / Hyprland`);
    if (omarchy) {
      if (withOmarchy) { linux.omarchyInstallThemeHook(paths); linux.omarchyRunThemeHookOnce(paths); } else log.info('theme hook skipped (--no-omarchy); Kursor keeps the Kursor Dark theme');
      if (opts['default-editor']) linux.setDefaultEditor(paths);
    } else {
      log.info('Omarchy not detected — theme hook and default-editor steps skipped');
      if (opts['default-editor']) log.warn("--default-editor ignored: no 'omarchy' command found");
    }
    if (opts['hypr-bind']) linux.installHyprBind(paths); else log.info('no Hyprland keybinding added (pass --hypr-bind for SUPER + SHIFT + K)');
  } else {
    log.step(`6/${total}  Verifying`);
  }

  // ---- verify + next steps -------------------------------------------------------------------
  if (platform === 'linux') log.step('Verifying');
  const ver = cli(['--version']);
  const first = ver.stdout.trim().split('\n')[0];
  if (ver.ok && first === VSCODIUM_VERSION) log.ok(`kursor --version → ${first} (commit ${readJson(path.join(paths.appDir, 'product.json')).commit.slice(0, 10)})`);
  else log.warn(`'${paths.cli} --version' ${ver.ok ? `printed ${first}` : 'failed'} — the install may be incomplete${ver.stderr ? `\n${ver.stderr.trim()}` : ''}`);
  if (readJson(path.join(paths.appDir, 'product.json')).nameShort === 'Kursor') log.ok('product.json rebranded (nameShort = Kursor, dataFolderName = .kursor)');

  const claude = have('claude') || (host !== 'win32' && isFile(path.join(paths.home, '.local', 'bin', 'claude')) ? path.join(paths.home, '.local', 'bin', 'claude') : null);
  const settings = path.join(paths.userDir, 'settings.json');
  const theme = (isFile(settings) && /"workbench\.colorTheme"\s*:\s*"([^"]*)"/.exec(fs.readFileSync(settings, 'utf8')) || [])[1] || 'Kursor Dark';

  log.step('Done — next steps');
  const L = [];
  if (platform === 'linux') {
    L.push('    Launch      kursor [path]            or the "Kursor" entry in your launcher');
    if (opts['hypr-bind']) L.push('                SUPER + SHIFT + K');
    if (opts['default-editor'] && omarchy) L.push('                SUPER + SHIFT + N  (Omarchy default editor)');
  } else if (platform === 'darwin') {
    L.push('    Launch      open -a Kursor            or Kursor in Launchpad / Spotlight;   kursor [path]  in a terminal');
    L.push('                The app is signed ad hoc: if macOS refuses the first launch, right-click Kursor.app → Open once.');
  } else {
    L.push('    Launch      Start Menu → Kursor       or  kursor [path]  in a NEW terminal (the Path change needs one)');
  }
  L.push('');
  L.push('    Claude      Kursor drives the Claude Code CLI already on this machine — your own binary and login.');
  L.push('                Kursor stores no credentials; usage counts against your Claude plan.');
  L.push(claude ? `                found: ${claude}` : '                NOT FOUND on PATH — install Claude Code (https://code.claude.com/docs/en/setup) or set kursor.claude.path in Kursor');
  L.push('                Not signed in yet?  run:  claude auth login     (or use the Sign in button in Kursor\'s chat)');
  L.push('');
  L.push(`    Theme       "${theme}" is selected in settings.json (Kursor Dark ships with the extension).`);
  if (withOmarchy) {
    L.push('                With the Omarchy hook Kursor follows `omarchy theme set …`; to keep Kursor Dark instead:');
    L.push(`                touch ${paths.omarchy.skipToggle}`);
  }
  L.push('');
  L.push(`    Settings    ${settings}   (yours — the installer never overwrites it)`);
  L.push('                Ctrl+Shift+J inside Kursor opens the Kursor Settings panel; Ctrl+, the VS Code settings.');
  if (platform === 'linux') L.push(`    Flags       ${paths.flagsFile}`);
  const rerun = platform === 'win32' ? 'product\\install.cmd' : 'bash product/install.sh';
  const unrun = platform === 'win32' ? 'product\\uninstall.cmd' : 'bash product/uninstall.sh';
  L.push(`    Upgrade     re-run:  ${rerun}          Uninstall:  ${unrun}`);
  console.log(L.join('\n'));
});
