import { expect, it } from 'vitest';
import { historicalDiffLines, toolResultText, unifiedDiffLines } from '../src/renderer/tool-result.js';

it('projects MCP text content without the protocol envelope', () => {
  expect(toolResultText(JSON.stringify({ content: [{ type: 'text', text: 'Scene: Cube' }], isError: false }), false, false)).toBe('Scene: Cube');
});
it('withholds binary content and truncated image envelopes without altering stored text', () => {
  const result = JSON.stringify({ content: [{ type: 'image', mimeType: 'image/png', data: 'a'.repeat(200) }] });
  expect(toolResultText(result, false, true)).toBe('');
  expect(toolResultText(result.slice(0, 90), true, true)).not.toContain('aaaa');
  expect(result).toContain('a'.repeat(200));
});
it('retains plain results and presents structured-only output', () => {
  expect(toolResultText('Command completed', false, false)).toBe('Command completed');
  expect(toolResultText('{"content":[],"structuredContent":{"count":3}}', false, false)).toBe('{\n  "count": 3\n}');
});
it('recognizes actual unified patches and leaves command text alone', () => {
  expect(unifiedDiffLines('--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new')).toEqual([
    { kind: 'meta', text: '--- a/file.ts', oldLine: null, newLine: null },
    { kind: 'meta', text: '+++ b/file.ts', oldLine: null, newLine: null },
    { kind: 'meta', text: '@@ -1 +1 @@', oldLine: null, newLine: null },
    { kind: 'delete', text: '-old', oldLine: 1, newLine: null },
    { kind: 'add', text: '+new', oldLine: null, newLine: 1 }
  ]);
  expect(unifiedDiffLines('--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new')).not.toBeNull();
  expect(unifiedDiffLines('I\'ll run git diff and there\'s no patch')).toBeNull();
  const markers = unifiedDiffLines('--- a/file\n+++ b/file\n@@ -4,2 +4,2 @@\n--- --flag\n+++ ++value\n context');
  expect(markers?.slice(3)).toEqual([
    { kind: 'delete', text: '--- --flag', oldLine: 4, newLine: null },
    { kind: 'add', text: '+++ ++value', oldLine: null, newLine: 4 },
    { kind: 'context', text: ' context', oldLine: 5, newLine: 5 }
  ]);
});

it('renders exact recorded before/after edits with both line gutters and bounds expensive diffs', () => {
  expect(historicalDiffLines('one\nold\nlast\n', 'one\nnew\nlast\n')).toEqual([
    { kind: 'context', text: ' one', oldLine: 1, newLine: 1 },
    { kind: 'delete', text: '-old', oldLine: 2, newLine: null },
    { kind: 'add', text: '+new', oldLine: null, newLine: 2 },
    { kind: 'context', text: ' last', oldLine: 3, newLine: 3 }
  ]);
  expect(historicalDiffLines('', 'first\nsecond\n')).toEqual([
    { kind: 'add', text: '+first', oldLine: null, newLine: 1 },
    { kind: 'add', text: '+second', oldLine: null, newLine: 2 }
  ]);
  expect(historicalDiffLines('one\r\n', 'one\n')).toBeNull();
  expect(historicalDiffLines('old\r\n', 'new\n')).toBeNull();
  expect(historicalDiffLines('old\n', 'new')).toBeNull();
  expect(historicalDiffLines('', 'one\r\ntwo\n')).toBeNull();
  expect(historicalDiffLines('line\n'.repeat(601), 'changed\n')).toBeNull();
  expect(unifiedDiffLines('--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n'.repeat(1200))).toBeNull();
});
