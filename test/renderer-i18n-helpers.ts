import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, expect, vi } from 'vitest';

type RendererGlobals = 'base' | 'elements';

/** Installs the isolated renderer document used by each locale suite. */
export function setupLocaleDom(globals: RendererGlobals = 'base', restoreMocks = false) {
  let dom: JSDOM;

  beforeEach(() => {
    vi.resetModules();
    dom = new JSDOM(readFileSync('src/renderer/index.html', 'utf8'), { url: 'https://local.test/' });
    const exposed: Record<string, unknown> = {
      window: dom.window,
      document: dom.window.document,
      Node: dom.window.Node,
    };
    if (globals === 'elements') {
      Object.assign(exposed, { Element: dom.window.Element, HTMLElement: dom.window.HTMLElement });
    }
    Object.assign(globalThis, exposed);
  });

  afterEach(() => {
    if (restoreMocks) vi.restoreAllMocks();
    dom.window.close();
  });

  return { get dom() { return dom; } };
}

export function expectCatalogIncludes(catalog: Record<string, string>, sourceCatalogs: Record<string, string>[]) {
  const sources = new Set(sourceCatalogs.flatMap(source => Object.keys(source)));
  expect([...sources].filter(source => !Object.hasOwn(catalog, source))).toEqual([]);
}

export function expectCatalogTranslations(catalog: Record<string, string>) {
  const placeholders = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort();
  for (const [source, translation] of Object.entries(catalog)) {
    expect(translation.trim(), source).not.toBe('');
    expect(placeholders(translation), source).toEqual(placeholders(source));
  }
}
