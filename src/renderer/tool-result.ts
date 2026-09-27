import { t } from './i18n.js';

export interface DiffLine {
  kind: 'meta' | 'add' | 'delete' | 'context';
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

/** Exact line diff for a small immutable edit review; larger edits stay in the virtualized review dock. */
export function historicalDiffLines(before: string, after: string): DiffLine[] | null {
  if (before.length + after.length > 128 * 1024) return null;
  const endings = (value: string) => new Set(value.match(/\r\n|\r|\n/g) ?? []);
  const oldEndings = endings(before), newEndings = endings(after);
  if (oldEndings.size > 1 || newEndings.size > 1) return null;
  if (before && after) {
    if ([...oldEndings][0] !== [...newEndings][0] ||
      /\r\n?$|\n$/.test(before) !== /\r\n?$|\n$/.test(after)) return null;
  }
  const split = (value: string) => value === '' ? [] : value.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  const oldLines = split(before), newLines = split(after);
  if (oldLines.length > 600 || newLines.length > 600) return null;
  const width = newLines.length + 1;
  const lengths = new Uint16Array((oldLines.length + 1) * width);
  for (let old = oldLines.length - 1; old >= 0; old--) {
    for (let next = newLines.length - 1; next >= 0; next--) {
      const index = old * width + next;
      lengths[index] = oldLines[old] === newLines[next]
        ? lengths[(old + 1) * width + next + 1]! + 1
        : Math.max(lengths[(old + 1) * width + next]!, lengths[index + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let old = 0, next = 0;
  while (old < oldLines.length || next < newLines.length) {
    if (old < oldLines.length && next < newLines.length && oldLines[old] === newLines[next]) {
      lines.push({ kind: 'context', text: ` ${oldLines[old]}`, oldLine: ++old, newLine: ++next });
    } else if (old < oldLines.length && (next === newLines.length || lengths[(old + 1) * width + next]! >= lengths[old * width + next + 1]!)) {
      lines.push({ kind: 'delete', text: `-${oldLines[old]}`, oldLine: ++old, newLine: null });
    } else {
      lines.push({ kind: 'add', text: `+${newLines[next]}`, oldLine: null, newLine: ++next });
    }
  }
  return lines;
}

/** Recognize only a complete unified diff header before giving recorded output diff styling. */
export function unifiedDiffLines(text: string): DiffLine[] | null {
  if (text.length > 128 * 1024) return null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1200) return null;
  const firstHunk = lines.findIndex(line => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line));
  const hasFileHeader = lines.some((line, index) => index < firstHunk && line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ '));
  if (!hasFileHeader || firstHunk < 0) return null;
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk && (Number(hunk[1]) > Number.MAX_SAFE_INTEGER - lines.length ||
      Number(hunk[2]) > Number.MAX_SAFE_INTEGER - lines.length)) return null;
  }
  let oldLine = 0, newLine = 0, inHunk = false;
  return lines.map((line, index) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (line.startsWith('diff --git ')) inHunk = false;
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; }
    const marker = line[0];
    const metadata = Boolean(hunk) || line.startsWith('diff --git ') || line.startsWith('\\ No newline') ||
      !inHunk || (line === '' && index === lines.length - 1);
    const kind: 'meta' | 'add' | 'delete' | 'context' = metadata ? 'meta'
      : marker === '+' ? 'add' : marker === '-' ? 'delete' : 'context';
    const oldNumber = !metadata && kind !== 'add' ? oldLine++ : null;
    const newNumber = !metadata && kind !== 'delete' ? newLine++ : null;
    return { kind, text: line, oldLine: oldNumber, newLine: newNumber };
  });
}

/** Presentation only. The stored result and overflow asset remain byte-for-byte intact. */
export function toolResultText(text: string, truncated: boolean, hasImages: boolean): string {
  try {
    const value = JSON.parse(text);
    if (value && Array.isArray(value.content)) {
      const readable = value.content.flatMap((block: any) => {
        if (block?.type === 'text' && typeof block.text === 'string') return [block.text];
        if (block?.type === 'resource' && typeof block.resource?.text === 'string') return [block.resource.text];
        return [];
      });
      if (readable.length) return readable.join('\n\n');
      if (value.structuredContent !== undefined) return JSON.stringify(value.structuredContent, null, 2);
      if (hasImages) return '';
    }
  } catch { /* An overflow prefix may end inside a binary field; never paint that payload. */ }
  if (hasImages && truncated) return t("Image result. Full response retained in the recording.");
  return text;
}
