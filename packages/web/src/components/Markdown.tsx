import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Mermaid } from "./Mermaid";

/**
 * Renders text as GitHub-flavored markdown. Styling lives in the `.md` scope in
 * index.css. Links open in a new tab. Memoized so streaming re-renders of
 * sibling turns stay cheap.
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
  const components: Components = {
    a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" />,
  };

  if (mermaid) {
    // A ```mermaid fence renders as <pre><code class="language-mermaid">. We
    // hoist the diagram out of the <pre> so it isn't wrapped in code styling.
    components.pre = ({ children, ...props }) => {
      const child = Array.isArray(children) ? children[0] : children;
      const cls =
        child && typeof child === "object" && "props" in child
          ? ((child.props as { className?: string }).className ?? "")
          : "";
      if (/language-mermaid/.test(cls)) {
        const raw = (child as { props: { children?: unknown } }).props.children;
        return <Mermaid code={String(raw ?? "").replace(/\n$/, "")} />;
      }
      return <pre {...props}>{children}</pre>;
    };
  }

  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
});
