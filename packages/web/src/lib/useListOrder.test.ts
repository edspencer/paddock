import { describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { applyListOrderPatch, useListOrder } from "./useListOrder";
import type { ListOrder } from "./types";

describe("applyListOrderPatch", () => {
  it("sets the mode, replaces named groups, and deletes null or empty ones", () => {
    const before: ListOrder = { mode: "recent", orders: { a: ["1"], b: ["2"], c: ["3"] } };
    const patch = { mode: "manual" as const, orders: { a: ["9"], b: null, c: [] } };
    expect(applyListOrderPatch(before, patch)).toEqual({ mode: "manual", orders: { a: ["9"] } });
    expect(before.orders.b).toEqual(["2"]);
  });
});

describe("useListOrder", () => {
  it("shows the default until the load lands, then the loaded order", async () => {
    const load = vi.fn().mockResolvedValue({ mode: "created", orders: {} });
    const { result } = renderHook(() => useListOrder("k", load, vi.fn()));
    expect(result.current.order.mode).toBe("recent");
    await waitFor(() => expect(result.current.order.mode).toBe("created"));
  });

  it("keeps the default when the load fails", async () => {
    const load = vi.fn().mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useListOrder("k", load, vi.fn()));
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(result.current.order).toEqual({ mode: "recent", orders: {} });
    expect(result.current.error).toBeNull();
  });

  it("applies an update at once and sends the patch", async () => {
    const save = vi.fn().mockResolvedValue({});
    const { result } = renderHook(() =>
      useListOrder("k", () => Promise.resolve({ mode: "recent", orders: {} }), save),
    );
    await act(async () => {
      await result.current.update({ mode: "manual", orders: { g: ["a"] } });
    });
    expect(save).toHaveBeenCalledWith({ mode: "manual", orders: { g: ["a"] } });
    expect(result.current.order).toEqual({ mode: "manual", orders: { g: ["a"] } });
  });

  it("rolls back and reports the error when the save fails", async () => {
    const save = vi.fn().mockRejectedValue(new Error("nope"));
    const { result } = renderHook(() =>
      useListOrder("k", () => Promise.resolve({ mode: "created", orders: {} }), save),
    );
    await waitFor(() => expect(result.current.order.mode).toBe("created"));
    await act(async () => {
      await result.current.update({ mode: "manual" });
    });
    expect(result.current.order.mode).toBe("created");
    expect(result.current.error).toBe("nope");
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it("sends saves one at a time, in the order they were made", async () => {
    const pending: Array<() => void> = [];
    const save = vi.fn(() => new Promise<void>((resolve) => pending.push(resolve)));
    const { result } = renderHook(() =>
      useListOrder("k", () => Promise.resolve({ mode: "recent", orders: {} }), save),
    );
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.update({ mode: "manual", orders: { g: ["a", "b"] } });
      second = result.current.update({ orders: { g: ["b", "a"] } });
    });
    expect(result.current.order.orders.g).toEqual(["b", "a"]);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenLastCalledWith({ mode: "manual", orders: { g: ["a", "b"] } });
    await act(async () => {
      pending[0]!();
      await first;
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith({ orders: { g: ["b", "a"] } });
    await act(async () => {
      pending[1]!();
      await second;
    });
    expect(result.current.order).toEqual({ mode: "manual", orders: { g: ["b", "a"] } });
  });

  it("after a failed save, resyncs from the server and keeps the saves queued behind it", async () => {
    const server: ListOrder = { mode: "created", orders: {} };
    const load = vi.fn().mockResolvedValue(server);
    let rejectFirst!: (e: Error) => void;
    const save = vi
      .fn()
      .mockImplementationOnce(() => new Promise((_, reject) => (rejectFirst = reject)))
      .mockResolvedValue({});
    const { result } = renderHook(() => useListOrder("k", load, save));
    await waitFor(() => expect(result.current.order.mode).toBe("created"));
    let done!: Promise<void>;
    act(() => {
      void result.current.update({ mode: "manual", orders: { g: ["a"] } });
      done = result.current.update({ orders: { h: ["x"] } });
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await act(async () => {
      rejectFirst(new Error("nope"));
      await done;
    });
    // The failed patch is gone; the one queued behind it still shows and was sent.
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.order).toEqual({ mode: "created", orders: { h: ["x"] } });
    expect(save).toHaveBeenLastCalledWith({ orders: { h: ["x"] } });
    expect(result.current.error).toBe("nope");
  });

  it("reloads when the key changes", async () => {
    const load = vi.fn().mockResolvedValue({ mode: "recent", orders: {} });
    const { rerender } = renderHook(({ k }) => useListOrder(k, load, vi.fn()), {
      initialProps: { k: "a" },
    });
    rerender({ k: "b" });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});
