import { describe, it, expect, beforeEach } from "vitest";
import { readCardDismissed, writeCardDismissed } from "./dismissal";

describe("onboarding card dismissal", () => {
  beforeEach(() => localStorage.clear());

  it("is not dismissed until written", () => {
    expect(readCardDismissed("tips", ["a", "b"])).toBe(false);
  });

  it("stays dismissed while the card's entries are unchanged", () => {
    writeCardDismissed("tips", ["a", "b"]);
    expect(readCardDismissed("tips", ["a", "b"])).toBe(true);
  });

  it("comes back when the entries change", () => {
    writeCardDismissed("whats-new", ["0-78", "0-77"]);
    expect(readCardDismissed("whats-new", ["0-79", "0-78", "0-77"])).toBe(false);
  });

  it("keeps each card's dismissal separate", () => {
    writeCardDismissed("tips", ["a"]);
    expect(readCardDismissed("whats-new", ["a"])).toBe(false);
  });
});
