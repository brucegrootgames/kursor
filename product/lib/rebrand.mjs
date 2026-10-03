// Kursor product scripts — turning an extracted VSCodium tree into Kursor, per platform.
// Pure file surgery: nothing here touches the user's home or runs the editor, so it is the same
// code path for a real install, for --stage-only and for build-bundle.mjs (cross-platform).
//
//   Linux   tarball root: codium → kursor, bin/codium → bin/kursor (launcher patched), icon, completions
//   macOS   VSCodium.app → Kursor.app: Info.plist identity, generated Kursor.icns, bin/kursor
//   Windows VSCodium.exe → Kursor.exe, bin\kursor.cmd + bin\kursor, generated Kursor.ico, tile manifest
//   all     resources/app/product.json + package.json identity patch, kursor-install.json marker

import fs from 'node:fs';
import path from 'node:path';
import {
  PRODUCT_DIR, REPO_DIR, REPO_URL, VSCODIUM_VERSION, appDirOf, markerOf, die, exists, isFile, isDir,
  log, nowIso, readJson, replaceInFile, writeJson, have, run,
} from './common.mjs';
import { buildIcns, buildIco, loadIconPngs } from './icons.mjs';
import { parsePlist, serializePlist } from './plist.mjs';

// ---- product.json / package.json (identical on every platform) --------------------------------
// Identity only; version, commit, quality, date, checksums (the "installation is corrupt" check),
// the Open VSX gallery, built-in extensions and API proposals stay exactly as shipped.
export function patchProductJson(file, { repoUrl = REPO_URL } = {}) {
  const p = readJson(file);
  Object.assign(p, {
    nameShort: 'Kursor',
    nameLong: 'Kursor',
    applicationName: 'kursor',
    dataFolderName: '.kursor',
    sharedDataFolderName: '.kursor-shared',
    urlProtocol: 'kursor',
    serverApplicationName: 'kursor-server',
    serverDataFolderName: '.kursor-server',
    tunnelApplicationName: 'kursor-tunnel',
    linuxIconName: 'kursor',
    win32DirName: 'Kursor',
    win32NameVersion: 'Kursor',
    win32ShellNameShort: 'Kursor',
    win32RegValueName: 'Kursor',
    win32MutexName: 'kursor',
    win32AppUserModelId: 'Kursor.Kursor',
    win32TunnelServiceMutex: 'kursor-tunnelservice',
    win32TunnelMutex: 'kursor-tunnel',
    darwinBundleIdentifier: 'com.kursor.editor',
  });
  // The macOS/Windows builds carry VSCodium's self-update endpoints; Kursor is updated by its installer.
  delete p.updateUrl;
  delete p.downloadUrl;
  if (repoUrl) {
    Object.assign(p, {
      licenseUrl: `${repoUrl}/blob/main/LICENSE`,
      reportIssueUrl: `${repoUrl}/issues/new`,
      requestFeatureUrl: `${repoUrl}/issues/new`,
      documentationUrl: `${repoUrl}#readme`,
      releaseNotesUrl: `${repoUrl}/releases`,
      keyboardShortcutsUrlLinux: `${repoUrl}/blob/main/docs/USAGE.md`,
      keyboardShortcutsUrlMac: `${repoUrl}/blob/main/docs/USAGE.md`,
      keyboardShortcutsUrlWin: `${repoUrl}/blob/main/docs/USAGE.md`,
    });
    for (const k of ['introductoryVideosUrl', 'tipsAndTricksUrl', 'twitterUrl']) delete p[k];
  } else {
    // No public repository configured: hide the Help-menu links that would otherwise point at VSCodium/Microsoft.
    for (const k of ['reportIssueUrl', 'requestFeatureUrl', 'documentationUrl', 'releaseNotesUrl',
      'keyboardShortcutsUrlLinux', 'keyboardShortcutsUrlMac', 'keyboardShortcutsUrlWin',
      'introductoryVideosUrl', 'tipsAndTricksUrl', 'twitterUrl']) delete p[k];
  }
  writeJson(file, p);
  const ok = p.nameShort === 'Kursor' && p.nameLong === 'Kursor' && p.applicationName === 'kursor'
    && p.dataFolderName === '.kursor' && p.urlProtocol === 'kursor' && p.version === VSCODIUM_VERSION
    && typeof p.commit === 'string' && typeof p.checksums === 'object' && p.checksums
    && p.extensionsGallery && typeof p.extensionsGallery.serviceUrl === 'string';
  if (!ok) die(`product.json verification failed after patching (${file})`);
  return p;
}

