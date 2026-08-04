import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { encodePathForCli, type AdoptableSession } from "@herdctl/core";
import {
  AdoptableIndex,
  MIN_TRANSCRIPT_BYTES,
  SLASH_COMMAND_MAX_BYTES,
  type AdoptableFleet,
} from "../../src/adoptable.js";
import type { Project } from "../../src/projects.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

/**
 * Detection of importable native Claude Code chats (#588).
 *
 * Exercised against a REAL temp Claude home with real transcript folders, and a
 * fake engine that scans those folders exactly the way the real one does
 * (`<claudeHome>/projects/<encodePathForCli(cwd)>/`). That fidelity is the point:
 * the lossy encoding is what makes two different working directories share one
 * folder, which is the only way the same session can be offered twice — so a
 * fake keyed on the cwd STRING would make the de-dup test vacuous.
 */
describe("AdoptableIndex (#588)", () => {
  let tmp: string;
  let claudeHome: string;
  let stateDir: string;
  /** Every `listAdoptableSessions` call the index made, in order. */
  let calls: string[];
  let fleet: AdoptableFleet;

  beforeEach(async () => {
    tmp = await makeTmpDir("paddock-adoptable-");
    claudeHome = path.join(tmp, "claude-home");
    stateDir = path.join(tmp, "state");
    await fs.mkdir(path.join(claudeHome, "projects"), { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    calls = [];
    fleet = {
      async listAdoptableSessions(_agent, fromWorkingDir) {
        calls.push(fromWorkingDir ?? "");
        return scanLikeTheEngine(claudeHome, fromWorkingDir ?? "");
      },
    };
  });
  afterEach(async () => {
    await rmTmpDir(tmp);
  });

  const index = () => new AdoptableIndex(claudeHome, stateDir);

  /** A project record, with only the fields detection actually reads. */
  const project = (over: Partial<Project>): Project =>
    ({ slug: "p", dir: "/does/not/matter", workingDir: "/does/not/matter", ...over }) as Project;

  /** Write a transcript for `cwd` into the temp Claude home. */
  async function transcript(
    cwd: string,
    sessionId: string,
    opts: { firstUserText?: string; padTo?: number } = {},
  ): Promise<string> {
    const dir = path.join(claudeHome, "projects", encodePathForCli(cwd));
    await fs.mkdir(dir, { recursive: true });
    const lines = [
      JSON.stringify({
        type: "user",
        cwd,
        sessionId,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: opts.firstUserText ?? `work in ${cwd}` },
      }),
    ];
    let body = lines.join("\n") + "\n";
    // Pad with assistant turns until the file clears a target size, so a test can
    // put a session on either side of a threshold deliberately.
    let i = 0;
    while (opts.padTo !== undefined && Buffer.byteLength(body) < opts.padTo) {
      body +=
        JSON.stringify({
          type: "assistant",
          cwd,
          sessionId,
          message: { role: "assistant", content: [{ type: "text", text: `reply ${i++} ` + "x".repeat(200) }] },
        }) + "\n";
    }
    const file = path.join(dir, `${sessionId}.jsonl`);
    await fs.writeFile(file, body, "utf8");
    return file;
  }

  // --- matching heuristic ------------------------------------------------

  it("offers a NOTEBOOK project only its own working directory (exact cwd)", async () => {
    const own = path.join(tmp, "notes");
    await transcript(own, "own-1", { padTo: 600 });
    // Same BASENAME, different path: a notebook project must not claim it.
    await transcript(path.join(tmp, "elsewhere", "notes"), "other-1", { padTo: 600 });

    const summary = await index().adoptableFor(fleet, project({ workingDir: own }), "keeper-p");
    expect(summary.count).toBe(1);
    expect(summary.sources).toEqual([{ sourceCwd: own, sessionIds: ["own-1"] }]);
  });

  it("offers a REPO-BACKED project its own checkout PLUS same-named checkouts elsewhere", async () => {
    const own = path.join(tmp, "data", "projects", "acme-api", "acme-api");
    const laptop = path.join(tmp, "laptop", "code", "acme-api");
    const unrelated = path.join(tmp, "laptop", "code", "something-else");
    await transcript(own, "own-1", { padTo: 600 });
    await transcript(laptop, "laptop-1", { padTo: 600 });
    await transcript(laptop, "laptop-2", { padTo: 600 });
    await transcript(unrelated, "nope-1", { padTo: 600 });

    const summary = await index().adoptableFor(
      fleet,
      project({ workingDir: own, repo: "git@github.com:acme/acme-api.git" }),
      "keeper-p",
    );
    expect(summary.count).toBe(3);
    // ORIGIN FIRST: the external checkout leads, the project's own dir is last,
    // so a session offered by both is attributed to where it really lives.
    expect(summary.sources.map((s) => s.sourceCwd)).toEqual([laptop, own]);
    expect(summary.sources[0].sessionIds.sort()).toEqual(["laptop-1", "laptop-2"]);
  });

  it("matches by the repo's CHECKOUT name, not the project slug or dir name", async () => {
    // The user's clone is named after the repo; the project dir is not.
    const own = path.join(tmp, "data", "projects", "my-notes", "paddock");
    const laptop = path.join(tmp, "laptop", "paddock");
    await transcript(laptop, "laptop-1", { padTo: 600 });

    const summary = await index().adoptableFor(
      fleet,
      project({ slug: "my-notes", workingDir: own, repo: "https://github.com/edspencer/paddock" }),
      "keeper-my-notes",
    );
    expect(summary.sources.map((s) => s.sourceCwd)).toEqual([laptop]);
  });

  it("reads each folder's RECORDED cwd — never the (lossy, non-invertible) folder name", async () => {
    // `/a/b-c` and `/a/b/c` both encode to `-a-b-c`. Only the recorded cwd can
    // tell them apart, and only one of them is this project.
    const own = path.join(tmp, "w", "a", "b-c");
    const collides = path.join(tmp, "w", "a", "b", "c");
    expect(encodePathForCli(own)).toBe(encodePathForCli(collides));
    await transcript(own, "s-1", { padTo: 600 });

    const summary = await index().adoptableFor(fleet, project({ workingDir: own }), "keeper-p");
    expect(summary.count).toBe(1);
  });

  // --- de-duplication ----------------------------------------------------

  it("removes NOTHING in a clean run — every session is offered exactly once", async () => {
    const own = path.join(tmp, "data", "projects", "acme-api", "acme-api");
    const laptop = path.join(tmp, "laptop", "acme-api");
    await transcript(own, "own-1", { padTo: 600 });
    await transcript(laptop, "laptop-1", { padTo: 600 });

    const summary = await index().adoptableFor(
      fleet,
      project({ workingDir: own, repo: "/repos/acme-api.git" }),
      "keeper-p",
    );
    // The raw per-source totals and the de-duplicated total agree, i.e. the
    // de-dup was a no-op here. (Recorded deliberately: the "N shown as 2N"
    // report is NOT reproducible from distinct source directories.)
    const raw = (await scanLikeTheEngine(claudeHome, laptop)).length +
      (await scanLikeTheEngine(claudeHome, own)).length;
    expect(raw).toBe(2);
    expect(summary.count).toBe(2);
  });

  it("de-dups when two candidate cwds ENCODE to the same folder (the real vector)", async () => {
    // A repo-backed project whose own checkout and the user's clone collide under
    // the lossy encoding: one physical folder, reachable as two cwds. Without
    // de-dup its sessions are counted twice.
    const own = path.join(tmp, "w", "a", "b-c", "api");
    const laptop = path.join(tmp, "w", "a", "b", "c", "api");
    expect(encodePathForCli(own)).toBe(encodePathForCli(laptop));
    await transcript(own, "s-1", { padTo: 600 });
    await transcript(own, "s-2", { padTo: 600 });

    const summary = await index().adoptableFor(
      fleet,
      project({ workingDir: own, repo: "/repos/api.git" }),
      "keeper-p",
    );
    expect(summary.count).toBe(2);
    // One source, not two — the collision is resolved by the folder's REAL path,
    // before the engine is asked twice for the same files.
    expect(summary.sources).toHaveLength(1);
    expect(calls).toEqual([own]);
  });

  // --- noise filter ------------------------------------------------------

  it("withholds a transcript under MIN_TRANSCRIPT_BYTES, and says so", async () => {
    const own = path.join(tmp, "notes");
    const dir = path.join(claudeHome, "projects", encodePathForCli(own));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "empty-1.jsonl"), "", "utf8"); // the zero-byte case
    await transcript(own, "real-1", { padTo: 600 });

    const summary = await index().adoptableFor(fleet, project({ workingDir: own }), "keeper-p");
    expect(summary.count).toBe(1);
    expect(summary.filtered).toEqual([
      { sessionId: "empty-1", sourceCwd: own, reason: "too-small" },
    ]);
    expect(MIN_TRANSCRIPT_BYTES).toBe(256);
  });

  it("withholds a SMALL slash-command-only session but keeps one that went somewhere", async () => {
    const own = path.join(tmp, "notes");
    // Padded past MIN_TRANSCRIPT_BYTES so these test the SLASH-COMMAND rule and
    // not, accidentally, the size floor.
    await transcript(own, "mcp-only", { firstUserText: "/mcp", padTo: 600 });
    await transcript(own, "wrapped", {
      firstUserText: "<command-name>/status</command-name>",
      padTo: 600,
    });
    // An absolute PATH is not a slash command, however short the session.
    await transcript(own, "path-prompt", {
      firstUserText: "/data/projects/paddock needs a look",
      padTo: 600,
    });
    // Opens with a slash command, then a real conversation — must survive.
    await transcript(own, "long-one", {
      firstUserText: "/review the auth refactor",
      padTo: SLASH_COMMAND_MAX_BYTES + 1,
    });
    await transcript(own, "ordinary", { padTo: 600 });

    const summary = await index().adoptableFor(fleet, project({ workingDir: own }), "keeper-p");
    expect(summary.sources[0].sessionIds.sort()).toEqual([
      "long-one",
      "ordinary",
      "path-prompt",
    ]);
    expect(summary.filtered.map((f) => f.sessionId).sort()).toEqual(["mcp-only", "wrapped"]);
    expect(new Set(summary.filtered.map((f) => f.reason))).toEqual(
      new Set(["slash-command-only"]),
    );
  });

  it("withholds paddock's OWN sweeper runs, and says so (#658)", async () => {
    const own = path.join(tmp, "notes");
    // The current wording, and the older one it drifted from — both are real
    // prompts found in the dogfooding instance's transcript folder.
    await transcript(own, "sweep-now", {
      firstUserText:
        "Project: Paddock (slug: paddock)\n\n\nYou are curating this project's three context " +
        "files from recent chat activity. You are shown each file IN FULL",
      padTo: 6000,
    });
    await transcript(own, "sweep-old", {
      firstUserText:
        "Project: Paddock (slug: paddock)\nYou are curating two files in this project " +
        "directory based on recent chat activity",
      padTo: 6000,
    });
    // With a `Summary:` line between the header and the sentence.
    await transcript(own, "sweep-summary", {
      firstUserText:
        "Project: Acme (slug: acme)\nSummary: the acme thing\n\nYou are curating this " +
        "project's three context files",
      padTo: 6000,
    });
    // A real chat that merely TALKS about the sweeper must survive: the header
    // is absent, so the sentence alone is not enough.
    await transcript(own, "talks-about-it", {
      firstUserText: "You are curating the wrong files — can you look at why the sweeper does that?",
      padTo: 6000,
    });
    // The header alone is not enough either.
    await transcript(own, "header-only", {
      firstUserText: "Project: Paddock (slug: paddock) — what's left to do before the release?",
      padTo: 6000,
    });

    const summary = await index().adoptableFor(fleet, project({ workingDir: own }), "keeper-p");
    expect(summary.sources[0].sessionIds.sort()).toEqual(["header-only", "talks-about-it"]);
    expect(summary.filtered.map((f) => f.sessionId).sort()).toEqual([
      "sweep-now",
      "sweep-old",
      "sweep-summary",
    ]);
    expect(new Set(summary.filtered.map((f) => f.reason))).toEqual(new Set(["sweeper-run"]));
    // Withheld, not silently dropped — `filtered` is what answers "why 2 and
    // not 5?", and #660's preview dialog renders it.
    expect(summary.count).toBe(2);
  });

  it("withholds a sweeper run that is far too big to be caught by any other rule", async () => {
    // Guards the ordering in `filterReasonFor`: a curation transcript is a large
    // file, so neither the size floor nor the slash-command ceiling would ever
    // reach it. Only the sweeper rule can.
    const own = path.join(tmp, "notes");
    await transcript(own, "big-sweep", {
      firstUserText: "Project: Paddock (slug: paddock)\n\n\nYou are curating this project's three",
      padTo: SLASH_COMMAND_MAX_BYTES * 4,
    });
    const summary = await index().adoptableFor(fleet, project({ workingDir: own }), "keeper-p");
    expect(summary.count).toBe(0);
    expect(summary.filtered).toEqual([
      { sessionId: "big-sweep", sourceCwd: own, reason: "sweeper-run" },
    ]);
  });

  it("reports count 0 with empty sources when there is nothing to import", async () => {
    const summary = await index().adoptableFor(
      fleet,
      project({ workingDir: path.join(tmp, "fresh") }),
      "keeper-p",
    );
    expect(summary).toEqual({ count: 0, sources: [], filtered: [] });
  });

  // --- caching -----------------------------------------------------------

  it("caches per project and re-scans only when a transcript DIRECTORY changes", async () => {
    const own = path.join(tmp, "notes");
    await transcript(own, "s-1", { padTo: 600 });
    const idx = index();

    expect((await idx.adoptableFor(fleet, project({ workingDir: own }), "keeper-p")).count).toBe(1);
    const afterFirst = calls.length;

    // Nothing moved → served from cache, engine untouched.
    expect((await idx.adoptableFor(fleet, project({ workingDir: own }), "keeper-p")).count).toBe(1);
    expect(calls.length).toBe(afterFirst);

    // Appending to an existing transcript CANNOT change what is adoptable, and
    // does not change the directory's mtime — the cache is right to hold.
    await fs.appendFile(
      path.join(claudeHome, "projects", encodePathForCli(own), "s-1.jsonl"),
      JSON.stringify({ type: "user", cwd: own, message: { role: "user", content: "more" } }) + "\n",
    );
    expect((await idx.adoptableFor(fleet, project({ workingDir: own }), "keeper-p")).count).toBe(1);
    expect(calls.length).toBe(afterFirst);

    // A NEW transcript changes the directory's mtime → recompute.
    await transcript(own, "s-2", { padTo: 600 });
    expect((await idx.adoptableFor(fleet, project({ workingDir: own }), "keeper-p")).count).toBe(2);
    expect(calls.length).toBeGreaterThan(afterFirst);
  });

  it("invalidate() forces a recompute, and accepts the ROOT workspace's empty key", async () => {
    const own = path.join(tmp, "notes");
    await transcript(own, "s-1", { padTo: 600 });
    const idx = index();
    const root = project({ slug: "", workingDir: own });

    await idx.adoptableFor(fleet, root, "keeper-_root");
    const afterFirst = calls.length;
    await idx.adoptableFor(fleet, root, "keeper-_root");
    expect(calls.length).toBe(afterFirst);

    // `""` is a real key, not "no key" — `if (!slug)` here would clear every
    // project's cache instead of the root's (#531).
    idx.invalidate("");
    await idx.adoptableFor(fleet, root, "keeper-_root");
    expect(calls.length).toBeGreaterThan(afterFirst);
  });
});

