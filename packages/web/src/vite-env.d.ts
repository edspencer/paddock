/// <reference types="vite/client" />

// Injected at build time from packages/web/package.json version (see vite.config.ts).
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
