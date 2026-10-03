#!/usr/bin/env node
// Kursor release bundle builder — a redistributable archive per platform/arch, built WITHOUT installing.
//
//   node product/build-bundle.mjs --platform <linux|darwin|win32> --arch <x64|arm64> [--vsix dist/kursor.vsix] [--out dist/bundles]
//
// The archive unpacks to one directory:
//
//   Kursor-<platform>-<arch>-<version>/
//     app/                 the rebranded editor (darwin: app/Kursor.app) — same code path as install.mjs --stage-only
//     kursor.vsix          the extension
//     install.sh|.cmd|.ps1, uninstall.*, install.mjs, uninstall.mjs, lib/, defaults/, icons/, omarchy/
//     INSTALL.txt
//
// install.mjs finds app/ and kursor.vsix next to itself and installs from them (no download). Archives are
// .tar.gz for linux/darwin (symlinks and exec bits preserved) and .zip for win32; a .sha256 is written too.
// Any host can build any target; signing (macOS) happens on the user's machine at install time.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ARCHES, PLATFORMS, PRODUCT_DIR, REPO_DIR, VSCODIUM_VERSION, die, ensureDir, have, isFile, log, main, parseArgs, rmrf,
  sha256File, powershell,
} from './lib/common.mjs';

const BUNDLE_FILES = ['install.mjs', 'uninstall.mjs', 'install.sh', 'uninstall.sh', 'install.ps1', 'install.cmd', 'uninstall.ps1',
  'uninstall.cmd', 'README.md', 'lib', 'defaults', 'icons', 'omarchy'];

function installText(platform, name) {
  const common = `Kursor ${VSCODIUM_VERSION} — ${name}

Requirements: Node.js 18+ (only to run the installer) and the Claude Code CLI installed and signed in
on this machine (https://code.claude.com/docs/en/setup; sign in with:  claude auth login).
`;
  if (platform === 'win32') {
    return `${common}
Install:    double-click install.cmd, or in a terminal:   install.cmd            (add --help for options)
            Installs to %LOCALAPPDATA%\\Programs\\Kursor, adds a Start Menu entry and 'kursor' to your user Path.
Uninstall:  uninstall.cmd
`;
  }
  return `${common}
Install:    bash install.sh            (add --help for options; nothing needs sudo)
${platform === 'darwin'
    ? '            Installs ~/Applications/Kursor.app and the \'kursor\' command in ~/.local/bin. The app is signed ad hoc:\n            if macOS refuses the first launch, right-click Kursor.app → Open once.'
    : '            Installs ~/.local/opt/kursor, the \'kursor\' command in ~/.local/bin, desktop entry and icons\n            (Omarchy: theme hook; --hypr-bind, --default-editor optional).'}
Uninstall:  bash uninstall.sh
`;
}

function archive(platform, workDir, name, outFile) {
  rmrf(outFile);
  if (platform !== 'win32') {
    const r = spawnSync('tar', ['-C', workDir, '-czf', outFile, name], { stdio: 'inherit' });
    if (r.status !== 0) die('tar failed');
    return 'tar';
  }
  // zip: `zip` (Linux/macOS), bsdtar -a (Windows tar.exe, macOS), PowerShell Compress-Archive as last resort.
  if (have('zip')) {
    const r = spawnSync('zip', ['-q', '-r', '-X', outFile, name], { cwd: workDir, stdio: 'inherit' });
    if (r.status !== 0) die('zip failed');
    return 'zip';
  }
  for (const tar of ['bsdtar', 'tar']) {
    if (!have(tar)) continue;
    const r = spawnSync(tar, ['-C', workDir, '-a', '-cf', outFile, name], { stdio: 'inherit' });
    if (r.status === 0) return `${tar} -a`;
    rmrf(outFile);
  }
  if (process.platform === 'win32') {
    const r = powershell('Compress-Archive -LiteralPath $env:KURSOR_SRC -DestinationPath $env:KURSOR_OUT -Force',
      { KURSOR_SRC: path.join(workDir, name), KURSOR_OUT: outFile });
    if (r.ok) return 'Compress-Archive';
    die(`Compress-Archive failed:\n${r.stderr}`);
  }
  die('no zip tool found (zip, bsdtar or tar -a)');
}

await main(async () => {
  const opts = parseArgs(process.argv.slice(2), { flags: ['help', 'keep-work'], values: ['platform', 'arch', 'vsix', 'out'], aliases: { h: 'help' } });
  if (opts.help) {
    const src = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n');
    return console.log(src.slice(1, src.findIndex((l) => l.startsWith('import '))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n').trim());
  }
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  if (!PLATFORMS.includes(platform) || !ARCHES.includes(arch)) die(`need --platform <${PLATFORMS.join('|')}> --arch <${ARCHES.join('|')}>`);
  const vsix = path.resolve(opts.vsix || path.join(REPO_DIR, 'dist', 'kursor.vsix'));
  if (!isFile(vsix)) die(`extension package not found: ${vsix} (npm run package, or --vsix <path>)`);
  const outDir = path.resolve(opts.out || path.join(REPO_DIR, 'dist', 'bundles'));
  const name = `Kursor-${platform}-${arch}-${VSCODIUM_VERSION}`;
  const workDir = path.join(outDir, 'work');
  const bundleDir = path.join(workDir, name);
  rmrf(bundleDir);
  ensureDir(bundleDir);

  log.step(`Bundle ${name}`);
  // 1. the rebranded editor, through install.mjs --stage-only (same code, same checks)
  const stage = spawnSync(process.execPath, [path.join(PRODUCT_DIR, 'install.mjs'), '--stage-only', path.join(bundleDir, 'app'),
    '--platform', platform, '--arch', arch, '--yes'], { stdio: 'inherit', env: process.env });
  if (stage.status !== 0) die('staging failed');

  // 2. installer, defaults, icons, hook, extension
  log.step('Packaging');
  for (const f of BUNDLE_FILES) {
    const src = path.join(PRODUCT_DIR, f);
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, path.join(bundleDir, f), { recursive: true });
  }
  const svg = path.join(REPO_DIR, 'media', 'kursor.svg');
  if (isFile(svg)) fs.copyFileSync(svg, path.join(bundleDir, 'icons', 'kursor.svg'));
  fs.copyFileSync(vsix, path.join(bundleDir, 'kursor.vsix'));
  fs.copyFileSync(path.join(REPO_DIR, 'LICENSE'), path.join(bundleDir, 'LICENSE'));
  fs.writeFileSync(path.join(bundleDir, 'INSTALL.txt'), installText(platform, name));
  if (process.platform !== 'win32') for (const f of ['install.sh', 'uninstall.sh']) fs.chmodSync(path.join(bundleDir, f), 0o755);

  // 3. archive + checksum
  const outFile = path.join(outDir, `${name}.${platform === 'win32' ? 'zip' : 'tar.gz'}`);
  const tool = archive(platform, workDir, name, outFile);
  const sha = await sha256File(outFile);
  fs.writeFileSync(`${outFile}.sha256`, `${sha}  ${path.basename(outFile)}\n`);
  if (!opts['keep-work']) rmrf(bundleDir);
  log.ok(`${outFile} (${(fs.statSync(outFile).size / 1048576).toFixed(0)} MB, ${tool})`);
  log.ok(`sha256 ${sha}`);
});
