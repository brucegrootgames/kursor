/**
 * Build the markdown appended to Claude Code's system prompt:
 *
 *   # User rules
 *   # Project rules (always)
 *   # Project rules for the files in context   (auto rules whose globs match)
 *   # Other project rules                       (index: "Read `path` when relevant")
 *
 * Capped at MAX_APPENDIX_CHARS (60k): long bodies are truncated proportionally
 * before a final hard cut. vscode-free.
 */
import * as path from 'node:path';
import { anyGlobMatches, normalizePath } from './glob';
import type { LoadedRule } from './scan';

export const MAX_APPENDIX_CHARS = 60_000;
const MAX_USER_RULES_CHARS = 20_000;
const MIN_BODY_CHARS = 1_500;
const TRUNCATED_NOTE = '\n\n…(truncated by Kursor; open the file for the full rule)';

export interface AppendixInput {
  cwd: string;
  userRules: string;
  rules: LoadedRule[];
  contextPaths?: string[];
  cap?: number;
}

function toRel(cwd: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
  const r = path.relative(cwd, abs);
  if (!r || r.startsWith('..')) return normalizePath(p);
  return normalizePath(r);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - TRUNCATED_NOTE.length)) + TRUNCATED_NOTE;
}

function ruleHeading(rule: LoadedRule): string {
  return `## ${rule.name} (\`${rule.relPath}\`)`;
}

export function buildAppendixText(input: AppendixInput): string {
  const cap = input.cap ?? MAX_APPENDIX_CHARS;
  const contextRel = (input.contextPaths ?? []).map((p) => toRel(input.cwd, p));

  const always = input.rules.filter((r) => r.kind === 'always' || r.kind === 'legacy' || r.kind === 'agents-md');
  const auto = input.rules.filter((r) => r.kind === 'auto' && r.globs && anyGlobMatches(r.globs, contextRel));
  const indexed = input.rules.filter((r) => !always.includes(r) && !auto.includes(r));

  const userRules = input.userRules.trim();
  const sections: { title: string; intro?: string; bodies: { heading?: string; body: string }[] }[] = [];
  if (userRules) sections.push({ title: '# User rules', bodies: [{ body: truncate(userRules, MAX_USER_RULES_CHARS) }] });
  if (always.length) {
    sections.push({ title: '# Project rules (always)', bodies: always.map((r) => ({ heading: ruleHeading(r), body: r.body })) });
  }
  if (auto.length) {
    sections.push({
      title: '# Project rules for the files in context',
      intro: 'These rules apply because files currently in context match their globs.',
      bodies: auto.map((r) => ({ heading: `${ruleHeading(r)} — globs: ${(r.globs ?? []).join(', ')}`, body: r.body })),
    });
  }
  if (indexed.length) {
    const lines = indexed.map((r) => {
      if (r.kind === 'agent') return `- Read \`${r.relPath}\` when relevant: ${r.description}`;
      if (r.kind === 'auto') return `- Read \`${r.relPath}\` when working on files matching ${(r.globs ?? []).map((g) => `\`${g}\``).join(', ')}${r.description ? `: ${r.description}` : ''}`;
      return `- \`${r.relPath}\` (manual rule; the user can attach it with @${r.name})`;
    });
    sections.push({
      title: '# Other project rules',
      intro: 'Additional rule files exist in this project. Read them with the Read tool when they are relevant to the task.',
      bodies: [{ body: lines.join('\n') }],
    });
  }
  if (!sections.length) return '';

  const render = (): string =>
    sections
      .map((s) => [s.title, s.intro, ...s.bodies.map((b) => (b.heading ? `${b.heading}\n${b.body}` : b.body))].filter(Boolean).join('\n\n'))
      .join('\n\n');

  let text = render();
  if (text.length > cap) {
    // Shrink the largest bodies first: give every body an equal share of what is left after fixed text.
    const bodies = sections.flatMap((s) => s.bodies);
    const fixed = text.length - bodies.reduce((n, b) => n + b.body.length, 0);
    const budget = Math.max(0, cap - fixed);
    let share = Math.max(MIN_BODY_CHARS, Math.floor(budget / Math.max(1, bodies.length)));
    // Bodies shorter than the share leave room for the longer ones.
    for (let round = 0; round < 3; round++) {
      const small = bodies.filter((b) => b.body.length <= share).reduce((n, b) => n + b.body.length, 0);
      const bigCount = bodies.filter((b) => b.body.length > share).length;
      if (!bigCount) break;
      share = Math.max(MIN_BODY_CHARS, Math.floor((budget - small) / bigCount));
    }
    for (const b of bodies) b.body = truncate(b.body, share);
    text = render();
    if (text.length > cap) text = truncate(text, cap);
  }
  return text;
}
