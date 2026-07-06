/**
 * Per-instance branding read from the server-injected `window.__PADDOCK_CONFIG__`
 * global (issue #34). The server writes this into index.html at serve time so
 * there's no flash; the accent color is applied via CSS `--accent*` variables
 * (see index.css + the injected <style>), so only the wordmark + logo need to be
 * read here. Defaults preserve today's look, and apply in dev (Vite, no server
 * injection) and in tests (no global).
 */
export interface Brand {
  name: string;
  logo: string;
  accent: string;
}

export const DEFAULT_BRAND: Brand = {
  name: "Paddock",
  logo: "🐎",
  accent: "#c2603c",
};

interface InjectedConfig {
  brand?: Partial<Brand>;
}

/** The resolved branding for this instance (injected global merged over defaults). */
export function getBrand(): Brand {
  const injected = (globalThis as { __PADDOCK_CONFIG__?: InjectedConfig }).__PADDOCK_CONFIG__;
  return { ...DEFAULT_BRAND, ...(injected?.brand ?? {}) };
}

/**
 * Whether a logo value should render as an <img> (a URL or absolute path) rather
 * than an inline glyph/emoji.
 */
export function logoIsImage(logo: string): boolean {
  return /^(https?:\/\/|\/)/i.test(logo.trim());
}
