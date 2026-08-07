/**
 * Class-name join. Falsy entries drop out, so a conditional reads
 * `cx("base", isOpen && "open", className)`.
 *
 * Deliberately not `clsx`/`tailwind-merge`: the primitives in this folder put
 * the caller's `className` LAST, and later Tailwind utilities of the same
 * property win by source order in the generated stylesheet, so an override
 * works without a merge pass. Anything that genuinely needs to *replace* a
 * primitive's styling should be taking a variant instead.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
