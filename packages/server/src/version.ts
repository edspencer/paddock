/**
 * The running Paddock version, resolved once.
 *
 * Three surfaces have to agree on this string and now do, because they read it
 * from one place: the OpenAPI document's `info.version` (`app.ts`), the
 * management MCP server's advertised version, and — the reason this module
 * exists — `GET /api/health`, which the CLI contract requires to carry the
 * version so that `paddock service status` can compare the version that is
 * RUNNING with the version that is installed (SPEC §8).
 *
 * `createRequire(import.meta.url)` resolves against this module's own path, so
 * `../package.json` is `packages/server/package.json` from `dist/version.js` in
 * both layouts the package ships in (the repo, and the synthesized npm tarball
 * — see `scripts/make-npm-package.mjs`, which keeps that manifest precisely so
 * a version is readable at runtime).
 *
 * Never throws. A missing or unreadable manifest degrades to `"0.0.0"`: a
 * health endpoint that 500s because it could not find its own version would be
 * a worse failure than one that answers with a version nobody shipped.
 */
import { createRequire } from "node:module";

export const PADDOCK_VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    return (require("../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** What the product is called in prose, for `serve`'s banner line (SPEC §3). */
export const PADDOCK_NAME = "Paddock";
