import { describe, it, expect } from "vitest";
import { tips } from "./tips";

describe("tips", () => {
  it("has enough to make randomizing worthwhile", () => {
    expect(tips.length).toBeGreaterThanOrEqual(20);
  });

  it("has unique ids", () => {
    const ids = tips.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses kebab-case ids", () => {
    for (const tip of tips) {
      expect(tip.id, tip.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("keeps titles short", () => {
    for (const tip of tips) {
      expect(tip.title.split(/\s+/).length, `${tip.id} title`).toBeLessThanOrEqual(8);
    }
  });

  // The card renders `body` as text. A stray backtick, asterisk or link would
  // show up literally rather than as formatting. Underscores are NOT checked:
  // env var names like PADDOCK_WHISPER_ENDPOINT are the point of some tips.
  it("carries plain-text bodies, not markdown", () => {
    for (const tip of tips) {
      expect(tip.body, `${tip.id} body`).not.toMatch(/[`*]|\[.+\]\(.+\)/);
    }
  });

  it("keeps bodies to a couple of sentences", () => {
    for (const tip of tips) {
      expect(tip.body.length, `${tip.id} body`).toBeLessThanOrEqual(280);
    }
  });

  // #865 shows one random tip with nothing around it. A tip that refers to
  // another one, or to its position in a list, is broken by construction.
  it("reads in isolation", () => {
    const positional =
      /\b(as (mentioned|noted|described) (above|below|earlier)|see above|see below|the (previous|next|last) tip|another tip|as covered)\b/i;
    for (const tip of tips) {
      expect(positional.test(tip.body), `${tip.id} body`).toBe(false);
      expect(positional.test(tip.title), `${tip.id} title`).toBe(false);
    }
  });

  it("links only to the documentation site", () => {
    for (const tip of tips) {
      if (tip.href === undefined) continue;
      expect(tip.href, `${tip.id} href`).toMatch(
        /^https:\/\/paddock\.edspencer\.net\/[a-z0-9/-]+\/(#[a-z0-9_-]+)?$/,
      );
    }
  });
});
