import fs from 'node:fs/promises';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = (await fs.readFile('extension/active-tabs.js', 'utf8')).replace('export function', 'function');
const A = { id: 1, url: 'https://chatgpt.com/c/a' };
const B = { id: 2, url: 'https://chatgpt.com/c/b' };
function setup(stored: unknown[] = []) {
  const data: Record<string, unknown> = { cosActiveTabs: stored };
  const tabs = new Map([[1, A], [2, B]]), attached = new Set<number>();
  const chrome = {
    storage: { session: {
      get: vi.fn(async (key: string) => ({ [key]: data[key] })),
      set: vi.fn(async (value: object) => { Object.assign(data, structuredClone(value)); })
    } },
    tabs: { get: vi.fn(async (id: number) => tabs.get(id)) },
    debugger: {
      attach: vi.fn(async ({ tabId }: { tabId: number }) => {
        if (attached.has(tabId)) throw new Error('Already attached');
        attached.add(tabId);
      }),
      detach: vi.fn(async ({ tabId }: { tabId: number }) => { attached.delete(tabId); }),
      getTargets: vi.fn(async () => [...attached].map(tabId => ({ tabId, attached: true }))),
      sendCommand: vi.fn(async () => ({}))
    }
  };
  const make = () => vm.runInNewContext(`${source}; createActiveTabs(chrome)`, { chrome });
  return { chrome, data, tabs, attached, make, control: make() };
}

describe('active ChatGPT rendering leases', () => {
  it('protects only requested active pages, releases idle pages, and never changes browser focus', async () => {
    const { control, chrome, attached } = setup();
    await control.set('policy', [A]);
    expect([...attached]).toEqual([1]);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith({ tabId: 1 }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    await control.set('policy', [A]);
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
    await control.set('policy', []);
    expect([...attached]).toEqual([]);
    expect(control.owns(1)).toBe(false);
  });

  it('dispatches only the narrow trusted provider input while the exact tab lease is current', async () => {
    const { control, chrome } = setup();
    await control.set('provider-input:test', [A]);
    chrome.debugger.sendCommand.mockClear();
    await expect(control.input(1, { kind: 'click', x: 123.5, y: 45 })).resolves.toBe(true);
    expect(chrome.debugger.sendCommand.mock.calls.map((call: any[]) => call[1])).toEqual([
      'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent'
    ]);
    expect(chrome.debugger.sendCommand).toHaveBeenNthCalledWith(2, { tabId: 1 }, 'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: 123.5, y: 45, button: 'left', clickCount: 1 });

    chrome.debugger.sendCommand.mockClear();
    await expect(control.input(1, { kind: 'key', key: 'ArrowRight' })).resolves.toBe(true);
    expect(chrome.debugger.sendCommand.mock.calls.map((call: any[]) => call[1])).toEqual([
      'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent'
    ]);
    expect(chrome.debugger.sendCommand).toHaveBeenNthCalledWith(1, { tabId: 1 }, 'Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await expect(control.input(1, { kind: 'key', key: 'A' })).resolves.toBe(false);
    await control.set('provider-input:test', []);
    await expect(control.input(1, { kind: 'key', key: 'Enter' })).resolves.toBe(false);
  });

  it('keeps overlapping catalog/activity scopes until both owners release them', async () => {
    const { control, attached } = setup();
    await control.set('policy', [A]);
    await control.set('catalog:one', [A, B]);
    await control.set('catalog:one', []);
    expect([...attached]).toEqual([1]);
    await control.revoke();
    expect([...attached]).toEqual([]);
  });

  it('rejects personal sites and tabs with pending navigation', async () => {
    const { control, chrome } = setup();
    await control.set('policy', [{ id: 3, url: 'https://example.com/' }, { ...A, pendingUrl: B.url }]);
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
  });

  it('does not steal a foreign debugger or retry attachment on every maintenance pass', async () => {
    const { control, chrome, attached } = setup();
    attached.add(1);
    await control.set('policy', [A]);
    await control.set('policy', [A]);
    await control.revoke();
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    expect([...attached]).toEqual([1]);
  });

  it('revokes a pending attachment before it can enable emulation after A/B/A navigation', async () => {
    const { control, chrome } = setup();
    let finish!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    chrome.debugger.attach.mockImplementationOnce(async () => { entered(); await new Promise<void>(resolve => { finish = resolve; }); });
    const first = control.set('policy', [A]);
    await started;
    const departure = control.navigation(1);
    const next = control.set('policy', [A]);
    finish();
    await Promise.all([first, departure, next]);
    expect(chrome.debugger.detach).toHaveBeenCalledTimes(1);
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(2);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('cleans up restored debugger custody without treating it as current activity', async () => {
    const { control, attached, chrome } = setup([{ ...A, attached: true }]);
    attached.add(1);
    await control.set('policy', []);
    expect([...attached]).toEqual([]);
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
  });

  it('honors Chrome cancellation across reconstruction until the activity ends', async () => {
    const { control, attached, chrome, make } = setup();
    await control.set('policy', [A]);
    attached.delete(1);
    await control.detached({ tabId: 1 });
    const restored = make();
    await restored.set('policy', [A]);
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
    await restored.set('policy', []);
    await restored.set('policy', [A]);
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(2);
  });

  it('retains failed detach custody for the next existing maintenance pass', async () => {
    const { control, chrome, attached } = setup();
    await control.set('policy', [A]);
    chrome.debugger.detach.mockRejectedValueOnce(new Error('transient'));
    await expect(control.revoke()).rejects.toThrow('release remains pending');
    expect(control.owns(1)).toBe(true);
    await control.revoke();
    expect([...attached]).toEqual([]);
  });
});
