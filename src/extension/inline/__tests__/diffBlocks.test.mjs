// Unit tests for the pure inline-edit logic. Run: node src/extension/inline/__tests__/diffBlocks.test.mjs
// Bundles diffBlocks.ts / postprocess.ts / prompts.ts with esbuild into a temp dir, then asserts.
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const out = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'kursor-inline-test-'));

async function load(name) {
  const outfile = join(out, `${name}.mjs`);
  await build({ entryPoints: [join(here, '..', `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile, absWorkingDir: root, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

const db = await load('diffBlocks');
const pp = await load('postprocess');
const pr = await load('prompts');

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
};

// ---------- diffBlocks ----------
test('identical text → no blocks', () => {
  const plan = db.computeVerticalDiff(['a', 'b'], ['a', 'b']);
  assert.deepEqual(plan.blocks, []);
  assert.deepEqual(plan.lines, ['a', 'b']);
});

test('replacement block: red placeholders above green lines', () => {
  const plan = db.computeVerticalDiff(['a', 'b', 'c'], ['a', 'B', 'c']);
  assert.deepEqual(plan.lines, ['a', '', 'B', 'c']);
  assert.deepEqual(plan.blocks, [{ start: 1, numRed: 1, numGreen: 1, oldLines: ['b'] }]);
});

test('pure insertion and pure deletion', () => {
  const ins = db.computeVerticalDiff(['a', 'c'], ['a', 'b', 'c']);
  assert.deepEqual(ins.blocks, [{ start: 1, numRed: 0, numGreen: 1, oldLines: [] }]);
  const del = db.computeVerticalDiff(['a', 'b', 'c'], ['a', 'c']);
  assert.deepEqual(del.lines, ['a', '', 'c']);
  assert.deepEqual(del.blocks, [{ start: 1, numRed: 1, numGreen: 0, oldLines: ['b'] }]);
});

test('empty inputs', () => {
  assert.deepEqual(db.computeVerticalDiff([], []).blocks, []);
  assert.deepEqual(db.computeVerticalDiff([], ['x']).blocks, [{ start: 0, numRed: 0, numGreen: 1, oldLines: [] }]);
  assert.deepEqual(db.computeVerticalDiff(['x'], []).blocks, [{ start: 0, numRed: 1, numGreen: 0, oldLines: ['x'] }]);
});

test('multiple blocks with absolute offsets and accept/reject invariants', () => {
  const oldL = ['h', 'a', 'b', 'c', 'd', 'e', 'f', 't'];
  const newL = ['h', 'A', 'b', 'c', 'x', 'y', 'e', 't'];
  const plan = db.computeVerticalDiff(oldL, newL);
  // a→A, d→x y (e is common), f removed
  assert.equal(plan.blocks.length, 3);
  assert.deepEqual(plan.blocks.map((b) => [b.start, b.numRed, b.numGreen]), [[1, 1, 1], [5, 1, 2], [9, 1, 0]]);
  assert.deepEqual(db.acceptAllLines(plan.lines, plan.blocks), newL);
  assert.deepEqual(db.rejectAllLines(plan.lines, plan.blocks), oldL);
  // accept a→A, reject d→x y, accept the removal of f (indices re-based after each op)
  let s = db.applyBlockDecision(plan.lines, plan.blocks, 0, true);
  assert.deepEqual(s.blocks.map((b) => b.start), [4, 8]);
  s = db.applyBlockDecision(s.lines, s.blocks, 0, false);
  assert.deepEqual(s.blocks.map((b) => b.start), [6]);
  s = db.applyBlockDecision(s.lines, s.blocks, 0, true);
  assert.deepEqual(s.lines, ['h', 'A', 'b', 'c', 'd', 'e', 't']);
  assert.deepEqual(s.blocks, []);
});

test('blocks are consistent for random line arrays (fuzz)', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const alphabet = ['a', 'b', 'c', 'd', '', '  e', '\tf'];
  for (let iter = 0; iter < 300; iter++) {
    const oldL = Array.from({ length: Math.floor(rnd() * 12) }, () => alphabet[Math.floor(rnd() * alphabet.length)]);
    const newL = Array.from({ length: Math.floor(rnd() * 12) }, () => alphabet[Math.floor(rnd() * alphabet.length)]);
    const plan = db.computeVerticalDiff(oldL, newL);
    assert.deepEqual(db.acceptAllLines(plan.lines, plan.blocks), newL, `accept ${JSON.stringify([oldL, newL])}`);
    assert.deepEqual(db.rejectAllLines(plan.lines, plan.blocks), oldL, `reject ${JSON.stringify([oldL, newL])}`);
    for (const b of plan.blocks) {
      assert.equal(b.oldLines.length, b.numRed);
      for (let i = 0; i < b.numRed; i++) assert.equal(plan.lines[b.start + i], '');
    }
    // random per-block decisions end at the right text
    let s = { lines: plan.lines, blocks: plan.blocks };
    const decisions = [];
    while (s.blocks.length) {
      const idx = Math.floor(rnd() * s.blocks.length);
      const accept = rnd() < 0.5;
      decisions.push([s.blocks[idx], accept]);
      s = db.applyBlockDecision(s.lines, s.blocks, idx, accept);
    }
    // every decision sequence must end with text made only of old/new lines
    for (const l of s.lines) assert.ok(oldL.includes(l) || newL.includes(l), 'stray line after decisions ' + JSON.stringify(decisions));
  }
});

test('removeBlock shifts later blocks by removed line count', () => {
  const blocks = [
    { start: 2, numRed: 2, numGreen: 3, oldLines: ['x', 'y'] },
    { start: 10, numRed: 1, numGreen: 0, oldLines: ['z'] },
  ];
  assert.deepEqual(db.removeBlock(blocks, 0, true)[0].start, 8);
  assert.deepEqual(db.removeBlock(blocks, 0, false)[0].start, 7);
  assert.deepEqual(db.removeBlock(blocks, 1, true).length, 1);
});

test('shiftBlocksForEdit: above shifts, inside green grows, below ignored', () => {
  const blocks = [{ start: 5, numRed: 1, numGreen: 2, oldLines: ['o'] }];
  assert.equal(db.shiftBlocksForEdit(blocks, 0, 3)[0].start, 8);
  assert.equal(db.shiftBlocksForEdit(blocks, 6, 1)[0].numGreen, 3);
  assert.equal(db.shiftBlocksForEdit(blocks, 7, -5)[0].numGreen, 0);
  assert.deepEqual(db.shiftBlocksForEdit(blocks, 20, 4)[0], blocks[0]);
  assert.deepEqual(db.shiftBlocksForEdit(blocks, 0, 0)[0], blocks[0]);
});

test('lineDeltaOfChange / findBlockNearLine / splitLines', () => {
  assert.equal(db.lineDeltaOfChange(3, 3, 'a\nb\n'), 2);
  assert.equal(db.lineDeltaOfChange(3, 5, ''), -2);
  assert.equal(db.lineDeltaOfChange(3, 4, 'x\r\ny'), 0);
  const blocks = [{ start: 2, numRed: 1, numGreen: 1, oldLines: ['a'] }, { start: 9, numRed: 0, numGreen: 2, oldLines: [] }];
  assert.equal(db.findBlockNearLine(blocks, 3), 0);
  assert.equal(db.findBlockNearLine(blocks, 5), 1);
  assert.equal(db.findBlockNearLine(blocks, 50), 1);
  assert.equal(db.findBlockNearLine([], 1), -1);
  assert.deepEqual(db.splitLines('a\r\nb\n'), ['a', 'b', '']);
});

// ---------- postprocess ----------
const opts = { originalLines: ['    foo();', '    bar();'], insertSpaces: true, tabSize: 4 };

test('fences are stripped (with and without prose)', () => {
  assert.deepEqual(pp.cleanModelOutput('```ts\n    foo();\n    baz();\n```', opts), ['    foo();', '    baz();']);
  assert.deepEqual(pp.cleanModelOutput('Here is the code:\n\n```\n    foo();\n```\nDone.', opts), ['    foo();']);
  assert.deepEqual(pp.cleanModelOutput('    x = 1\n', opts), ['    x = 1']);
});

test('echoed wrapper tags are stripped', () => {
  assert.deepEqual(pp.cleanModelOutput('<region>\n    foo();\n</region>', opts), ['    foo();']);
});

test('lost indentation is restored; tabs/spaces normalized', () => {
  assert.deepEqual(pp.cleanModelOutput('foo();\nif (x) {\n  y();\n}', opts), ['    foo();', '    if (x) {', '      y();', '    }']);
  assert.deepEqual(pp.cleanModelOutput('\tfoo();', opts), ['    foo();']);
  assert.deepEqual(pp.cleanModelOutput('    foo();\n        bar();', { originalLines: ['\tfoo();'], insertSpaces: false, tabSize: 4 }), ['\tfoo();', '\t\tbar();']);
});

test('trailing blank lines of the original region are kept; insert mode has none', () => {
  assert.deepEqual(pp.cleanModelOutput('a\n', { originalLines: ['x', ''], insertSpaces: true, tabSize: 2 }), ['a', '']);
  assert.deepEqual(pp.cleanModelOutput('a\n\n\n', { originalLines: [''], insertSpaces: true, tabSize: 2, insertMode: true }), ['a']);
  assert.deepEqual(pp.cleanModelOutput('   \n\n', opts), []);
});

test('fragment heuristic', () => {
  const file = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  assert.equal(pp.looksLikeFragment(['line 0', '// ... existing code ...', 'line 39'], file), true);
  assert.equal(pp.looksLikeFragment(['function a() {}', 'function b() {}'], file), true);
  assert.equal(pp.looksLikeFragment(file.map((l) => l + '!'), file), false);
  assert.equal(pp.looksLikeFragment(['line 0', 'line 39'], file), false, 'same edges → full rewrite');
  const big = file.map((l) => l + '!');
  assert.equal(pp.looksLikeFragment([...big.slice(0, 10), '  ...rest,', ...big.slice(11)], file), false, 'JS spread is not a placeholder');
  assert.equal(pp.looksLikeFragment([...big.slice(0, 10), '  # ...', ...big.slice(11)], file), true);
  assert.equal(pp.looksLikeFragment([...big.slice(0, 10), '...', ...big.slice(11)], file), true);
  assert.equal(pp.looksLikeFragment([...big.slice(0, 10), '... rest of the file unchanged', ...big.slice(11)], file), true);
});

// ---------- prompts ----------
test('edit prompt contains region, context and instruction', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `l${i}`);
  const p = pr.buildEditPrompt({ displayPath: 'src/a.ts', languageId: 'typescript', documentLines: lines, startLine: 100, endLine: 101, instruction: 'do x', insertMode: false, wholeFile: false, rulesAppendix: '# rules' });
  assert.ok(p.systemPrompt.includes('ONLY the code'));
  assert.ok(p.systemPrompt.includes('# rules'));
  assert.ok(p.prompt.includes('<region lines="101-102">\nl100\nl101\n</region>'));
  assert.ok(p.prompt.includes('  41| l40'), 'before-context starts 60 lines up (1-based numbering)');
  assert.ok(!p.prompt.includes('| l39'), 'context is capped at 60 lines');
  assert.ok(p.prompt.includes('l161'));
  assert.ok(!p.prompt.includes('l162'));
  assert.ok(p.prompt.includes('<instruction>\ndo x\n</instruction>'));
  const w = pr.buildEditPrompt({ displayPath: 'a', languageId: 'x', documentLines: ['1', '2'], startLine: 0, endLine: 1, instruction: 'y', insertMode: false, wholeFile: true });
  assert.ok(!w.prompt.includes('<before lines='));
  assert.ok(w.prompt.includes('complete new file'));
});

// ---------- CRLF (Windows documents) ----------
test('splitLines normalises CRLF and lone CR so blocks never contain \\r', () => {
  assert.deepEqual(db.splitLines('a\r\nb\r\n'), ['a', 'b', '']);
  assert.deepEqual(db.splitLines('a\rb'), ['a', 'b']);
  const plan = db.computeVerticalDiff(db.splitLines('a\r\nb\r\nc'), db.splitLines('a\r\nB\r\nc'));
  assert.deepEqual(plan.blocks, [{ start: 1, numRed: 1, numGreen: 1, oldLines: ['b'] }]);
  assert.ok(plan.lines.every((l) => !l.includes('\r')));
});

test('lineDeltaOfChange counts CRLF insertions as whole lines', () => {
  assert.equal(db.lineDeltaOfChange(3, 3, 'x\r\ny\r\n'), 2);
  assert.equal(db.lineDeltaOfChange(3, 5, ''), -2);
});

test('cleanModelOutput accepts CRLF model output and CRLF originals', () => {
  const out = pp.cleanModelOutput('```ts\r\n  const a = 1;\r\n  const b = 2;\r\n```\r\n', { originalLines: ['  const a = 0;'], insertSpaces: true, tabSize: 2 });
  assert.deepEqual(out, ['  const a = 1;', '  const b = 2;']);
  assert.ok(out.every((l) => !l.includes('\r')));
});

rmSync(out, { recursive: true, force: true });
if (process.exitCode) {
  console.log(`${passed} passed, some FAILED`);
} else {
  console.log(`inline tests: ${passed} passed`);
}
