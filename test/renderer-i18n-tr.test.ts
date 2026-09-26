import { expect, it, vi } from 'vitest';
import tr from '../src/renderer/locales/tr.json';
import es from '../src/renderer/locales/es.json';
import ja from '../src/renderer/locales/ja.json';
import zhCN from '../src/renderer/locales/zh-CN.json';
import zhTW from '../src/renderer/locales/zh-TW.json';
import { expectCatalogIncludes, expectCatalogTranslations, setupLocaleDom } from './renderer-i18n-helpers.js';

const localeDom = setupLocaleDom('base', true);

it('covers the current catalogs and preserves every numbered argument', () => {
  expectCatalogIncludes(tr, [es, zhCN, zhTW, ja]);
  expectCatalogTranslations(tr);
});

it('restores Turkish and synchronizes both selectors without changing drafts, focus or authored content', async () => {
  window.localStorage.setItem('cos.ui.language', 'tr');
  const { initLanguage, setLanguage, t } = await import('../src/renderer/i18n.js');
  initLanguage();
  const select = document.getElementById('uiLanguage') as HTMLSelectElement;
  const flag = document.querySelector<HTMLButtonElement>('[data-language="tr"]')!;
  expect(document.documentElement.lang).toBe('tr');
  expect(document.querySelector('.setup-heading h1')?.textContent).toBe('Kurulum');
  expect(select.selectedOptions[0]?.textContent).toBe('Türkçe');
  expect(flag.getAttribute('aria-pressed')).toBe('true');
  const input = document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = '/review\nİşlenmemiş taslak $& <img src=x> 🙂';
  input.focus(); input.setSelectionRange(2, 9);
  const authored = document.createElement('p'); authored.textContent = 'Settings'; document.body.append(authored);
  for (const locale of ['en', 'ja', 'es', 'zh-TW', 'zh-CN', 'fr', 'tr'] as const) {
    setLanguage(locale);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 9]);
    expect(input.value).toBe('/review\nİşlenmemiş taslak $& <img src=x> 🙂');
    expect(authored.textContent).toBe('Settings');
    expect(select.value).toBe(locale);
  }
  expect(t('Remove {0}', ['$& /資料/Save <img src=x>'])).toBe('Kaldır: $& /資料/Save <img src=x>');
  select.value = 'en'; select.dispatchEvent(new localeDom.dom.window.Event('change'));
  flag.click();
  expect(window.localStorage.getItem('cos.ui.language')).toBe('tr');
  vi.resetModules(); expect((await import('../src/renderer/i18n.js')).currentLanguage()).toBe('tr');
});

it('matches both Turkish I pairs when filtering complete settings sections', async () => {
  window.localStorage.setItem('cos.ui.language', 'tr');
  const { filterSettingsSections } = await import('../src/renderer/dom.js');
  const view = document.createElement('section');
  view.innerHTML = '<h2 class="settings-section-title">İzinler</h2><div class="pane">IŞIK</div><p id="settingsSearchEmpty"></p>';
  for (const query of ['izinler', 'İZİNLER', 'ışık', 'IŞIK']) {
    filterSettingsSections(view, query);
    expect(view.querySelector<HTMLElement>('.pane')!.hidden).toBe(false);
    expect(view.querySelector<HTMLElement>('h2')!.hidden).toBe(false);
  }
  filterSettingsSections(view, 'missing');
  expect(view.querySelector<HTMLElement>('.pane')!.hidden).toBe(true);
  expect(view.querySelector<HTMLElement>('#settingsSearchEmpty')!.hidden).toBe(false);
});

it('translates known failures while retaining unknown provider errors and literal duration arguments', async () => {
  window.localStorage.setItem('cos.ui.language', 'tr');
  const { run } = await import('../src/renderer/dom.js');
  const { t } = await import('../src/renderer/i18n.js');
  expect(await run(Promise.resolve({ ok: false, error: 'Secure credential storage is unavailable.' }))).toBeNull();
  expect(document.querySelector('.toast')?.textContent).toBe(tr['Secure credential storage is unavailable.']);
  const error = 'PROVIDER: /Save/<img src=x> {0}\n  details';
  expect(await run(Promise.resolve({ ok: false, error }))).toBeNull();
  expect(document.querySelector('.toast')?.textContent).toBe(error);
  expect(document.querySelector('.toast img')).toBeNull();
  expect(t('{0} for {1}{2}s', [t('Worked'), `${t('{0}m', [1])} `, 5])).toBe('1 dk 5 sn · Çalıştı');
});
