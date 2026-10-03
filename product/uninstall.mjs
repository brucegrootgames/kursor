#!/usr/bin/env node
// Kursor uninstaller — reverses everything product/install.mjs did on this machine.
//
//   node product/uninstall.mjs [options]
//
//   --yes, -y        answer yes to every question (also deletes settings and extensions)
//   --keep-config    never delete user data (settings, extensions, flags) — no questions
//   --purge          additionally delete the cached VSCodium download
//   -h, --help       this text
//
// Always removed:
//   Linux    ~/.local/opt/kursor, ~/.local/bin/kursor, desktop entries, icons, MIME package + the two
//            mimeapps.list defaults, the Omarchy theme hook, the SUPER + SHIFT + K binding it added,
//            the Omarchy default-editor setting if it says kursor
//   macOS    ~/Applications/Kursor.app and /Applications/Kursor.app (when writable), the kursor symlinks
//            in ~/.local/bin and /usr/local/bin if they point into Kursor.app
//   Windows  %LOCALAPPDATA%\Programs\Kursor and %ProgramFiles%\Kursor (when writable), Start Menu and
//            desktop shortcuts, the bin entry on the user Path, HKCU\Software\Classes\kursor
// Asked (default keep; kept without a TTY): the user data directory (settings, state), ~/.kursor
// (extensions, argv.json) and, on Linux, ~/.config/kursor-flags.conf. Never uses sudo.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLATFORM_LABEL, die, kursorPaths, log, main, parseArgs } from './lib/common.mjs';
import { uninstallLinux } from './lib/platform-linux.mjs';
import { uninstallDarwin } from './lib/platform-darwin.mjs';
import { uninstallWin32 } from './lib/platform-win32.mjs';

const usage = () => {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  console.log(src.slice(1, src.findIndex((l) => l.startsWith('import '))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n').trim());
};

await main(async () => {
  const opts = parseArgs(process.argv.slice(2), {
    flags: ['yes', 'keep-config', 'purge', 'help'],
    values: [],
    aliases: { y: 'yes', h: 'help' },
  });
  if (opts.help) return usage();
  const platform = process.platform;
  if (!PLATFORM_LABEL[platform]) die(`unsupported platform ${platform}`);
  if (platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) die('run this as your normal user, not root');

  const flags = { yes: !!opts.yes, keepConfig: !!opts['keep-config'], purge: !!opts.purge };
  const paths = kursorPaths(platform);
  if (platform === 'linux') {
    uninstallLinux(paths, flags);
  } else if (platform === 'darwin') {
    uninstallDarwin(paths, flags, [paths.appRoot, kursorPaths('darwin', { system: true }).appRoot]);
  } else {
    uninstallWin32(paths, flags, [paths.appRoot, kursorPaths('win32', { system: true }).appRoot]);
  }
  log.step('Done');
  log.info('Kursor has been removed. Your Claude Code CLI (claude) and its login were never touched.');
});
