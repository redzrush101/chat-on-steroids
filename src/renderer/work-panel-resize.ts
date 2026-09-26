import { attachHorizontalResize } from './horizontal-resize.js';

const STORAGE_KEY = 'chat-on-steroids.work-panel-width';
const MIN_WIDTH = 280;
const MIN_MAIN_WIDTH = 360;

function hostWidth(host: HTMLElement): number {
  const measured = host.getBoundingClientRect().width || host.clientWidth || host.ownerDocument.defaultView?.innerWidth || 0;
  return Math.max(MIN_WIDTH + MIN_MAIN_WIDTH, measured);
}

function maximum(host: HTMLElement): number {
  return Math.max(MIN_WIDTH, hostWidth(host) - MIN_MAIN_WIDTH);
}

function currentWidth(host: HTMLElement, pane: HTMLElement): number {
  const explicit = Number.parseFloat(host.style.getPropertyValue('--work-panel-width'));
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const measured = pane.getBoundingClientRect().width;
  if (measured > 0) return measured;
  return Math.min(maximum(host), Math.max(MIN_WIDTH, hostWidth(host) * 0.42));
}

function setWidth(host: HTMLElement, width: number, persist = false): number {
  const next = Math.round(Math.max(MIN_WIDTH, Math.min(maximum(host), width)));
  host.style.setProperty('--work-panel-width', `${next}px`);
  // Files and Sub-agents are two projections of the same work slot. Keep both separators'
  // accessibility state synchronized even while one pane is hidden.
  for (const handle of host.querySelectorAll<HTMLElement>('.work-panel-resize')) {
    handle.setAttribute('aria-valuemin', String(MIN_WIDTH));
    handle.setAttribute('aria-valuemax', String(Math.round(maximum(host))));
    handle.setAttribute('aria-valuenow', String(next));
  }
  if (persist) {
    try { host.ownerDocument.defaultView?.localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* Layout persistence is optional. */ }
  }
  return next;
}

/**
 * Adds the shared horizontal resize affordance used by the right-side Files and Sub-agents panes.
 * The width belongs to the work slot, not to either pane, so switching tools preserves it.
 */
export function attachWorkPanelResize(host: HTMLElement, pane: HTMLElement): HTMLElement {
  const view = host.ownerDocument.defaultView;
  if (!host.style.getPropertyValue('--work-panel-width')) {
    try {
      const saved = Number(view?.localStorage.getItem(STORAGE_KEY));
      if (Number.isFinite(saved) && saved >= MIN_WIDTH) setWidth(host, saved);
    } catch { /* Corrupt/unavailable layout storage must not block the pane. */ }
  }

  const handle = document.createElement('div');
  handle.className = 'work-panel-resize';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize work panel');
  pane.prepend(handle);

  const paintAria = () => setWidth(host, currentWidth(host, pane));
  paintAria();

  attachHorizontalResize({
    host, handle, resizingClass: 'is-resizing-work-panel', direction: -1,
    width: () => currentWidth(host, pane), minimum: () => MIN_WIDTH, maximum: () => maximum(host),
    setWidth: (width, commit) => { setWidth(host, width, commit); },
    finish: () => { setWidth(host, currentWidth(host, pane), true); },
    reset: () => {
      host.style.removeProperty('--work-panel-width');
      try { view?.localStorage.removeItem(STORAGE_KEY); } catch { /* optional */ }
      paintAria();
    }
  });
  view?.addEventListener('resize', paintAria);
  return handle;
}
