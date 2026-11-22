/**
 * ListOrderStore — a Paddock-side sidecar for how the sidebar's two lists are
 * ordered: each workspace's chat list, and the left nav's project list.
 *
 * Each list has a sort MODE — `recent` (most recent reply, the default),
 * `created`, or `manual` — plus, for `manual`, the user's drag order. The order
 * is stored per GROUP, because both lists are grouped:
 *
 *  - A chat list's groups are its sibling groups. The client composes the key
 *    as `<population>:<layout>:<parentId>` (e.g. `active:nested:` for the top
 *    level, `archived:flat:`), and the only part this store relies on is the
 *    LAST colon-separated segment: the parent session id, `""` at the top
 *    level. That is what lets a chat delete drop the group of a parent that no
 *    longer exists (see {@link ListOrderStore.forgetChats}).
 *  - The project list's groups are areas, keyed by the area slug (`""` is
 *    Unsorted).
 *
 * Instance-wide rather than per-user, like the archive and star flags: the order
 * follows the user across devices. The ordering itself happens in the client;
 * this only persists what the client sends, after validating its shape.
 *
 * The same lazy-load / write-through / serialised-write sidecar pattern as
 * {@link import("./star.js").StarStore}. A list back at its default (mode
 * `recent`, no manual groups) is deleted, keeping the file compact.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_FILE = "list-order.json";

/** Every sort mode, as values — the source of both the type and the allowlist. */
export const SORT_MODES = ["recent", "created", "manual"] as const;
export type SortMode = (typeof SORT_MODES)[number];

/** Bounds on a PATCH body, so a buggy or hostile client cannot grow the file without limit. */
export const MAX_GROUPS = 1000;
export const MAX_IDS_PER_GROUP = 5000;
const MAX_KEY_LENGTH = 512;

/** JSON schema of a {@link ListOrder} (and of a patch body), for the routes' OpenAPI entries. */
export const LIST_ORDER_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    mode: { type: "string", enum: [...SORT_MODES] },
    orders: { type: "object", additionalProperties: true },
  },
} as const;

/** One list's persisted ordering. */
export interface ListOrder {
  mode: SortMode;
  /** Manual order per group key; groups never placed are absent. */
  orders: Record<string, string[]>;
}

/** A partial update: set the mode, replace some groups, and delete others (`null`). */
export interface ListOrderPatch {
  mode?: SortMode;
  orders?: Record<string, string[] | null>;
}

interface State {
  /** Chat lists, keyed by workspace slug (`""` is the root). */
  chats: Map<string, ListOrder>;
  projects: ListOrder;
}

/** A malformed PATCH body. Routes map it to a 400. */
export class ListOrderError extends Error {}

const defaultOrder = (): ListOrder => ({ mode: "recent", orders: {} });

const isDefault = (o: ListOrder) => o.mode === "recent" && Object.keys(o.orders).length === 0;

const copy = (o: ListOrder): ListOrder => ({
  mode: o.mode,
  orders: Object.fromEntries(Object.entries(o.orders).map(([k, v]) => [k, [...v]])),
});

/** Coerce a value read from disk; anything unrecognisable reads as the default. */
function coerce(raw: unknown): ListOrder {
  if (!raw || typeof raw !== "object") return defaultOrder();
  const r = raw as { mode?: unknown; orders?: unknown };
  const mode = SORT_MODES.includes(r.mode as SortMode) ? (r.mode as SortMode) : "recent";
  const orders: Record<string, string[]> = {};
  if (r.orders && typeof r.orders === "object") {
    for (const [k, v] of Object.entries(r.orders as Record<string, unknown>)) {
      if (Array.isArray(v)) orders[k] = v.filter((id): id is string => typeof id === "string");
    }
  }
  return { mode, orders };
}

/**
 * Validate a PATCH body into a {@link ListOrderPatch}, or throw
 * {@link ListOrderError}. Ids are de-duplicated, first occurrence wins.
 */
export function parseListOrderPatch(body: unknown): ListOrderPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ListOrderError("body must be an object `{ mode?, orders? }`");
  }
  const b = body as { mode?: unknown; orders?: unknown };
  const patch: ListOrderPatch = {};
  if (b.mode !== undefined) {
    if (!SORT_MODES.includes(b.mode as SortMode)) {
      throw new ListOrderError(`mode must be one of ${SORT_MODES.join(", ")}`);
    }
    patch.mode = b.mode as SortMode;
  }
  if (b.orders !== undefined) {
    if (!b.orders || typeof b.orders !== "object" || Array.isArray(b.orders)) {
      throw new ListOrderError("orders must be an object of group key -> id array (or null)");
    }
    const entries = Object.entries(b.orders as Record<string, unknown>);
    if (entries.length > MAX_GROUPS) {
      throw new ListOrderError(`orders may update at most ${MAX_GROUPS} groups at once`);
    }
    const orders: Record<string, string[] | null> = {};
    for (const [key, ids] of entries) {
      if (key.length > MAX_KEY_LENGTH) throw new ListOrderError("group key too long");
      if (ids === null) {
        orders[key] = null;
        continue;
      }
      if (
        !Array.isArray(ids) ||
        ids.length > MAX_IDS_PER_GROUP ||
        !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_KEY_LENGTH)
      ) {
        throw new ListOrderError(
          `orders["${key}"] must be null or an array of at most ` +
            `${MAX_IDS_PER_GROUP} non-empty strings`,
        );
      }
      orders[key] = [...new Set(ids as string[])];
    }
    patch.orders = orders;
  }
  return patch;
}

