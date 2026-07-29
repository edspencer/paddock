import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Regression guard for #541.
 *
 * The three `window.prompt` / `window.confirm` call sites this issue removed had
 * survived for a long time simply because nothing pointed at them — they look
 * completely ordinary at the call site, and each one individually is a
 * one-liner that is quicker to write than reaching for the modal. That is
 * exactly the kind of thing that comes back one PR at a time, so the ban is
 * enforced rather than documented.
 *
 * Test files are exempt: mocking `window.confirm` is legitimate there.
 */
const SRC = join(__dirname);
const NATIVE_DIALOG = /(?:window|globalThis)\s*\.\s*(prompt|confirm|alert)\s*\(/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

describe("no native browser dialogs (#541)", () => {
  it("has no window.prompt / confirm / alert in app source", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        // Comments are exempt: the replacements document what they replaced,
        // and naming `window.prompt()` in a doc comment shouldn't fail the
        // build. Crude but deliberate — this guards a call-site ban, so a
        // false negative inside a comment costs nothing.
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        if (NATIVE_DIALOG.test(line)) {
          offenders.push(`${relative(SRC, file)}:${i + 1}: ${trimmed}`);
        }
      });
    }
    expect(
      offenders,
      "Use ConfirmDialog or RenameChatModal instead of a native browser dialog.\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("actually detects an offending line (guards the guard)", () => {
    // A regex that silently stops matching would make the test above pass
    // forever, so prove it still fires on the shapes it is meant to catch.
    expect(NATIVE_DIALOG.test(`if (!window.confirm("x")) return;`)).toBe(true);
    expect(NATIVE_DIALOG.test(`const n = window.prompt("Rename chat", chat.name);`)).toBe(true);
    expect(NATIVE_DIALOG.test(`globalThis.alert("x")`)).toBe(true);
    expect(NATIVE_DIALOG.test(`window . confirm ( "spaced" )`)).toBe(true);
    // ...and does not fire on ordinary code that merely contains the words.
    expect(NATIVE_DIALOG.test(`const systemPrompt = buildPrompt(x);`)).toBe(false);
    expect(NATIVE_DIALOG.test(`await confirmRevert();`)).toBe(false);
  });
});
