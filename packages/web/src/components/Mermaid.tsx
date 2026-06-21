import { useEffect, useId, useRef, useState } from "react";

// Mermaid is heavy (~500KB), so it's loaded lazily the first time a diagram is
// actually rendered. The init is done once, theme-matched to the app (the SPA
// runs in dark mode — <html class="dark">). Render errors are caught and shown
// as a readable fallback rather than blowing up the file view.

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function isDark(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement.classList.contains("dark");
}

async function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict", // sanitizes diagram-authored HTML labels
        theme: isDark() ? "dark" : "default",
        fontFamily: "Inter, system-ui, sans-serif",
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

/** Renders a single Mermaid diagram from its source to inline SVG. */
export function Mermaid({ code }: { code: string }) {
  const reactId = useId();
  // Mermaid needs a CSS-id-safe, unique id per render.
  const domId = "mmd-" + reactId.replace(/[^a-zA-Z0-9-]/g, "");
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const mermaid = await getMermaid();
        // parse first so a syntax error doesn't leave a dangling render node.
        await mermaid.parse(code);
        const { svg, bindFunctions } = await mermaid.render(domId + "-svg", code);
        if (cancelled || !hostRef.current) return;
        hostRef.current.innerHTML = svg;
        bindFunctions?.(hostRef.current);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to render diagram");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, domId]);

  if (error) {
    return (
      <div className="my-3 rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-xs dark:border-amber-900/60 dark:bg-amber-950/40">
        <p className="font-semibold text-amber-700 dark:text-amber-300">
          Couldn't render this Mermaid diagram
        </p>
        <p className="mt-1 text-amber-600 dark:text-amber-400/90">{error}</p>
        <pre className="mt-2 overflow-x-auto rounded bg-paddock-100 p-2 font-mono text-[11.5px] text-paddock-700 dark:bg-paddock-950 dark:text-paddock-300">
          {code}
        </pre>
      </div>
    );
  }

  return (
    <div
      ref={hostRef}
      data-testid="mermaid"
      className="mermaid-host my-3 flex justify-center overflow-x-auto rounded-lg border border-paddock-200 bg-white/60 p-3 dark:border-paddock-800 dark:bg-paddock-950/40"
    />
  );
}
