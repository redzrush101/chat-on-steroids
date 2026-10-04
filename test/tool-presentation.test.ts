import { JSDOM } from 'jsdom';
import { afterAll, expect, it } from 'vitest';
import { executionRecap } from '../src/renderer/tool-presentation.js';
import { setLanguage } from '../src/renderer/i18n.js';

const dom = new JSDOM();
Object.assign(globalThis, { window: dom.window, document: dom.window.document });
afterAll(() => dom.window.close());
function call(kind: string, outcome = 'ok', files = 1): HTMLElement {
  const node = dom.window.document.createElement('div');
  Object.assign(node.dataset, { toolKind: kind, outcome, fileCount: String(files) });
  return node;
}

it('counts commands, exact read inputs, and recorded edits without parsing titles', () => {
  expect(executionRecap([call('run'), call('read', 'ok', 2), call('edit')]))
    .toBe('Executed 1 command · Read 2 files · 1 edit');
});

it('distinguishes refusals from executed commands and process polls from launches', () => {
  expect(executionRecap([call('run', 'tool_rejected'), call('run', 'process_exit_nonzero'), call('process')]))
    .toBe('Executed 1 command · 1 other action · 1 failed action');
});

it('translates the aggregate rather than relying on English recorded action labels', () => {
  setLanguage('de');
  try {
    expect(executionRecap([call('read', 'ok', 2), call('edit', 'tool_execution_error')]))
      .toBe('2 Dateien gelesen · 1 fehlgeschlagene Aktion');
  } finally { setLanguage('en'); }
});
