import { useEffect, useState } from "react";

/**
 * Theme-aware syntax highlighting for agent-sent code (issue #127).
 *
 * highlight.js is heavy, so it's kept OUT of the entry chunk (the bundle is
 * deliberately code-split — issues #11/#115/#116). We import `highlight.js/lib/core`
 * and register only a curated language set — the languages the send-file MCP can
 * infer (see `LANGUAGE_BY_EXT` in packages/server/src/send-file-mcp.ts) — via a
 * single module-level memoized promise, so the dynamic import + registration
 * happen exactly once across every CodeBlock on the page.
 *
 * The token *colors* are hand-written CSS (`.hljs-*` in index.css), keyed to the
 * Paddock palette for a matched light + dark scheme — we deliberately do NOT
 * import a prebuilt highlight.js theme (keeps theme control + avoids an extra
 * chunk). This component only sets the highlighted markup + the `hljs` classes.
 */

/**
 * hljs language label (what we register + pass to `highlight`) keyed by the
 * `language` hint the server sends. Mirrors `LANGUAGE_BY_EXT`'s value set, with
 * the two aliases hljs doesn't know by those names mapped onto real grammars
 * (tsx→typescript, jsx→javascript; xml covers html).
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  tsx: "typescript",
  jsx: "javascript",
  html: "xml",
};

/** Resolve a sent `language` hint to a registered hljs language label, if any. */
function resolveLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const lower = language.toLowerCase();
  return LANGUAGE_ALIASES[lower] ?? lower;
}

// Memoized loader: dynamically import the core + the curated grammars, register
// them once, and hand back the ready `hljs` instance. Every CodeBlock awaits the
// same promise, so the async chunk loads a single time.
let hljsPromise: Promise<typeof import("highlight.js/lib/core").default> | null = null;

async function getHljs() {
  if (!hljsPromise) {
    hljsPromise = (async () => {
      const { default: hljs } = await import("highlight.js/lib/core");
      // The curated language set — only what the send-file MCP can infer. Each is
      // its own tiny grammar module, so we pull in just these rather than the
      // ~200-language "common"/full bundle.
      const [
        typescript,
        javascript,
        python,
        ruby,
        go,
        rust,
        java,
        c,
        cpp,
        csharp,
        php,
        swift,
        kotlin,
        bash,
        sql,
        json,
        yaml,
        ini,
        css,
        scss,
        xml,
      ] = await Promise.all([
        import("highlight.js/lib/languages/typescript"),
        import("highlight.js/lib/languages/javascript"),
        import("highlight.js/lib/languages/python"),
        import("highlight.js/lib/languages/ruby"),
        import("highlight.js/lib/languages/go"),
        import("highlight.js/lib/languages/rust"),
        import("highlight.js/lib/languages/java"),
        import("highlight.js/lib/languages/c"),
        import("highlight.js/lib/languages/cpp"),
        import("highlight.js/lib/languages/csharp"),
        import("highlight.js/lib/languages/php"),
        import("highlight.js/lib/languages/swift"),
        import("highlight.js/lib/languages/kotlin"),
        import("highlight.js/lib/languages/bash"),
        import("highlight.js/lib/languages/sql"),
        import("highlight.js/lib/languages/json"),
        import("highlight.js/lib/languages/yaml"),
        // hljs ships TOML under the `ini` grammar.
        import("highlight.js/lib/languages/ini"),
        import("highlight.js/lib/languages/css"),
        import("highlight.js/lib/languages/scss"),
        import("highlight.js/lib/languages/xml"),
      ]);
      hljs.registerLanguage("typescript", typescript.default);
      hljs.registerLanguage("javascript", javascript.default);
      hljs.registerLanguage("python", python.default);
      hljs.registerLanguage("ruby", ruby.default);
      hljs.registerLanguage("go", go.default);
      hljs.registerLanguage("rust", rust.default);
      hljs.registerLanguage("java", java.default);
      hljs.registerLanguage("c", c.default);
      hljs.registerLanguage("cpp", cpp.default);
      hljs.registerLanguage("csharp", csharp.default);
      hljs.registerLanguage("php", php.default);
      hljs.registerLanguage("swift", swift.default);
      hljs.registerLanguage("kotlin", kotlin.default);
      hljs.registerLanguage("bash", bash.default);
      hljs.registerLanguage("sql", sql.default);
      hljs.registerLanguage("json", json.default);
      hljs.registerLanguage("yaml", yaml.default);
      // `toml` maps onto the ini grammar so the sent label resolves as-is.
      hljs.registerLanguage("toml", ini.default);
      hljs.registerLanguage("css", css.default);
      hljs.registerLanguage("scss", scss.default);
      hljs.registerLanguage("xml", xml.default);
      return hljs;
    })();
  }
  return hljsPromise;
}

/**
 * A single code block. Renders the raw code immediately (so nothing flashes empty
 * and it still works if the highlighter chunk fails to load), then upgrades to
 * highlighted markup once hljs resolves — but only when `language` is a known,
 * registered grammar. Unknown/absent language or a highlight error keeps the
 * plain escaped text (we avoid `highlightAuto` — mis-detection isn't worth the cost).
 */
export function CodeBlock({ code, language }: { code: string; language?: string }) {
  // `null` = plain (baseline); a string = highlighted innerHTML to inject.
  const [html, setHtml] = useState<string | null>(null);
  const lang = resolveLanguage(language);

  useEffect(() => {
    // No known language ⇒ stay plain; don't even pull the chunk for nothing.
    if (!lang) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    setHtml(null);
    void (async () => {
      try {
        const hljs = await getHljs();
        if (cancelled) return;
        // A registered grammar is required — if the label isn't known, keep plain.
        if (!hljs.getLanguage(lang)) return;
        const { value } = hljs.highlight(code, { language: lang });
        if (!cancelled) setHtml(value); // guard against setState-after-unmount
      } catch {
        // Highlighting failed — leave the plain baseline in place.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  // Shared container styling — matches the plain code `<pre>` in SentFileBlock so
  // the block looks identical before/after the highlighter loads. Colors come
  // from the `.hljs-*` CSS, so we don't set a background that fights the card.
  const preClass =
    "overflow-x-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12.5px] leading-relaxed text-paddock-800 dark:text-paddock-200";

  if (html !== null) {
    return (
      <pre className={preClass}>
        <code
          className={`hljs language-${lang}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
    );
  }

  // Baseline: raw, escaped code (React escapes the text node for us).
  return (
    <pre className={preClass}>
      <code>{code}</code>
    </pre>
  );
}
