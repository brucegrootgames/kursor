import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  // The Agent SDK ships an .mjs entry that expects import.meta.url; keep it usable in CJS.
  define: { 'import.meta.url': 'importMetaUrl' },
  banner: { js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;" },
};

/** @type {esbuild.BuildOptions} */
const webviewConfig = {
  entryPoints: ['src/webview/main.tsx'],
  bundle: true,
  outfile: 'dist/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  loader: { '.css': 'css' },
  jsx: 'automatic',
};

function copyStatic() {
  mkdirSync('dist', { recursive: true });
  const codicons = 'node_modules/@vscode/codicons/dist';
  if (existsSync(codicons)) {
    cpSync(`${codicons}/codicon.css`, 'dist/codicon.css');
    cpSync(`${codicons}/codicon.ttf`, 'dist/codicon.ttf');
  }
}

copyStatic();
if (watch) {
  const ctxs = await Promise.all([esbuild.context(extensionConfig), esbuild.context(webviewConfig)]);
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
}
