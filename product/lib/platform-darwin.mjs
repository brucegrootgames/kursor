// Kursor product scripts — macOS integration and its removal.
// Ad-hoc re-signing of the modified bundle, quarantine removal, the `kursor` CLI symlink
// (~/.local/bin, plus /usr/local/bin with --system). Only runs on a macOS host.

import fs from 'node:fs';
import path from 'node:path';
import { confirm, die, ensureDir, exists, have, isDir, log, removePath, run } from './common.mjs';

// The bundle's original signature no longer matches after the rebrand; an ad-hoc signature keeps
// Gatekeeper/AMFI happy for a locally installed app. First launch may still need right-click → Open.
export function codesignApp(appRoot) {
  if (!have('codesign')) { log.warn('codesign not found — the app may refuse to start until it is re-signed (xcode-select --install)'); return; }
  const r = run('codesign', ['--force', '--deep', '--sign', '-', appRoot]);
  if (!r.ok) die(`codesign failed:\n${r.stderr}`);
  const v = run('codesign', ['--verify', '--deep', '--strict', appRoot]);
  if (v.ok) log.ok(`re-signed ${appRoot} (ad hoc)`); else log.warn(`codesign --verify reported: ${v.stderr.trim()}`);
  if (have('xattr')) run('xattr', ['-dr', 'com.apple.quarantine', appRoot]);
}

function linkCli(link, target, { label }) {
  ensureDir(path.dirname(link));
  try {
    const st = fs.lstatSync(link);
    if (!st.isSymbolicLink()) { log.warn(`${link} exists and is not a symlink — left untouched (${label})`); return false; }
    fs.unlinkSync(link);
  } catch (e) {
    if (e.code !== 'ENOENT') { log.warn(`cannot replace ${link}: ${e.message}`); return false; }
  }
  try {
    fs.symlinkSync(target, link);
    log.ok(`${link} → ${target}`);
    return true;
  } catch (e) {
    log.warn(`could not create ${link} (${e.code}). Create it yourself:  sudo ln -sfn "${target}" "${link}"`);
    return false;
  }
}

export function installCliLinks(paths) {
  linkCli(paths.cliLink, paths.cli, { label: 'user CLI' });
  if (paths.system) linkCli(paths.systemCliLink, paths.cli, { label: 'system CLI' });
  const onPath = (process.env.PATH || '').split(':').includes(paths.binDir);
  if (!onPath && !paths.system) log.warn(`${paths.binDir} is not in your PATH — add it to your shell profile (or re-run with --system for /usr/local/bin)`);
}

export function kursorRunning(paths) {
  return have('pgrep') && run('pgrep', ['-f', '--', `${paths.appRoot}/Contents/MacOS/`]).ok;
}

function removeLinkIfOurs(link) {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return;
    if (!fs.readlinkSync(link).includes('Kursor.app/')) return;
  } catch { return; }
  try { fs.unlinkSync(link); log.ok(`removed ${link}`); } catch (e) { log.warn(`could not remove ${link} (${e.code}):  sudo rm "${link}"`); }
}

export function uninstallDarwin(paths, { yes, keepConfig, purge }, allRoots) {
  log.step('Removing Kursor');
  if (kursorRunning(paths)) log.warn('Kursor appears to be running — quit it first');
  for (const root of allRoots) {
    if (!exists(root)) continue;
    try { removePath(root); } catch (e) { log.warn(`could not remove ${root} (${e.code}):  sudo rm -rf "${root}"`); }
    const parent = path.dirname(root);
    if (isDir(parent)) {
      for (const n of fs.readdirSync(parent)) if (n.startsWith('Kursor.app.staging.') || n.startsWith('Kursor.app.old.')) removePath(path.join(parent, n));
    }
  }
  removeLinkIfOurs(paths.cliLink);
  removeLinkIfOurs(paths.systemCliLink);

  log.step('User data');
  if (keepConfig) {
    log.info(`kept ${paths.configRoot} and ${paths.dataDir} (--keep-config)`);
  } else {
    if (!process.stdin.isTTY && !yes) log.info('no terminal to ask on — keeping settings and extensions (use --yes to delete, --keep-config to silence this)');
    if (exists(paths.configRoot) || paths.stateFiles.some(exists)) {
      if (confirm(`Delete ${paths.configRoot} and Kursor's Library caches/state (settings, keybindings, window state)?`, false, yes)) {
        removePath(paths.configRoot);
        for (const p of paths.stateFiles) removePath(p);
      } else log.info(`kept ${paths.configRoot}`);
    }
    if (exists(paths.dataDir)) {
      if (confirm(`Delete ${paths.dataDir} (installed extensions, argv.json)?`, false, yes)) removePath(paths.dataDir); else log.info(`kept ${paths.dataDir}`);
    }
  }
  if (purge) removePath(paths.cacheDir, `cached download ${paths.cacheDir}`);
  else if (isDir(paths.cacheDir)) log.info(`kept the cached VSCodium download in ${paths.cacheDir} (pass --purge to delete it)`);
}
