import { describe, it, expect, vi } from "vitest";
import { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { slotRect } from "../test/pointerEvent";
import { DRAG_THRESHOLD_PX, placeInOrder, useDragReorder, type DropTarget } from "./useDragReorder";

describe("placeInOrder", () => {
  it("moves an id before another, to the end, or to the top", () => {
    expect(placeInOrder(["a", "b", "c"], "c", { beforeId: "a" })).toEqual(["c", "a", "b"]);
    expect(placeInOrder(["a", "b", "c"], "a", { beforeId: null })).toEqual(["b", "c", "a"]);
    expect(placeInOrder(["a", "b", "c"], "b", { beforeId: null, atStart: true })).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("inserts an id the order did not hold (a move from another group)", () => {
    expect(placeInOrder(["a", "b"], "x", { beforeId: "b" })).toEqual(["a", "x", "b"]);
  });

  it("falls back to the end when the anchor is not in the order", () => {
    expect(placeInOrder(["a", "b"], "a", { beforeId: "gone" })).toEqual(["b", "a"]);
  });
});

/** Give each tagged row and heading a 40px slot, in document order. */
function layout() {
  const els = document.querySelectorAll<HTMLElement>("[data-reorder-id],[data-reorder-heading]");
  els.forEach((el, i) => {
    el.getBoundingClientRect = () => slotRect(i);
  });
}

function Harness({
  onDrop,
  enabled = true,
  crossGroup = false,
  onClick = () => {},
}: {
  onDrop: (id: string, from: string, t: DropTarget) => void;
  enabled?: boolean;
  crossGroup?: boolean;
  onClick?: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { rowProps, markerFor, drag } = useDragReorder({
    enabled,
    containerRef: ref,
    crossGroup,
    onDrop,
  });
  const row = (id: string, group: string) => (
    <div key={id} {...rowProps(id, group)} onClick={() => onClick(id)}>
      {id}
      {markerFor(id) && <i data-testid={`marker-${id}`}>{markerFor(id)}</i>}
    </div>
  );
  return (
    <div ref={ref}>
      <span data-testid="dragging">{drag?.id ?? ""}</span>
      {row("a", "g")}
      {row("b", "g")}
      {row("c", "g")}
      <div data-reorder-heading="h">H</div>
      {row("x", "h")}
    </div>
  );
}

const mouse = { pointerType: "mouse", button: 0, pointerId: 1 };

/** Press on `id`, move to `y`, release there. */
function dragTo(id: string, y: number, init: object = mouse) {
  const el = screen.getByText(id);
  fireEvent.pointerDown(el, { ...init, clientX: 10, clientY: 5 });
  fireEvent.pointerMove(el, { ...init, clientX: 10, clientY: y });
  fireEvent.pointerUp(el, { ...init, clientX: 10, clientY: y });
  fireEvent.click(el);
}

describe("useDragReorder", () => {
  it("drops a row before the row whose upper half the pointer is over", () => {
    const onDrop = vi.fn();
    const onClick = vi.fn();
    render(<Harness onDrop={onDrop} onClick={onClick} />);
    layout();
    // c's slot is 80-120; 85 is its upper half.
    dragTo("a", 85);
    expect(onDrop).toHaveBeenCalledWith("a", "g", { group: "g", beforeId: "c" });
    // The click that ends a drag does not open the row.
    expect(onClick).not.toHaveBeenCalled();
  });

  it("stays within the group: past its last row drops at the group's end", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    layout();
    dragTo("a", 190); // over `x`, another group's row
    expect(onDrop).toHaveBeenCalledWith("a", "g", { group: "g", beforeId: null });
  });

  it("with crossGroup, lands in another group's rows or on its heading", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} crossGroup />);
    layout();
    dragTo("a", 165); // upper half of x
    expect(onDrop).toHaveBeenLastCalledWith("a", "g", { group: "h", beforeId: "x" });
    dragTo("b", 130); // the heading
    expect(onDrop).toHaveBeenLastCalledWith("b", "g", {
      group: "h",
      beforeId: null,
      atStart: true,
    });
  });

  it("shows a marker and dims nothing until the threshold is passed", () => {
    render(<Harness onDrop={vi.fn()} />);
    layout();
    const a = screen.getByText("a");
    fireEvent.pointerDown(a, { ...mouse, clientX: 10, clientY: 5 });
    fireEvent.pointerMove(a, { ...mouse, clientX: 10, clientY: 5 + DRAG_THRESHOLD_PX - 1 });
    expect(screen.getByTestId("dragging").textContent).toBe("");
    fireEvent.pointerMove(a, { ...mouse, clientX: 10, clientY: 125 });
    expect(screen.getByTestId("dragging").textContent).toBe("a");
    expect(screen.getByTestId("marker-c").textContent).toBe("after");
    fireEvent.pointerUp(a, { ...mouse, clientX: 10, clientY: 125 });
    expect(screen.getByTestId("dragging").textContent).toBe("");
  });

  it("a press that never passes the threshold is still a click", () => {
    const onDrop = vi.fn();
    const onClick = vi.fn();
    render(<Harness onDrop={onDrop} onClick={onClick} />);
    layout();
    dragTo("a", 7);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledWith("a");
  });

  it("ignores touch, so a phone scrolls and taps as before", () => {
    const onDrop = vi.fn();
    const onClick = vi.fn();
    render(<Harness onDrop={onDrop} onClick={onClick} />);
    layout();
    dragTo("a", 85, { pointerType: "touch", button: 0, pointerId: 2 });
    expect(onDrop).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledWith("a");
  });

  it("does nothing while disabled", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} enabled={false} />);
    layout();
    dragTo("a", 85);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("Escape cancels a drag in flight", () => {
    const onDrop = vi.fn();
    render(<Harness onDrop={onDrop} />);
    layout();
    const a = screen.getByText("a");
    fireEvent.pointerDown(a, { ...mouse, clientX: 10, clientY: 5 });
    fireEvent.pointerMove(a, { ...mouse, clientX: 10, clientY: 85 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(a, { ...mouse, clientX: 10, clientY: 85 });
    expect(onDrop).not.toHaveBeenCalled();
  });
});