// Electron reads `name` and `desktopName`; desktopName gives the Wayland app_id / X11 WM_CLASS "kursor".
export function patchPackageJson(file) {
  const p = readJson(file);
  p.name = 'Kursor';
  p.desktopName = 'kursor.desktop';
  writeJson(file, p);
  if (typeof p.main !== 'string') die(`package.json verification failed after patching (${file})`);
}

// ---- Workbench artwork (identical on every platform) ------------------------------------------
// The empty-editor watermark (letterpress-*.svg) and the welcome-page icon (code-icon.svg) live in
// resources/app/out/media. None of them is in product.json's `checksums`, so swapping them does not
// trigger the "installation is corrupt" warning. The SVGs ship in product/brand/ (copied from the
// repo's brand/ directory) so a release bundle does not depend on the repo checkout.
const BRAND_DIR = path.join(PRODUCT_DIR, 'brand');
const BRAND_MEDIA = [
  ['letterpress-dark.svg', 'letterpress-dark.svg'],
  ['letterpress-light.svg', 'letterpress-light.svg'],
  ['letterpress-hcDark.svg', 'letterpress-hcDark.svg'],
  ['letterpress-hcLight.svg', 'letterpress-hcLight.svg'],
  ['kursor-mark.svg', 'code-icon.svg'],
];
export function patchWorkbenchMedia(appDir) {
  const media = path.join(appDir, 'out', 'media');
  if (!isDir(media)) { log.warn(`${media} not found — workbench artwork left as shipped (VSCodium layout changed?)`); return 0; }
  let n = 0;
  for (const [src, dst] of BRAND_MEDIA) {
    const from = path.join(BRAND_DIR, src);
    const to = path.join(media, dst);
    if (!isFile(from)) die(`brand asset missing: ${from} — run from a complete checkout or bundle`);
    if (!isFile(to)) continue; // only replace what VSCodium ships; never add files to out/media
    fs.copyFileSync(from, to);
    n++;
  }
  return n;
}

// Shell completions ship under the old command name.
function patchCompletions(dir) {
  if (!isDir(dir)) return;
  const bash = path.join(dir, 'bash', 'codium');
  const zsh = path.join(dir, 'zsh', '_codium');
  if (isFile(bash)) { replaceInFile(bash, 'codium', 'kursor'); fs.renameSync(bash, path.join(dir, 'bash', 'kursor')); }
  if (isFile(zsh)) { replaceInFile(zsh, 'codium', 'kursor'); fs.renameSync(zsh, path.join(dir, 'zsh', '_kursor')); }
}

function rename(from, to) {
  if (!exists(from)) die(`unexpected layout: ${from} is missing (VSCodium layout changed?)`);
  fs.renameSync(from, to);
}
function mustPatch(file, from, to, what) {
  if (!replaceInFile(file, from, to)) die(`${what}: "${from}" not found in ${file} (VSCodium layout changed?)`);
}

function writeMarker(file, { platform, arch, sha256, source }) {
  writeJson(file, {
    product: 'Kursor',
    platform,
    arch,
    vscodiumVersion: VSCODIUM_VERSION,
    assetSha256: sha256,
    stagedAt: nowIso(),
    installer: 'product/install.mjs',
    sourceRepo: source || REPO_DIR,
  });
}

