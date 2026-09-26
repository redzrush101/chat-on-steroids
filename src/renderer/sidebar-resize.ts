import { attachHorizontalResize } from './horizontal-resize.js';

/** A renderer-only layout preference, independent of chat selection and app config. */
export function initSidebarResize(): void {
  const app = document.querySelector<HTMLElement>('.app')!;
  const sidebar = document.getElementById('sidebar')!;
  const handle = document.getElementById('sidebarResize')!;
  const toggle = document.getElementById('sidebarToggle')!;
  const menu = document.getElementById('viewMenu') as HTMLDetailsElement;
  const key = 'chat-on-steroids.sidebar-width';
  const minimum = 180;
  const maximum = () => Math.max(minimum, Math.min(480, window.innerWidth / 2));
  let preferred: number | null = null;
  let collapsed = false;
  try {
    const saved = Number(localStorage.getItem(key));
    if (Number.isFinite(saved) && saved >= minimum) preferred = Math.min(480, saved);
    collapsed = localStorage.getItem(`${key}.collapsed`) === 'true';
  } catch { /* Layout remains usable when storage is unavailable. */ }
  function render(): void {
    app.classList.toggle('is-sidebar-collapsed', collapsed);
    sidebar.inert = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    if (preferred === null) app.style.removeProperty('--sidebar-width');
    else app.style.setProperty('--sidebar-width', `${Math.min(maximum(), preferred)}px`);
    handle.setAttribute('aria-valuemin', String(minimum));
    handle.setAttribute('aria-valuemax', String(maximum()));
    handle.setAttribute('aria-valuenow', String(Math.round(sidebar.getBoundingClientRect().width)));
  }
  function save(): void {
    try {
      if (preferred === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(preferred));
    } catch { /* Keep the current width for this window. */ }
  }
  function setWidth(width: number): void {
    preferred = Math.round(Math.max(minimum, Math.min(maximum(), width)));
    render();
  }
  attachHorizontalResize({
    host: app, handle, resizingClass: 'is-resizing-sidebar', direction: 1,
    width: () => sidebar.getBoundingClientRect().width,
    minimum: () => minimum, maximum,
    setWidth: (width, commit) => { setWidth(width); if (commit) save(); }, finish: save,
    reset: () => { preferred = null; render(); save(); }
  });
  function toggleSidebar(): void {
    collapsed = !collapsed;
    if (collapsed && sidebar.contains(document.activeElement)) toggle.focus();
    render();
    try { localStorage.setItem(`${key}.collapsed`, String(collapsed)); } catch { /* Optional persistence. */ }
  }
  toggle.addEventListener('click', toggleSidebar);
  document.getElementById('sidebarMenuToggle')!.addEventListener('click', toggleSidebar);
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
      event.preventDefault();
      if (!event.repeat) toggleSidebar();
    }
    if (event.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary')?.focus(); }
  });
  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target as Node) || (event.target as Element).closest('button')) menu.open = false;
  });
  window.addEventListener('resize', render);
  render();
}
