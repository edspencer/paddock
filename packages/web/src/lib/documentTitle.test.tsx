import { describe, it, expect, afterEach } from "vitest";
import { render } from "@testing-library/react";
import {
  cleanTitlePart,
  formatDocumentTitle,
  TITLE_PART_MAX,
  useDocumentTitle,
  type TitlePart,
} from "./documentTitle";

type WithConfig = { __PADDOCK_CONFIG__?: unknown };
const setBrand = (name: string) => {
  (globalThis as WithConfig).__PADDOCK_CONFIG__ = { brand: { name } };
};

afterEach(() => {
  delete (globalThis as WithConfig).__PADDOCK_CONFIG__;
});

describe("formatDocumentTitle (#958)", () => {
  it("reads most specific first, brand last", () => {
    expect(formatDocumentTitle({ parts: ["Fix the leaking tap", "hushpod"], brand: "House" })).toBe(
      "Fix the leaking tap · hushpod — House",
    );
  });

  it("is just the brand when there are no parts", () => {
    expect(formatDocumentTitle({ parts: [], brand: "House" })).toBe("House");
  });

  it("skips empty, whitespace-only and nullish parts — never 'undefined' or a dangling separator", () => {
    const parts: TitlePart[] = [undefined, null, "", "   ", false, "hushpod"];
    expect(formatDocumentTitle({ parts, brand: "House" })).toBe("hushpod — House");
    expect(formatDocumentTitle({ parts: [null, "  "], brand: "House" })).toBe("House");
  });

  it("keeps a part equal to the brand — root de-duplication is the caller's call", () => {
    expect(formatDocumentTitle({ parts: ["Fix it", "paddock"], brand: "Paddock" })).toBe(
      "Fix it · paddock — Paddock",
    );
  });

  it("never collapses equal parts: a chat named like its project stays distinct from Home", () => {
    expect(formatDocumentTitle({ parts: ["hushpod", "hushpod"], brand: "House" })).toBe(
      "hushpod · hushpod — House",
    );
  });

  it("falls back to Paddock for a blank brand", () => {
    expect(formatDocumentTitle({ parts: ["x"], brand: "  " })).toBe("x — Paddock");
  });
});

describe("cleanTitlePart", () => {
  it("collapses whitespace, including newlines", () => {
    expect(cleanTitlePart("  Fix\n  the   tap ")).toBe("Fix the tap");
  });

  it(`truncates to ${TITLE_PART_MAX} characters with an ellipsis`, () => {
    const long = "a".repeat(100);
    const out = cleanTitlePart(long);
    expect(Array.from(out)).toHaveLength(TITLE_PART_MAX);
    expect(out.endsWith("…")).toBe(true);
    // Exactly at the limit is untouched.
    expect(cleanTitlePart("b".repeat(TITLE_PART_MAX))).toBe("b".repeat(TITLE_PART_MAX));
  });

  it("never splits an emoji into a lone surrogate", () => {
    const out = cleanTitlePart("🐎".repeat(100));
    expect(out).toBe(`${"🐎".repeat(TITLE_PART_MAX - 1)}…`);
  });

  // Each cluster below is several code points; put one straddling the cut
  // (characters 59–60) and it must survive whole, not as a fragment.
  const pad = "a".repeat(TITLE_PART_MAX - 2);
  it.each([
    ["ZWJ family", "👨‍👩‍👧"],
    ["flag", "🇬🇧"],
    ["skin-tone emoji", "👍🏽"],
    ["combining accent", "e\u0301"],
  ])("cuts by grapheme: a %s at the cut point stays whole", (_label, cluster) => {
    const out = cleanTitlePart(`${pad}${cluster}${cluster}tail`);
    expect(out).toBe(`${pad}${cluster}…`);
  });

  it("counts a cluster as one character toward the limit", () => {
    const fam = "👨‍👩‍👧".repeat(TITLE_PART_MAX);
    expect(cleanTitlePart(fam)).toBe(fam);
  });

  it("doesn't leave a space before the ellipsis", () => {
    const out = cleanTitlePart(`${"a".repeat(TITLE_PART_MAX - 2)} bcdef`);
    expect(out).toBe(`${"a".repeat(TITLE_PART_MAX - 2)}…`);
  });
});

function Titled({ parts }: { parts: TitlePart[] }) {
  useDocumentTitle(parts);
  return null;
}

describe("useDocumentTitle", () => {
  it("sets the title with the default brand", () => {
    render(<Titled parts={["Discover"]} />);
    expect(document.title).toBe("Discover — Paddock");
  });

  it("follows the injected brand, and a brand change on re-render", () => {
    setBrand("House");
    const { rerender } = render(<Titled parts={["Config"]} />);
    expect(document.title).toBe("Config — House");
    setBrand("Barn");
    rerender(<Titled parts={["Config"]} />);
    expect(document.title).toBe("Config — Barn");
  });

  it("updates when the parts change", () => {
    const { rerender } = render(<Titled parts={["Old"]} />);
    expect(document.title).toBe("Old — Paddock");
    rerender(<Titled parts={["New"]} />);
    expect(document.title).toBe("New — Paddock");
  });

  it("restores the bare brand on unmount, so a route without a title inherits nothing stale", () => {
    setBrand("House");
    const { unmount } = render(<Titled parts={["Secret chat name", "hushpod"]} />);
    expect(document.title).toBe("Secret chat name · hushpod — House");
    unmount();
    expect(document.title).toBe("House");
  });

  it("a page mounting after another unmounts wins (chat → /discover)", () => {
    setBrand("House");
    function Swap({ page }: { page: "chat" | "discover" }) {
      return page === "chat" ? (
        <Titled key="chat" parts={["Fix the tap", "hushpod"]} />
      ) : (
        <Titled key="discover" parts={["Discover"]} />
      );
    }
    const { rerender } = render(<Swap page="chat" />);
    expect(document.title).toBe("Fix the tap · hushpod — House");
    rerender(<Swap page="discover" />);
    expect(document.title).toBe("Discover — House");
  });
});