// ---- Linux ------------------------------------------------------------------------------------
function rebrandLinux(root, info) {
  const app = appDirOf('linux', root);
  for (const f of [path.join(root, 'codium'), path.join(root, 'bin', 'codium'), path.join(app, 'product.json'), path.join(app, 'package.json')]) {
    if (!exists(f)) die(`unexpected tarball layout (missing ${path.relative(root, f)})`);
  }
  // 1. Binaries: the Electron executable and the CLI launchers.
  rename(path.join(root, 'codium'), path.join(root, 'kursor'));
  rename(path.join(root, 'bin', 'codium'), path.join(root, 'bin', 'kursor'));
  if (exists(path.join(root, 'bin', 'codium-tunnel'))) rename(path.join(root, 'bin', 'codium-tunnel'), path.join(root, 'bin', 'kursor-tunnel'));

  // 2. bin/kursor (POSIX sh launcher): run the renamed executable, resolve our install dir, fix messages.
  const launcher = path.join(root, 'bin', 'kursor');
  mustPatch(launcher, 'ELECTRON="$VSCODE_PATH/codium"', 'ELECTRON="$VSCODE_PATH/kursor"', 'launcher patch');
  replaceInFile(launcher, "which -a 'codium'", "which -a 'kursor'");
  // Fallback only used when `readlink` is missing; $HOME is expanded by sh at run time.
  replaceInFile(launcher, 'VSCODE_PATH="/usr/share/codium"', 'VSCODE_PATH="$HOME/.local/opt/kursor"');
  replaceInFile(launcher, 'VSCodium', 'Kursor');
  replaceInFile(launcher, '\\`codium\\`', '\\`kursor\\`'); // the file escapes its backticks
  fs.chmodSync(launcher, 0o755);

  patchProductJson(path.join(app, 'product.json'));
  patchPackageJson(path.join(app, 'package.json'));
  patchWorkbenchMedia(app);

  // Window/about icon used by Electron on Linux.
  fs.copyFileSync(path.join(PRODUCT_DIR, 'icons', 'kursor-1024.png'), path.join(app, 'resources', 'linux', 'code.png'));
  patchCompletions(path.join(root, 'resources', 'completions'));
  writeMarker(markerOf('linux', root), info);
  return root;
}

// ---- macOS ------------------------------------------------------------------------------------
function rebrandDarwin(extractDir, info) {
  const src = path.join(extractDir, 'VSCodium.app');
  if (!isDir(src)) die(`unexpected zip layout: ${src} not found`);
  const root = path.join(extractDir, 'Kursor.app');
  fs.renameSync(src, root);
  const contents = path.join(root, 'Contents');
  const resources = path.join(contents, 'Resources');
  const app = appDirOf('darwin', root);

  // 1. Info.plist identity. The executable keeps its name (CFBundleExecutable/MacOS/VSCodium) so the
  //    helper apps and the CLI launcher keep working; everything user-visible becomes Kursor.
  const plistFile = path.join(contents, 'Info.plist');
  const plist = parsePlist(fs.readFileSync(plistFile, 'utf8'));
  const executable = plist.get('CFBundleExecutable');
  if (!executable || !isFile(path.join(contents, 'MacOS', executable))) die('Info.plist: CFBundleExecutable does not point at an existing binary');
  const oldIcon = plist.get('CFBundleIconFile');
  plist.set('CFBundleName', 'Kursor');
  plist.set('CFBundleDisplayName', 'Kursor');
  plist.set('CFBundleIdentifier', 'com.kursor.editor');
  plist.set('CFBundleIconFile', 'Kursor.icns');
  plist.set('CFBundleIconName', 'Kursor');
  plist.set('CFBundleHelpBookFolder', 'Kursor HelpBook');
  plist.set('CFBundleHelpBookName', 'Kursor HelpBook');
  const urlTypes = plist.get('CFBundleURLTypes');
  if (!Array.isArray(urlTypes) || !urlTypes.length) die('Info.plist: CFBundleURLTypes missing');
  urlTypes[0].set('CFBundleURLName', 'Kursor');
  urlTypes[0].set('CFBundleURLSchemes', ['kursor']);
  for (const doc of plist.get('CFBundleDocumentTypes') || []) {
    if (doc.get('CFBundleTypeName') === 'VSCodium document') doc.set('CFBundleTypeName', 'Kursor document');
  }
  fs.writeFileSync(plistFile, serializePlist(plist));
  if (have('plutil')) {
    const r = run('plutil', ['-lint', plistFile]);
    if (!r.ok) die(`plutil rejected the patched Info.plist:\n${r.stdout}${r.stderr}`);
  }

  // 2. Application icon generated from product/icons/*.png.
  fs.writeFileSync(path.join(resources, 'Kursor.icns'), buildIcns(loadIconPngs(path.join(PRODUCT_DIR, 'icons'))));
  if (oldIcon && oldIcon !== 'Kursor.icns' && isFile(path.join(resources, oldIcon))) fs.unlinkSync(path.join(resources, oldIcon));

  // 3. CLI launcher (bash, resolves the bundle from its own path, so nothing is hard-coded).
  rename(path.join(app, 'bin', 'codium'), path.join(app, 'bin', 'kursor'));
  const launcher = path.join(app, 'bin', 'kursor');
  mustPatch(launcher, `ELECTRON="$CONTENTS/MacOS/${executable}"`, `ELECTRON="$CONTENTS/MacOS/${executable}"`, 'launcher check');
  replaceInFile(launcher, "which -a 'codium'", "which -a 'kursor'");
  fs.chmodSync(launcher, 0o755);
  if (exists(path.join(app, 'bin', 'codium-tunnel'))) rename(path.join(app, 'bin', 'codium-tunnel'), path.join(app, 'bin', 'kursor-tunnel'));

  patchProductJson(path.join(app, 'product.json'));
  patchPackageJson(path.join(app, 'package.json'));
  patchWorkbenchMedia(app);
  patchCompletions(path.join(resources, 'completions'));
  writeMarker(markerOf('darwin', root), info);
  return root;
}

