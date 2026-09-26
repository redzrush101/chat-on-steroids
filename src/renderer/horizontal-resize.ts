interface HorizontalResizeOptions {
  host: HTMLElement;
  handle: HTMLElement;
  resizingClass: string;
  direction: 1 | -1;
  width(): number;
  minimum(): number;
  maximum(): number;
  setWidth(width: number, commit: boolean): void;
  finish(): void;
  reset(): void;
}

/** Pointer and keyboard handling shared by the two horizontal separators. */
export function attachHorizontalResize(options: HorizontalResizeOptions): void {
  const { host, handle, resizingClass, direction } = options;
  let drag: { id: number; x: number; width: number } | null = null;
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    handle.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, width: options.width() };
    host.classList.add(resizingClass);
    event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (drag?.id === event.pointerId) options.setWidth(drag.width + direction * (event.clientX - drag.x), false);
  });
  const finish = (event: PointerEvent): void => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    host.classList.remove(resizingClass);
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    options.finish();
  };
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('lostpointercapture', finish);
  handle.addEventListener('dblclick', options.reset);
  handle.addEventListener('keydown', event => {
    const width = options.width();
    if (event.key === 'ArrowLeft') options.setWidth(width - direction * 10, true);
    else if (event.key === 'ArrowRight') options.setWidth(width + direction * 10, true);
    else if (event.key === 'Home') options.setWidth(options.minimum(), true);
    else if (event.key === 'End') options.setWidth(options.maximum(), true);
    else return;
    event.preventDefault();
  });
}
