/**
 * Pure-logic tests for the webview's markdown sanitizer / fence-meta parser and the
 * @-mention helpers. Bundles the TypeScript sources with esbuild into a temp file
 * (no DOM needed) and runs plain assertions.
 *
 *   node src/webview/__tests__/markdown.test.mjs
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = new URL('../../..', import.meta.url).pathname;
const dir = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'kursor-webview-test-'));
const entry = join(dir, 'entry.ts');
writeFileSync(
  entry,
  `export * as markdown from '${join(root, 'src/webview/markdown.ts')}';
export * as mentions from '${join(root, 'src/webview/mentions.ts')}';
export * as util from '${join(root, 'src/webview/util.ts')}';`,
);
const outfile = join(dir, 'bundle.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', target: 'node20', outfile, logLevel: 'silent' });
const { markdown, mentions, util } = await import(pathToFileURL(outfile).href);

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n  ${err.message}`);
  }
}

// ---- sanitizer -------------------------------------------------------------------
test('raw block HTML is escaped, never injected', () => {
  const html = markdown.renderMarkdown('<script>alert(1)</script>\n\nhello');
  assert.ok(!html.includes('<script>'), html);
  assert.ok(html.includes('&lt;script&gt;'), html);
  assert.ok(html.includes('<p>hello</p>'), html);
});
test('inline HTML tags are escaped', () => {
  const html = markdown.renderMarkdown('text <img src=x onerror=alert(1)> more');
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img'), html);
});
test('javascript: links are neutralized', () => {
  const html = markdown.renderMarkdown('[x](javascript:alert(1))');
  assert.ok(html.includes('href="#"'), html);
  assert.ok(!/javascript:/i.test(html), html);
});
test('http links keep their href and escape the title', () => {
  const html = markdown.renderMarkdown('[x](https://example.com "a\\"b")');
  assert.ok(html.includes('href="https://example.com"'), html);
  assert.ok(!html.includes('title="a"b"'), html);
});
test('relative paths are allowed as hrefs', () => {
  assert.equal(markdown.safeUrl('src/app.ts:10'), 'src/app.ts:10');
  assert.equal(markdown.safeUrl('vbscript:x'), '#');
  assert.equal(markdown.safeUrl('data:text/html,<b>'), '#');
  assert.equal(markdown.safeUrl('vscode://file/x'), 'vscode://file/x');
});
test('images: only http(s) and base64 image data URIs', () => {
  assert.ok(markdown.renderMarkdown('![a](https://x/y.png)').includes('<img src="https://x/y.png"'));
  assert.ok(markdown.renderMarkdown('![a](data:image/png;base64,AAAA)').includes('<img src="data:image/png;base64,AAAA"'));
  const bad = markdown.renderMarkdown('![a](data:text/html;base64,AAAA)');
  assert.ok(!bad.includes('<img'), bad);
  const js = markdown.renderMarkdown('![a](javascript:alert(1))');
  assert.ok(!js.includes('<img'), js);
});
test('nested fences inside lists are highlighted and escaped', () => {
  const html = markdown.renderMarkdown('- item\n\n  ```html\n  <b>x</b>\n  ```\n');
  assert.ok(html.includes('class="hljs language-xml"'), html);
  assert.ok(!html.includes('<b>x</b>'), html);
});
test('top-level lexer yields code tokens with lang info', () => {
  const tokens = markdown.lexMarkdown('Intro\n\n```ts src/a.ts\nconst a = 1;\n```\n');
  const code = tokens.find((t) => t.type === 'code');
  assert.ok(code);
  assert.equal(code.lang, 'ts src/a.ts');
  assert.equal(code.text, 'const a = 1;');
});
test('withCaret puts the caret inside the last block element', () => {
  assert.equal(markdown.withCaret('<p>hi</p>\n'), '<p>hi<span class="stream-caret" aria-hidden="true"></span></p>\n');
  assert.ok(markdown.withCaret('plain').endsWith('</span>'));
});
test('escapeHtml covers the five specials', () => {
  assert.equal(markdown.escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

// ---- fence meta ------------------------------------------------------------------
test('parseFenceInfo: language only', () => {
  assert.deepEqual(markdown.parseFenceInfo('ts'), { language: 'typescript', label: 'ts', path: undefined, range: undefined });
  assert.equal(markdown.parseFenceInfo(undefined).language, '');
  assert.equal(markdown.parseFenceInfo('nonsense-lang').language, '');
});
test('parseFenceInfo: "ts src/a.ts"', () => {
  const f = markdown.parseFenceInfo('ts src/a.ts');
  assert.equal(f.language, 'typescript');
  assert.equal(f.path, 'src/a.ts');
});
test('parseFenceInfo: "ts:src/a.ts"', () => {
  const f = markdown.parseFenceInfo('ts:src/a.ts');
  assert.equal(f.label, 'ts');
  assert.equal(f.path, 'src/a.ts');
});
test('parseFenceInfo: title="x.json"', () => {
  const f = markdown.parseFenceInfo('json title="config/x.json"');
  assert.equal(f.language, 'json');
  assert.equal(f.path, 'config/x.json');
});
test('parseFenceInfo: path + range', () => {
  const f = markdown.parseFenceInfo('ts src/a.ts (10-20)');
  assert.equal(f.path, 'src/a.ts');
  assert.deepEqual(f.range, { start: 10, end: 20 });
  assert.deepEqual(markdown.parseFenceInfo('py app.py L3-L9').range, { start: 3, end: 9 });
});
test('parseFenceInfo: bare path infers language', () => {
  const f = markdown.parseFenceInfo('src/app.py');
  assert.equal(f.path, 'src/app.py');
  assert.equal(f.label, 'py');
  assert.equal(f.language, 'python');
});
test('parseFenceInfo: shell aliases', () => {
  assert.equal(markdown.parseFenceInfo('sh').language, 'bash');
  assert.equal(markdown.parseFenceInfo('console').language, 'shell');
  assert.ok(util.isShellLanguage('zsh'));
  assert.ok(!util.isShellLanguage('ts'));
  assert.equal(util.stripShellPrompts('$ npm test\n> echo hi\nplain'), 'npm test\necho hi\nplain');
});
test('highlight escapes when the language is unknown', () => {
  assert.equal(markdown.highlight('<x>', ''), '&lt;x&gt;');
  assert.ok(markdown.highlight('const a = "<x>";', 'typescript').includes('&lt;x&gt;'));
});

// ---- mentions --------------------------------------------------------------------
test('findMentionTrigger detects @ at word start only', () => {
  assert.deepEqual(mentions.findMentionTrigger('fix @src/a', 10), { start: 4, query: 'src/a' });
  assert.equal(mentions.findMentionTrigger('mail me@x', 9), null);
  assert.deepEqual(mentions.findMentionTrigger('@', 1), { start: 0, query: '' });
  assert.equal(mentions.findMentionTrigger('@a b', 4), null);
});
test('findSlashTrigger only at the start of the message', () => {
  assert.deepEqual(mentions.findSlashTrigger('/rev', 4), { start: 0, query: 'rev' });
  assert.equal(mentions.findSlashTrigger('/review now', 9), null);
  assert.equal(mentions.findSlashTrigger('x /review', 9), null);
});
test('resultToAttachment maps kinds', () => {
  const file = mentions.resultToAttachment({ kind: 'file', label: 'a.ts', path: '/w/a.ts', relPath: 'a.ts' });
  assert.equal(file.kind, 'file');
  assert.equal(file.path, '/w/a.ts');
  const code = mentions.resultToAttachment({ kind: 'code', label: 'foo', detail: 'Function · a.ts:10', path: '/w/a.ts', relPath: 'a.ts', value: 'L10-L20' });
  assert.equal(code.kind, 'selection');
  assert.deepEqual(code.range, { startLine: 10, endLine: 10 });
  assert.equal(mentions.resultToAttachment({ kind: 'category', label: 'Files', value: 'file' }), undefined);
  const web = mentions.resultToAttachment({ kind: 'web', label: 'x', value: 'https://example.com/docs' });
  assert.equal(web.kind, 'url');
  assert.equal(web.url, 'https://example.com/docs');
  assert.equal(mentions.resultToAttachment({ kind: 'web', label: 'x', value: 'not a url' }), undefined);
});

// ---- util -------------------------------------------------------------------------
test('relPath strips the workspace folder and shortens $HOME', () => {
  assert.equal(util.relPath('/w/src/a.ts', '/w'), 'src/a.ts');
  assert.equal(util.relPath('/w', '/w/'), 'w');
  assert.equal(util.relPath('/home/u/x/y.ts'), '~/x/y.ts');
  assert.equal(util.relPath('/other/y.ts', '/w'), '/other/y.ts');
});
test('deepEqual compares plain JSON', () => {
  assert.ok(util.deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }));
  assert.ok(!util.deepEqual({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(!util.deepEqual([1, 2], [2, 1]));
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
