import { lazy, memo, Suspense } from "react";

// react-markdown + remark-gfm are ~130KB of JS we don't want in the entry
// chunk (issue #11). Load the renderer lazily; once the module is fetched the
// first time it's cached, so subsequent markdown renders are synchronous.
const MarkdownRenderer = lazy(() => import("./MarkdownRenderer"));

/**
 * Renders text as GitHub-flavored markdown. Styling lives in the `.md` scope in
 * index.css. Links open in a new tab. Memoized so streaming re-renders of
 * sibling turns stay cheap.
 *
 * While the renderer chunk is still loading, we show the raw text in the same
 * `.md` container (pre-wrapped) so streaming chat never flashes empty — the
 * upgrade to formatted markdown happens as soon as the chunk resolves.
 *
 * Pass `mermaid` to render ```mermaid fenced code blocks as real SVG diagrams
 * (used by the file viewer, not the streaming chat — a half-streamed diagram
 * would just error repeatedly).
 */
export const Markdown = memo(function Markdown({
  children,
  mermaid = false,
}: {
  children: string;
  mermaid?: boolean;
}) {
  return (
    <Suspense fallback={<div className="md whitespace-pre-wrap">{children}</div>}>
      <MarkdownRenderer mermaid={mermaid}>{children}</MarkdownRenderer>
    </Suspense>
  );
});
