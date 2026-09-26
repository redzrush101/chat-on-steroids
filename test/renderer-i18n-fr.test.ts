import { expect, it, vi } from 'vitest';
import es from '../src/renderer/locales/es.json';
import fr from '../src/renderer/locales/fr.json';
import ja from '../src/renderer/locales/ja.json';
import tr from '../src/renderer/locales/tr.json';
import zhCN from '../src/renderer/locales/zh-CN.json';
import zhTW from '../src/renderer/locales/zh-TW.json';
import { expectCatalogIncludes, expectCatalogTranslations, setupLocaleDom } from './renderer-i18n-helpers.js';

const localeDom = setupLocaleDom('base', true);

it('covers the current catalogs including Turkish and preserves numbered arguments', () => {
  expectCatalogIncludes(fr, [es, zhCN, zhTW, ja, tr]);
  expectCatalogTranslations(fr);
});

it('restores French through both selectors and keeps drafts, focus and authored text across languages', async () => {
  window.localStorage.setItem('cos.ui.language', 'fr');
  const { initLanguage, setLanguage, t, ui } = await import('../src/renderer/i18n.js');
  initLanguage();
  const select = document.getElementById('uiLanguage') as HTMLSelectElement;
  const flag = document.querySelector<HTMLButtonElement>('[data-language="fr"]')!;
  expect(document.documentElement.lang).toBe('fr');
  expect(select.selectedOptions[0]?.textContent).toBe('Français');
  expect(flag.getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('.setup-heading h1')?.textContent).toBe('Connexion');
  const input = document.getElementById('chatInput') as HTMLTextAreaElement;
  input.value = '/review\nMon brouillon $& <img src=x> 🙂';
  input.focus(); input.setSelectionRange(2, 9);
  const authored = document.createElement('p'); authored.textContent = 'Settings'; document.body.append(authored);
  const action = ui(document.createElement('button'), 'textContent', () => t('Remove {0}', ['<img src=x>']));
  document.body.append(action);
  for (const locale of ['en', 'ja', 'es', 'zh-TW', 'zh-CN', 'tr', 'fr'] as const) {
    setLanguage(locale);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 9]);
    expect(input.value).toBe('/review\nMon brouillon $& <img src=x> 🙂');
    expect(authored.textContent).toBe('Settings');
    expect(select.value).toBe(locale);
    expect(action.querySelector('img')).toBeNull();
  }
  expect(action.textContent).toBe('Retirer <img src=x>');
  expect(t('{0}m', [2])).toBe('2 min');
  select.value = 'en'; select.dispatchEvent(new localeDom.dom.window.Event('change'));
  flag.click();
  expect(select.value).toBe('fr');
  expect(window.localStorage.getItem('cos.ui.language')).toBe('fr');
  vi.resetModules(); expect((await import('../src/renderer/i18n.js')).currentLanguage()).toBe('fr');
});

it('leaves the default unchanged and can switch to French when preference storage fails', async () => {
  vi.spyOn(localeDom.dom.window.Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable'); });
  vi.spyOn(localeDom.dom.window.Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
  const { initLanguage, setLanguage, currentLanguage, t } = await import('../src/renderer/i18n.js');
  expect(currentLanguage()).toBe('en');
  initLanguage(); setLanguage('fr');
  expect(currentLanguage()).toBe('fr');
  expect(t('Settings')).toBe('Paramètres');
  expect(t('unknown /Save/<img src=x>')).toBe('unknown /Save/<img src=x>');
});