/** Apply a patch to one list in place. */
function applyPatch(o: ListOrder, patch: ListOrderPatch): void {
  if (patch.mode) o.mode = patch.mode;
  for (const [key, ids] of Object.entries(patch.orders ?? {})) {
    if (ids === null || ids.length === 0) delete o.orders[key];
    else o.orders[key] = ids;
  }
}

/** Is `slug` the workspace `of`, or nested beneath it? */
const withinWorkspace = (slug: string, of: string) => slug === of || slug.startsWith(`${of}/`);

export class ListOrderStore {
  private readonly stateFile: string;
  private state: State | null = null;
  /** The in-flight load, shared by concurrent first callers (see StarStore). */
  private loadPromise: Promise<State> | null = null;
  /** Serialises concurrent writes so the file never interleaves. */
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.stateFile = path.join(dataDir, STATE_FILE);
  }

  private ensureLoaded(): Promise<State> {
    if (this.state) return Promise.resolve(this.state);
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const state: State = { chats: new Map(), projects: defaultOrder() };
        try {
          const parsed = JSON.parse(await fs.readFile(this.stateFile, "utf8")) as unknown;
          if (parsed && typeof parsed === "object") {
            const p = parsed as { chats?: unknown; projects?: unknown };
            if (p.chats && typeof p.chats === "object") {
              for (const [slug, raw] of Object.entries(p.chats as Record<string, unknown>)) {
                state.chats.set(slug, coerce(raw));
              }
            }
            state.projects = coerce(p.projects);
          }
        } catch {
          /* missing or unreadable — start empty */
        }
        this.state = state;
        return state;
      })();
    }
    return this.loadPromise;
  }

  /** A workspace's chat-list order. Non-throwing: a load error reads as the default. */
  async getChatOrder(slug: string): Promise<ListOrder> {
    const state = await this.ensureLoaded().catch(() => null);
    const o = state?.chats.get(slug);
    return o ? copy(o) : defaultOrder();
  }

  /** Apply a patch to a workspace's chat-list order; returns the result. */
  async patchChatOrder(slug: string, patch: ListOrderPatch): Promise<ListOrder> {
    const state = await this.ensureLoaded();
    const o = state.chats.get(slug) ?? defaultOrder();
    applyPatch(o, patch);
    if (isDefault(o)) state.chats.delete(slug);
    else state.chats.set(slug, o);
    await this.persist(state);
    return copy(o);
  }

  /** The project list's order. Non-throwing: a load error reads as the default. */
  async getProjectOrder(): Promise<ListOrder> {
    const state = await this.ensureLoaded().catch(() => null);
    return state ? copy(state.projects) : defaultOrder();
  }

  /** Apply a patch to the project list's order; returns the result. */
  async patchProjectOrder(patch: ListOrderPatch): Promise<ListOrder> {
    const state = await this.ensureLoaded();
    applyPatch(state.projects, patch);
    await this.persist(state);
    return copy(state.projects);
  }

  /**
   * Drop deleted chats from a workspace's chat order: each id leaves every group
   * it was placed in, and the group of children it parented goes too (a group
   * key whose last segment is the id). A recycled id must not inherit a slot.
   */
  async forgetChats(slug: string, sessionIds: readonly string[]): Promise<void> {
    const state = await this.ensureLoaded();
    const o = state.chats.get(slug);
    if (!o || sessionIds.length === 0) return;
    const gone = new Set(sessionIds);
    let changed = false;
    for (const [key, ids] of Object.entries(o.orders)) {
      if (gone.has(key.slice(key.lastIndexOf(":") + 1))) {
        delete o.orders[key];
        changed = true;
        continue;
      }
      const kept = ids.filter((id) => !gone.has(id));
      if (kept.length === ids.length) continue;
      changed = true;
      if (kept.length === 0) delete o.orders[key];
      else o.orders[key] = kept;
    }
    if (!changed) return;
    if (isDefault(o)) state.chats.delete(slug);
    await this.persist(state);
  }

  /**
   * Drop a deleted project — and every project nested inside it, which the
   * directory delete takes with it — from both lists: its own chat order, and
   * its slot in the project order.
   */
  async forgetProject(slug: string): Promise<void> {
    const state = await this.ensureLoaded();
    let changed = false;
    for (const key of [...state.chats.keys()]) {
      if (withinWorkspace(key, slug)) {
        state.chats.delete(key);
        changed = true;
      }
    }
    for (const [area, slugs] of Object.entries(state.projects.orders)) {
      const kept = slugs.filter((s) => !withinWorkspace(s, slug));
      if (kept.length === slugs.length) continue;
      changed = true;
      if (kept.length === 0) delete state.projects.orders[area];
      else state.projects.orders[area] = kept;
    }
    if (changed) await this.persist(state);
  }

  /** Write-through, serialised so overlapping updates can't corrupt the file. */
  private persist(state: State): Promise<void> {
    this.writing = this.writing.then(async () => {
      const json = JSON.stringify(
        { chats: Object.fromEntries(state.chats), projects: state.projects },
        null,
        2,
      );
      await fs.writeFile(this.stateFile, json, "utf8").catch(() => undefined);
    });
    return this.writing;
  }
}