// ---- Windows ----------------------------------------------------------------------------------
function rebrandWin32(root, info) {
  const app = appDirOf('win32', root);
  for (const f of [path.join(root, 'VSCodium.exe'), path.join(root, 'bin', 'codium.cmd'), path.join(app, 'product.json')]) {
    if (!exists(f)) die(`unexpected zip layout (missing ${path.relative(root, f)})`);
  }
  rename(path.join(root, 'VSCodium.exe'), path.join(root, 'Kursor.exe'));

  // bin\kursor.cmd (cmd.exe) and bin\kursor (sh, for Git Bash / WSL) both reference the exe by name.
  rename(path.join(root, 'bin', 'codium.cmd'), path.join(root, 'bin', 'kursor.cmd'));
  mustPatch(path.join(root, 'bin', 'kursor.cmd'), '\\VSCodium.exe"', '\\Kursor.exe"', 'kursor.cmd patch');
  if (exists(path.join(root, 'bin', 'codium'))) {
    rename(path.join(root, 'bin', 'codium'), path.join(root, 'bin', 'kursor'));
    const sh = path.join(root, 'bin', 'kursor');
    mustPatch(sh, 'NAME="VSCodium"', 'NAME="Kursor"', 'bin/kursor patch');
    replaceInFile(sh, 'APP_NAME="codium"', 'APP_NAME="kursor"');
    if (process.platform !== 'win32') fs.chmodSync(sh, 0o755); // zip entries made on Windows carry no mode
  }
  if (exists(path.join(root, 'bin', 'codium-tunnel.exe'))) rename(path.join(root, 'bin', 'codium-tunnel.exe'), path.join(root, 'bin', 'kursor-tunnel.exe'));

  // Icon: Kursor.ico next to the exe (shortcuts and the protocol handler point at it); the exe's own
  // resource icon is replaced only when rcedit is available.
  const pngs = loadIconPngs(path.join(PRODUCT_DIR, 'icons'));
  const ico = path.join(root, 'Kursor.ico');
  fs.writeFileSync(ico, buildIco(pngs));
  info.rcedit = false;
  if (have('rcedit')) {
    const r = run('rcedit', [path.join(root, 'Kursor.exe'), '--set-icon', ico]);
    if (r.ok) info.rcedit = true; else log.warn(`rcedit failed (${(r.stderr || r.stdout).trim()}) — Kursor.exe keeps VSCodium's embedded icon`);
  }

  // Start-menu tile manifest is matched by exe name.
  const manifest = path.join(root, 'VSCodium.VisualElementsManifest.xml');
  if (isFile(manifest)) {
    replaceInFile(manifest, 'ShortDisplayName="VSCodium"', 'ShortDisplayName="Kursor"');
    fs.renameSync(manifest, path.join(root, 'Kursor.VisualElementsManifest.xml'));
    const tiles = path.join(app, 'resources', 'win32');
    if (isFile(path.join(tiles, 'code_150x150.png'))) fs.copyFileSync(path.join(PRODUCT_DIR, 'icons', 'kursor-256.png'), path.join(tiles, 'code_150x150.png'));
    if (isFile(path.join(tiles, 'code_70x70.png'))) fs.copyFileSync(path.join(PRODUCT_DIR, 'icons', 'kursor-128.png'), path.join(tiles, 'code_70x70.png'));
  }

  patchProductJson(path.join(app, 'product.json'));
  patchPackageJson(path.join(app, 'package.json'));
  patchWorkbenchMedia(app);
  writeMarker(markerOf('win32', root), info);
  return root;
}

