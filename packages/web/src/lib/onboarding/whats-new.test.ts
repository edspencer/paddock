import { describe, it, expect } from "vitest";
import { whatsNew, WHATS_NEW_MAX } from "./whats-new";

// The cap is the point of #866: the live list is bounded, and adding a
// thirteenth entry is a build failure rather than something review has to
// notice. Bumping the oldest out to `whats-new-archive.mdx` is not optional.
describe("What's New cap (#866)", () => {
  it("is capped at 12", () => {
    expect(WHATS_NEW_MAX).toBe(12);
  });

  it("holds no more than the cap — a 13th entry must bump the oldest", () => {
    expect(whatsNew.length).toBeLessThanOrEqual(WHATS_NEW_MAX);
  });

  it("is actually full, so the cap is exercised rather than theoretical", () => {
    expect(whatsNew).toHaveLength(WHATS_NEW_MAX);
  });
});

describe("What's New entries", () => {
  it("have unique ids", () => {
    const ids = whatsNew.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("have every field populated", () => {
    for (const entry of whatsNew) {
      expect(entry.id, "id").toBeTruthy();
      expect(entry.version, `${entry.id} version`).toMatch(/^\d+\.\d+(\.\d+)?$/);
      expect(entry.title, `${entry.id} title`).toBeTruthy();
      expect(entry.body, `${entry.id} body`).toBeTruthy();
    }
  });

  // The card gives each entry one line. A newline here would silently reflow it.
  it("carry exactly one line of body", () => {
    for (const entry of whatsNew) {
      expect(entry.body, `${entry.id} body`).not.toContain("\n");
    }
  });

  // #865 randomizes which entry is shown, so each is read alone with nothing
  // around it. Anything positional is wrong by construction.
  it("do not refer to a neighbouring entry", () => {
    const positional =
      /\b(as (mentioned|noted|described) (above|below|earlier)|see above|see below|the previous (entry|release)|as covered)\b/i;
    for (const entry of whatsNew) {
      expect(positional.test(entry.body), `${entry.id} body`).toBe(false);
    }
  });

  it("link to a real anchor on the website's What's New page", () => {
    for (const entry of whatsNew) {
      expect(entry.href, `${entry.id} href`).toMatch(
        // Underscores are legal here: `#065--promote_project-over-mcp`.
        /^https:\/\/paddock\.edspencer\.net\/whats-new\/#[a-z0-9_-]+$/,
      );
    }
  });

  it("are ordered newest first", () => {
    const rank = (v: string) => {
      const [major, minor, patch = "0"] = v.split(".");
      return Number(major) * 1e6 + Number(minor) * 1e3 + Number(patch);
    };
    const ranks = whatsNew.map((e) => rank(e.version));
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });
});
