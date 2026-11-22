// jsdom has no PointerEvent, so `fireEvent.pointerDown(el, { pointerType, … })`
// falls back to a bare Event and drops every pointer field. Importing this
// installs a minimal MouseEvent-based one — enough for the drag-to-reorder
// tests to drive coordinates, the button and the pointer type. jsdom also lays
// nothing out, so `slotRect` stands in for each row's measured rect.
class PointerEventPolyfill extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
    this.pointerType = init.pointerType ?? "";
  }
}

if (typeof window.PointerEvent === "undefined") {
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
}

/** A 40px-tall row slot `i` from the top, for faking a list's layout in jsdom. */
export function slotRect(i: number): DOMRect {
  const top = i * 40;
  return { top, bottom: top + 40, height: 40, left: 0, right: 200, width: 200 } as DOMRect;
}
