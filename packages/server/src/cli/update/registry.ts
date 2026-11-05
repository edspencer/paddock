/**
 * The npm registry, as `update` asks it (CLI contract SPEC §5 step 3).
 *
 * Two requests, both with `fetch` and a 10-second abort, and nothing else:
 *
 *   GET <registry>/-/package/<name>/dist-tags   which version is `latest`
 *   GET <registry>/<name>/<version>             that version's `engines`
 *
 * Deliberately NOT `npm view`: spawning npm to read two small JSON documents
 * costs a second of process start-up, needs npm to be on PATH at all, and puts
 * the registry's answer through a program whose output format is not a
 * contract. `fetch` is in Node 22 and the registry's REST surface has been
 * stable for a decade.
 *
 * **Nothing here is called except by a person.** SPEC §3: only `update`,
 * `update --check` and `doctor` contact the registry, and only when someone
 * runs them. There is no background check and no check at startup, which is why
 * this module is reachable from the CLI and from nowhere in the server.
 *
 * Generic: wave C4 lifts it into `reference/registry.ts`.
 */

/** SPEC §5: 10 seconds, and it is the budget for each request rather than the pair. */
export const REGISTRY_TIMEOUT_MS = 10_000;

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export interface RegistryOptions {
  packageName: string;
  /** Base URL, no trailing slash required — {@link registryUrl} normalises it. */
  registry: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * Which registry to ask: `npm_config_registry`, else `npm config get registry`,
 * else the public one (SPEC §5 step 3).
 *
 * The first is what makes the fake-registry tests possible without touching a
 * global npm config — an `npm_config_registry` in the environment is how npm
 * itself takes the same setting, so a test and a real `.npmrc` arrive by the
 * same door.
 */
export function resolveRegistry(
  env: NodeJS.ProcessEnv,
  npmConfigGet?: (key: string) => string | undefined,
): string {
  const fromEnv = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  const fromNpm = npmConfigGet?.("registry");
  if (fromNpm !== undefined && fromNpm.trim() !== "" && fromNpm.trim() !== "undefined") {
    return fromNpm.trim();
  }
  return DEFAULT_REGISTRY;
}

/**
 * Join a path onto the registry base.
 *
 * A scoped name's `/` is written `%2f` (SPEC §5 step 3). That is required by
 * the dist-tags route and accepted by the manifest route, so both are built the
 * same way — one rule instead of two, and no chance of only one of them being
 * right for `@scope/name`.
 */
export function registryUrl(registry: string, ...parts: string[]): string {
  const base = registry.replace(/\/+$/, "");
  return `${base}/${parts.map((p) => p.replace(/\//g, "%2f")).join("/")}`;
}

/** Everything that went wrong talking to the registry, as one reportable error. */
export class RegistryError extends Error {
  readonly url: string;
  constructor(url: string, message: string) {
    super(message);
    this.url = url;
  }
}

async function getJson<T>(url: string, o: RegistryOptions): Promise<T> {
  const doFetch = o.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      signal: AbortSignal.timeout(o.timeoutMs ?? REGISTRY_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
  } catch (err) {
    const why =
      (err as { name?: string }).name === "TimeoutError" || (err as { name?: string }).name === "AbortError"
        ? `no answer within ${(o.timeoutMs ?? REGISTRY_TIMEOUT_MS) / 1000} seconds`
        : ((err as { message?: string }).message ?? String(err));
    throw new RegistryError(url, `could not reach the registry: ${why}`);
  }
  if (res.status === 404) throw new RegistryError(url, "the registry has no such package or version");
  if (!res.ok) throw new RegistryError(url, `the registry answered HTTP ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new RegistryError(url, "the registry's answer was not JSON");
  }
}

/** `{ latest: "0.81.0", next: "0.82.0-rc.1" }`. */
export async function fetchDistTags(o: RegistryOptions): Promise<Record<string, string>> {
  const url = registryUrl(o.registry, "-", "package", o.packageName, "dist-tags");
  const body = await getJson<Record<string, unknown>>(url, o);
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") tags[k] = v;
  if (Object.keys(tags).length === 0) throw new RegistryError(url, "the registry listed no dist-tags");
  return tags;
}

export interface PackageManifest {
  name?: string;
  version?: string;
  engines?: { node?: string };
}

/** One version's manifest — read for `engines` (SPEC §5 step 3). */
export async function fetchManifest(
  o: RegistryOptions & { version: string },
): Promise<PackageManifest> {
  const url = registryUrl(o.registry, o.packageName, o.version);
  return getJson<PackageManifest>(url, o);
}

export interface ResolveTargetInput extends RegistryOptions {
  /** `--to <version|tag>`, or undefined for `latest`. */
  to?: string;
}

export interface ResolvedTarget {
  version: string;
  /** The dist-tag asked for, or null when `--to` named a version (schema field). */
  tag: string | null;
  engines: string | null;
}

/**
 * Turn `--to` (or its absence) into one concrete version, plus its `engines`.
 *
 * `--to` is a version or a dist-tag and the two are told apart by shape, not by
 * asking: anything that parses as a version is a version, everything else is a
 * tag. That ordering matters because a registry will happily serve a manifest
 * for a tag name as well, and resolving `--to next` as a literal version would
 * silently install whatever `next` pointed at while REPORTING the target as
 * "next".
 */
export async function resolveTarget(o: ResolveTargetInput): Promise<ResolvedTarget> {
  const { to } = o;
  let version: string;
  let tag: string | null;
  if (to === undefined) {
    const tags = await fetchDistTags(o);
    const latest = tags.latest;
    if (latest === undefined) {
      throw new RegistryError(
        registryUrl(o.registry, "-", "package", o.packageName, "dist-tags"),
        "the registry has no `latest` dist-tag for this package",
      );
    }
    version = latest;
    tag = "latest";
  } else if (/^v?\d+\.\d+\.\d+/.test(to.trim())) {
    version = to.trim().replace(/^v/, "");
    tag = null;
  } else {
    const tags = await fetchDistTags(o);
    const resolved = tags[to];
    if (resolved === undefined) {
      throw new RegistryError(
        registryUrl(o.registry, "-", "package", o.packageName, "dist-tags"),
        `no dist-tag \`${to}\` (the registry has: ${Object.keys(tags).sort().join(", ")})`,
      );
    }
    version = resolved;
    tag = to;
  }

  const manifest = await fetchManifest({ ...o, version });
  return { version, tag, engines: manifest.engines?.node ?? null };
}