// rebrand(platform, extractDir, info) → path of the staged application root
//   (linux/win32: extractDir itself; darwin: extractDir/Kursor.app). `info` = { platform, arch, sha256 }.
export function rebrand(platform, extractDir, info) {
  if (!isFile(path.join(PRODUCT_DIR, 'icons', 'kursor-1024.png'))) die('icon assets missing — run from a complete checkout or bundle');
  if (!isFile(path.join(BRAND_DIR, 'kursor-mark.svg'))) die('brand assets missing (product/brand) — run from a complete checkout or bundle');
  const root = platform === 'linux' ? rebrandLinux(extractDir, info)
    : platform === 'darwin' ? rebrandDarwin(extractDir, info)
      : rebrandWin32(extractDir, info);
  log.ok(`rebranded VSCodium ${VSCODIUM_VERSION} (${platform}-${info.arch}) as Kursor`);
  return root;
}

// What a human (or a test) wants to see about a staged/installed tree.
export function describeTree(platform, root) {
  const app = appDirOf(platform, root);
  const product = readJson(path.join(app, 'product.json'));
  const pkg = readJson(path.join(app, 'package.json'));
  const lines = [
    `product.json  nameShort=${product.nameShort} applicationName=${product.applicationName} dataFolderName=${product.dataFolderName} urlProtocol=${product.urlProtocol} version=${product.version}`,
    `package.json  name=${pkg.name} desktopName=${pkg.desktopName}`,
  ];
  if (platform === 'darwin') {
    const plist = parsePlist(fs.readFileSync(path.join(root, 'Contents', 'Info.plist'), 'utf8'));
    lines.push(`Info.plist    CFBundleName=${plist.get('CFBundleName')} CFBundleIdentifier=${plist.get('CFBundleIdentifier')} CFBundleExecutable=${plist.get('CFBundleExecutable')} CFBundleIconFile=${plist.get('CFBundleIconFile')} URL schemes=${JSON.stringify(plist.get('CFBundleURLTypes')[0].get('CFBundleURLSchemes'))}`);
  }
  if (platform === 'win32') lines.push(`files         ${['Kursor.exe', 'Kursor.ico', 'bin\\kursor.cmd', 'bin\\kursor'].filter((f) => exists(path.join(root, ...f.split('\\')))).join(' ')}`);
  if (platform === 'linux') lines.push(`files         ${['kursor', 'bin/kursor', 'bin/kursor-tunnel'].filter((f) => exists(path.join(root, f))).join(' ')}`);
  const branded = BRAND_MEDIA.filter(([src, dst]) => {
    const f = path.join(app, 'out', 'media', dst);
    return isFile(f) && fs.readFileSync(f, 'utf8') === fs.readFileSync(path.join(BRAND_DIR, src), 'utf8');
  }).map(([, dst]) => dst);
  lines.push(`artwork       ${branded.length ? branded.join(' ') : '(none replaced)'}`);
  return lines;
}
