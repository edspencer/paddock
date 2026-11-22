import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SortModeMenu } from "./SortModeMenu";

describe("SortModeMenu", () => {
  const renderMenu = (onChange = vi.fn()) => {
    render(<SortModeMenu mode="recent" onChange={onChange} noun="chats" triggerClassName="" />);
    return onChange;
  };
  const trigger = () => screen.getByRole("button", { name: "Sort chats (Most recent reply)" });

  it("lists the three modes with the current one checked", () => {
    renderMenu();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger());
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["Most recent reply", "Created", "Manual"]);
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  });

  it("reports a new mode and closes; picking the current one reports nothing", () => {
    const onChange = renderMenu();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Manual" }));
    expect(onChange).toHaveBeenCalledWith("manual");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Most recent reply" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and on an outside click", () => {
    renderMenu();
    fireEvent.click(trigger());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger());
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