/**
 * Scan a working directory's transcript folder the way `SessionDiscoveryService`
 * does: resolve `<claudeHome>/projects/<encodePathForCli(cwd)>` and list its
 * `.jsonl` files. No sidechain/adoption/attribution filtering — those are the
 * engine's own exclusions and are not what this module is responsible for.
 */
async function scanLikeTheEngine(
  claudeHome: string,
  fromWorkingDir: string,
): Promise<AdoptableSession[]> {
  const dir = path.join(claudeHome, "projects", encodePathForCli(fromWorkingDir));
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const out: AdoptableSession[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const file = path.join(dir, entry);
    const st = await fs.stat(file);
    const head = (await fs.readFile(file, "utf8")).split("\n")[0];
    let preview: string | undefined;
    try {
      const content = (JSON.parse(head) as { message?: { content?: unknown } }).message?.content;
      // Truncated at 100 chars + "…" exactly as `extractFirstMessagePreview` does.
      // Fidelity that matters: the sweeper-run rule (#658) has to match inside
      // that budget, and a fake handing over the untruncated prompt would prove
      // nothing about whether it does.
      if (typeof content === "string") {
        preview = content.length > 100 ? `${content.substring(0, 100)}...` : content;
      }
    } catch {
      preview = undefined;
    }
    out.push({
      sessionId: entry.replace(/\.jsonl$/, ""),
      sourceCwd: fromWorkingDir,
      mtime: st.mtime.toISOString(),
      autoName: undefined,
      preview,
      sizeBytes: st.size,
    });
  }
  return out;
}
