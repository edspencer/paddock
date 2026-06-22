import { describe, it, expect } from "vitest";
import {
  AREAS,
  UNSORTED_SLUG,
  INBOX,
  areaLabel,
  areaBlurb,
  orderAreaSlugs,
} from "./areas";

describe("areas: labels", () => {
  it("returns the canonical label for a known slug", () => {
    expect(areaLabel("homelab")).toBe("Homelab");
    expect(areaLabel("house")).toBe("House");
    expect(areaLabel("side-projects")).toBe("Side Projects");
  });

  it("renders an empty slug as Unsorted", () => {
    expect(areaLabel("")).toBe("Unsorted");
    expect(areaLabel(UNSORTED_SLUG)).toBe("Unsorted");
  });

  it("title-cases an unknown kebab slug", () => {
    expect(areaLabel("home-cinema")).toBe("Home Cinema");
    expect(areaLabel("garden")).toBe("Garden");
  });

  it("exposes blurbs for known areas and undefined for unknown", () => {
    expect(areaBlurb("homelab")).toMatch(/self-hosted/i);
    expect(areaBlurb("does-not-exist")).toBeUndefined();
    expect(areaBlurb("")).toBeUndefined();
  });

  it("Inbox is a distinct synthetic area", () => {
    expect(INBOX.slug).toBe("inbox");
    expect(INBOX.label).toBe("Inbox");
  });
});

describe("areas: orderAreaSlugs", () => {
  it("orders canonical areas in their defined order", () => {
    const ordered = orderAreaSlugs(["side-projects", "homelab", "house"]);
    expect(ordered).toEqual(["homelab", "house", "side-projects"]);
  });

  it("only includes canonical areas that are present", () => {
    const ordered = orderAreaSlugs(["house"]);
    expect(ordered).toEqual(["house"]);
  });

  it("places non-canonical slugs alphabetically after canonical ones", () => {
    const ordered = orderAreaSlugs(["zebra", "homelab", "apple"]);
    expect(ordered).toEqual(["homelab", "apple", "zebra"]);
  });

  it("always places Unsorted ('') last", () => {
    const ordered = orderAreaSlugs(["", "homelab", "custom"]);
    expect(ordered).toEqual(["homelab", "custom", ""]);
    expect(ordered[ordered.length - 1]).toBe(UNSORTED_SLUG);
  });

  it("dedupes repeated slugs", () => {
    const ordered = orderAreaSlugs(["homelab", "homelab", "house", "house"]);
    expect(ordered).toEqual(["homelab", "house"]);
  });

  it("handles a Set input and an empty input", () => {
    expect(orderAreaSlugs(new Set(["house", "homelab"]))).toEqual(["homelab", "house"]);
    expect(orderAreaSlugs([])).toEqual([]);
  });

  it("produces a full ordering: canonical → custom (sorted) → unsorted", () => {
    const present = ["", "beta", "side-projects", "alpha", "homelab"];
    expect(orderAreaSlugs(present)).toEqual([
      "homelab",
      "side-projects",
      "alpha",
      "beta",
      "",
    ]);
  });

  it("AREAS is the canonical set in display order", () => {
    expect(AREAS.map((a) => a.slug)).toEqual(["homelab", "house", "side-projects"]);
  });
});
