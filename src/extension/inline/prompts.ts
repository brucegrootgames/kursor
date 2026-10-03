/**
 * Prompt construction for Ctrl+K (pure; no vscode imports).
 * The system prompt is strict: the model must answer with the replacement code only.
 */

export const CONTEXT_LINES = 60;
export const RULES_APPENDIX_MAX = 8_000;

export interface EditPromptInput {
  /** Workspace-relative (or absolute) path for display. */
  displayPath: string;
  languageId: string;
  /** All document lines. */
  documentLines: readonly string[];
  /** 0-based inclusive line range of the region to replace. */
  startLine: number;
  endLine: number;
  instruction: string;
  /** true when the region is a blank line and the user wants new code inserted there. */
  insertMode: boolean;
  wholeFile: boolean;
  /** Previous attempt for follow-up instructions. */
  previous?: { instruction: string; output: string };
  /** Rules appendix from RulesService.buildAppendix (may be empty). */
  rulesAppendix?: string;
}

export interface BuiltPrompt {
  systemPrompt: string;
  prompt: string;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated)`;
}

export function buildEditSystemPrompt(rulesAppendix?: string): string {
  const parts = [
    `You are the inline code editor of the Kursor IDE. You rewrite exactly one region of a source file according to the user's instruction.`,
    ``,
    `Output rules (strict):`,
    `1. Reply with ONLY the code that replaces the <region>…</region> block. No explanations, no markdown fences, no "Here is", no file path, no tags.`,
    `2. The replacement is spliced in place of the region. Do NOT repeat the code from <before> or <after>; do not add code that belongs outside the region.`,
    `3. Match the file's style exactly: indentation characters (tabs or spaces), the region's base indentation, naming, quotes, semicolons, line width.`,
    `4. Keep everything in the region that the instruction does not ask to change. Do not add explanatory comments unless asked.`,
    `5. If the instruction is a question or nothing should change, output the region unchanged.`,
    `6. When <region> is a blank line (insert mode), output the new code to insert at that position.`,
  ];
  const rules = (rulesAppendix ?? '').trim();
  if (rules) {
    parts.push('', '# Project and user rules (apply when relevant)', truncate(rules, RULES_APPENDIX_MAX));
  }
  return parts.join('\n');
}

function numbered(lines: readonly string[], firstLineNumber: number): string {
  return lines.map((l, i) => `${String(firstLineNumber + i).padStart(4, ' ')}| ${l}`).join('\n');
}

export function buildEditPrompt(input: EditPromptInput): BuiltPrompt {
  const { documentLines, startLine, endLine } = input;
  const beforeStart = Math.max(0, startLine - CONTEXT_LINES);
  const afterEnd = Math.min(documentLines.length - 1, endLine + CONTEXT_LINES);
  const before = input.wholeFile ? [] : documentLines.slice(beforeStart, startLine);
  const region = documentLines.slice(startLine, endLine + 1);
  const after = input.wholeFile ? [] : documentLines.slice(endLine + 1, afterEnd + 1);

  const sections: string[] = [];
  sections.push(`<file path="${input.displayPath}" language="${input.languageId}">`);
  if (before.length > 0) {
    sections.push(`<before lines="${beforeStart + 1}-${startLine}">`, numbered(before, beforeStart + 1), `</before>`);
  }
  sections.push(
    `<region lines="${startLine + 1}-${endLine + 1}"${input.insertMode ? ' mode="insert"' : ''}>`,
    region.join('\n'),
    `</region>`,
  );
  if (after.length > 0) {
    sections.push(`<after lines="${endLine + 2}-${afterEnd + 1}">`, numbered(after, endLine + 2), `</after>`);
  }
  sections.push(`</file>`);
  sections.push('');
  sections.push(
    `Line numbers in <before>/<after> are for orientation only; the <region> is shown verbatim (without numbers) and your output must be verbatim code too.`,
  );
  if (input.previous) {
    sections.push(
      '',
      `<previous_attempt instruction=${JSON.stringify(input.previous.instruction)}>`,
      input.previous.output,
      `</previous_attempt>`,
      `The user is refining the previous attempt. Produce a new replacement for the ORIGINAL region that also satisfies the follow-up instruction.`,
    );
  }
  sections.push('', `<instruction>`, input.instruction.trim(), `</instruction>`);
  sections.push(
    '',
    input.wholeFile
      ? `Output the complete new file contents (the region is the whole file).`
      : input.insertMode
        ? `Output only the code to insert at the region (line ${startLine + 1}).`
        : `Output only the replacement for lines ${startLine + 1}-${endLine + 1}.`,
  );
  return { systemPrompt: buildEditSystemPrompt(input.rulesAppendix), prompt: sections.join('\n') };
}

export interface MergePromptInput {
  displayPath: string;
  languageId: string;
  fileText: string;
  snippet: string;
}

/** "Fast apply": merge a partial snippet from the chat into the full file. */
export function buildMergePrompt(input: MergePromptInput): BuiltPrompt {
  const systemPrompt = [
    `You are a code merge engine inside the Kursor IDE. You receive the current contents of a file and a code snippet produced by an assistant that should be applied to the file.`,
    `The snippet may be partial and may use placeholders such as "// ... existing code ..." to stand for unchanged code.`,
    `Output the COMPLETE updated file with the snippet integrated: replace the parts the snippet rewrites, keep everything else byte-for-byte, expand every placeholder with the original code.`,
    `Reply with ONLY the file contents — no markdown fences, no commentary, no tags.`,
  ].join('\n');
  const prompt = [
    `<file path="${input.displayPath}" language="${input.languageId}">`,
    input.fileText,
    `</file>`,
    '',
    `<snippet>`,
    input.snippet,
    `</snippet>`,
    '',
    `Output the complete updated file.`,
  ].join('\n');
  return { systemPrompt, prompt };
}
