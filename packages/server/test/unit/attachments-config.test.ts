import { describe, it, expect } from "vitest";
import {
  DEFAULT_ATTACHMENTS,
  resolveAttachmentsConfig,
  sanitizeAttachmentsOverride,
  sanitizeAllowedTypes,
  isTypeAllowed,
  maxFileBytes,
  type AttachmentsConfig,
} from "../../src/attachments-config.js";

const INSTANCE: AttachmentsConfig = {
  enabled: true,
  maxFileSizeMb: 25,
  maxFilesPerMessage: 10,
  allowedTypes: ["*"],
};

describe("sanitizeAttachmentsOverride", () => {
  it("keeps only valid fields and drops the rest", () => {
    expect(
      sanitizeAttachmentsOverride({
        enabled: false,
        maxFileSizeMb: 5,
        maxFilesPerMessage: 3,
        allowedTypes: ["image/*", ".pdf"],
      }),
    ).toEqual({
      enabled: false,
      maxFileSizeMb: 5,
      maxFilesPerMessage: 3,
      allowedTypes: ["image/*", ".pdf"],
    });
  });

  it("rejects non-integer / non-positive numeric knobs", () => {
    expect(sanitizeAttachmentsOverride({ maxFileSizeMb: 0 })).toBeUndefined();
    expect(sanitizeAttachmentsOverride({ maxFileSizeMb: -1 })).toBeUndefined();
    expect(sanitizeAttachmentsOverride({ maxFilesPerMessage: 2.5 })).toBeUndefined();
    expect(sanitizeAttachmentsOverride({ maxFileSizeMb: "5" })).toBeUndefined();
  });

  it("returns undefined for an empty / all-invalid / non-object override", () => {
    expect(sanitizeAttachmentsOverride({})).toBeUndefined();
    expect(sanitizeAttachmentsOverride({ enabled: "yes" })).toBeUndefined();
    expect(sanitizeAttachmentsOverride([])).toBeUndefined();
    expect(sanitizeAttachmentsOverride(null)).toBeUndefined();
    expect(sanitizeAttachmentsOverride({ allowedTypes: [] })).toBeUndefined();
  });

  it("lower-cases + trims allowedTypes and drops blanks", () => {
    expect(sanitizeAllowedTypes([" Image/PNG ", "", "  ", ".CSV"])).toEqual([
      "image/png",
      ".csv",
    ]);
    expect(sanitizeAllowedTypes([1, 2])).toBeUndefined();
    expect(sanitizeAllowedTypes("nope")).toBeUndefined();
  });
});

describe("resolveAttachmentsConfig", () => {
  it("inherits every field from the instance default when no override", () => {
    expect(resolveAttachmentsConfig(undefined, INSTANCE)).toEqual(INSTANCE);
  });

  it("lets a per-project override win field-by-field", () => {
    expect(
      resolveAttachmentsConfig({ enabled: false, maxFileSizeMb: 2 }, INSTANCE),
    ).toEqual({
      enabled: false,
      maxFileSizeMb: 2,
      maxFilesPerMessage: 10,
      allowedTypes: ["*"],
    });
  });

  it("ignores a corrupt on-disk override (re-sanitised)", () => {
    // maxFileSizeMb invalid ⇒ dropped ⇒ inherits; allowedTypes valid ⇒ wins.
    expect(
      resolveAttachmentsConfig(
        { maxFileSizeMb: -3, allowedTypes: ["image/*"] } as never,
        INSTANCE,
      ),
    ).toEqual({
      enabled: true,
      maxFileSizeMb: 25,
      maxFilesPerMessage: 10,
      allowedTypes: ["image/*"],
    });
  });

  it("exposes the default and a byte helper", () => {
    expect(DEFAULT_ATTACHMENTS.enabled).toBe(true);
    expect(DEFAULT_ATTACHMENTS.allowedTypes).toEqual(["*"]);
    expect(maxFileBytes({ ...INSTANCE, maxFileSizeMb: 3 })).toBe(3 * 1024 * 1024);
  });
});

describe("isTypeAllowed", () => {
  it("allow-all sentinels accept everything", () => {
    expect(isTypeAllowed(["*"], "application/x-weird", "thing.bin")).toBe(true);
    expect(isTypeAllowed(["*/*"], "", "")).toBe(true);
  });

  it("matches MIME patterns with a wildcard segment", () => {
    expect(isTypeAllowed(["image/*"], "image/png", "a.png")).toBe(true);
    expect(isTypeAllowed(["image/*"], "video/mp4", "a.mp4")).toBe(false);
    expect(isTypeAllowed(["text/csv"], "text/csv", "a.csv")).toBe(true);
  });

  it("matches an extension entry when the browser reports an empty/generic MIME", () => {
    // The key fallback: `.md`, `.ts` etc. arrive with "" or text/plain.
    expect(isTypeAllowed([".md"], "", "notes.md")).toBe(true);
    expect(isTypeAllowed([".ts"], "", "file.TS")).toBe(true);
    expect(isTypeAllowed([".heic"], "", "IMG_1.HEIC")).toBe(true);
    // MIME pattern alone would MISS an empty-MIME file — extension saves it.
    expect(isTypeAllowed(["image/*"], "", "photo.png")).toBe(false);
    expect(isTypeAllowed(["image/*", ".png"], "", "photo.png")).toBe(true);
  });

  it("allows if EITHER the MIME OR the extension matches", () => {
    expect(isTypeAllowed(["image/*", ".pdf"], "application/pdf", "doc.pdf")).toBe(true);
    expect(isTypeAllowed(["image/*", ".pdf"], "image/jpeg", "x.jpg")).toBe(true);
    expect(isTypeAllowed(["image/*", ".pdf"], "text/plain", "x.txt")).toBe(false);
  });

  it("tolerates a bare token as an extension", () => {
    expect(isTypeAllowed(["png"], "", "a.png")).toBe(true);
  });

  it("treats a dotfile with no extension as having no extension", () => {
    expect(isTypeAllowed([".gitignore"], "", ".gitignore")).toBe(false);
  });
});
