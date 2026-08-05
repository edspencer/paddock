/**
 * The `mcpServers:` block of `paddock.config.yaml` (#691 step 6) — declaring an
 * MCP server to paddock itself rather than borrowing the machine's.
 *
 * Two things are being pinned here and they pull in opposite directions:
 *
 *  1. **A declaration paddock cannot carry is refused, not degraded.** Step 5
 *     passes a host server with a warning; this file the user typed at us, so a
 *     `headers:` block that would be silently dropped downstream is an error and
 *     the server is not attached.
 *  2. **No value from the block ever reaches a string paddock emits.** Every
 *     error, warning and notice is asserted against the literal secret, because
 *     a leak here is a token in a log file.
 *
 * Every fixture is synthetic. `SECRET` is a made-up string that exists only in
 * this file, which is what lets the leak assertions be exact rather than
 * approximate.
 */
import { describe, it, expect } from "vitest";
import {
  resolveDeclaredMcpServers,
  declaredMcpNotices,
  describeServer,
  redactUrl,
  RESERVED_MCP_SERVER_NAMES,
  ENV_REF_PREFIX,
} from "../../src/mcp-servers.js";
import { SEND_FILE_SERVER_KEY } from "../../src/send-file-mcp.js";
import { SELF_MCP_SERVER_KEY } from "../../src/self-mcp.js";

/** A value that must never appear in anything paddock says out loud. */
const SECRET = "ntn_totally-fake-secret-9f3a2b";

const NO_ENV: Record<string, string | undefined> = {};

describe("mcpServers: the shape that reaches the runtime", () => {
  it("carries a stdio server through unchanged", () => {
    const { servers, errors, warnings } = resolveDeclaredMcpServers(
      {
        notion: {
          command: "npx",
          args: ["-y", "@notionhq/notion-mcp-server"],
          env: { NOTION_VERSION: "2022-06-28" },
        },
      },
      NO_ENV,
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(servers).toEqual({
      notion: {
        command: "npx",
        args: ["-y", "@notionhq/notion-mcp-server"],
        env: { NOTION_VERSION: "2022-06-28" },
      },
    });
  });

  it("carries a url server, and accepts a `type` that agrees with it", () => {
    const { servers, errors } = resolveDeclaredMcpServers(
      { linear: { url: "https://mcp.example.test/mcp", type: "http" } },
      NO_ENV,
    );
    expect(errors).toEqual([]);
    // `type` is not a field herdctl's schema has, so it is consumed here rather
    // than passed on to be stripped downstream.
    expect(servers).toEqual({ linear: { url: "https://mcp.example.test/mcp" } });
  });

  it("ignores an absent block entirely", () => {
    expect(resolveDeclaredMcpServers(undefined, NO_ENV)).toEqual({
      servers: {},
      errors: [],
      warnings: [],
    });
  });
});

describe("mcpServers: what is refused, and why refusing beats degrading", () => {
  /**
   * The case the brief singles out. herdctl's `McpServerSchema` has no `headers`
   * field, so a bearer-authenticated server would arrive unauthenticated — and
   * its stored OAuth token, keyed on a hash that includes the headers, would not
   * be found either. Step 5 warns and passes it; a hand-written declaration gets
   * an error, because the user typed the header and can act on being told it does
   * nothing.
   */
  it("refuses `headers`, naming the header keys and never their values", () => {
    const { servers, errors } = resolveDeclaredMcpServers(
      {
        notion: {
          url: "https://mcp.example.test/mcp",
          headers: { Authorization: `Bearer ${SECRET}` },
        },
      },
      NO_ENV,
    );
    expect(servers).toEqual({});
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Authorization");
    expect(errors[0]).toContain("not attached");
    expect(errors.join("\n")).not.toContain(SECRET);
  });

  it("refuses `type: sse`, which would otherwise be silently connected to as HTTP", () => {
    const { servers, errors } = resolveDeclaredMcpServers(
      { legacy: { url: "https://mcp.example.test/sse", type: "sse" } },
      NO_ENV,
    );
    expect(servers).toEqual({});
    expect(errors[0]).toContain("sse");
  });

  /**
   * The only defence against a typo. `arg:` for `args:` would otherwise produce a
   * server that starts with the wrong argv and no indication why — which is
   * exactly the failure mode this whole issue exists to stop.
   */
  it("refuses an unrecognised key rather than dropping it silently", () => {
    const { servers, errors } = resolveDeclaredMcpServers(
      { notion: { command: "npx", arg: ["-y"] } as Record<string, unknown> },
      NO_ENV,
    );
    expect(servers).toEqual({});
    expect(errors[0]).toContain("arg");
  });

  it("refuses a declaration with neither a command nor a url, and one with both", () => {
    const neither = resolveDeclaredMcpServers({ x: { args: ["--stdio"] } }, NO_ENV);
    expect(neither.servers).toEqual({});
    expect(neither.errors[0]).toContain("nothing to start");
    const both = resolveDeclaredMcpServers(
      { x: { command: "npx", url: "https://mcp.example.test/mcp" } },
      NO_ENV,
    );
    expect(both.servers).toEqual({});
    expect(both.errors[0]).toContain("one or the other");
  });

  /**
   * Two servers cannot share one `mcp__<name>__*` namespace, and paddock's own
   * are materialised by a different mechanism (an in-process HTTP bridge), so the
   * collision has no defined winner. Refuse it at config time instead.
   */
  it("refuses a name paddock injects itself", () => {
    for (const name of RESERVED_MCP_SERVER_NAMES) {
      const { servers, errors } = resolveDeclaredMcpServers({ [name]: { command: "x" } }, NO_ENV);
      expect(servers).toEqual({});
      expect(errors[0]).toContain("reserved");
    }
  });

  it("keeps the reserved list in step with the servers paddock actually injects", () => {
    // The list is duplicated as literals so config resolution stays free of the
    // runtime modules; this is the assertion that pays for that.
    expect([...RESERVED_MCP_SERVER_NAMES].sort()).toEqual(
      [SEND_FILE_SERVER_KEY, SELF_MCP_SERVER_KEY].sort(),
    );
  });

  it("refuses a name that could not produce a working allowlist pattern", () => {
    const { servers, errors } = resolveDeclaredMcpServers(
      { "my server": { command: "x" } },
      NO_ENV,
    );
    expect(servers).toEqual({});
    expect(errors[0]).toContain("mcp__my server__<tool>");
  });

  /** One bad server must not take the instance — or the other servers — down. */
  it("drops only the offending server", () => {
    const { servers, errors } = resolveDeclaredMcpServers(
      { good: { command: "ok-mcp" }, bad: { url: "https://x.test", type: "sse" } },
      NO_ENV,
    );
    expect(Object.keys(servers)).toEqual(["good"]);
    expect(errors).toHaveLength(1);
  });
});

describe("mcpServers: secrets", () => {
  /**
   * The indirection `management-config.ts` already sets for management tokens,
   * generalised: `env:VAR_NAME` works anywhere a string does, so there is one
   * rule rather than a list of blessed fields.
   */
  it("resolves an `env:VAR_NAME` reference from the environment", () => {
    const { servers, errors, warnings } = resolveDeclaredMcpServers(
      { notion: { command: "npx", env: { NOTION_TOKEN: `${ENV_REF_PREFIX}NOTION_TOKEN` } } },
      { NOTION_TOKEN: SECRET },
    );
    expect(errors).toEqual([]);
    // No advice warning: a reference is the recommended form, so it is silent.
    expect(warnings).toEqual([]);
    expect(servers.notion.env).toEqual({ NOTION_TOKEN: SECRET });
  });

  it("resolves references in args, command and url too", () => {
    const { servers } = resolveDeclaredMcpServers(
      {
        a: { command: `${ENV_REF_PREFIX}BIN`, args: [`${ENV_REF_PREFIX}KEYARG`] },
        b: { url: `${ENV_REF_PREFIX}ENDPOINT` },
      },
      { BIN: "/opt/mcp/serve", KEYARG: `--key=${SECRET}`, ENDPOINT: `https://x.test/?k=${SECRET}` },
    );
    expect(servers.a).toEqual({ command: "/opt/mcp/serve", args: [`--key=${SECRET}`] });
    expect(servers.b).toEqual({ url: `https://x.test/?k=${SECRET}` });
  });

  /**
   * Fail closed, the same direction `management-config.ts` drops a client whose
   * variable is unset: a server started without the credential it was declared
   * with either fails every call confusingly or — worse, for something that talks
   * to a third party — connects unauthenticated.
   */
  it("drops the server when a referenced variable is unset, naming the variable", () => {
    const { servers, warnings } = resolveDeclaredMcpServers(
      { notion: { command: "npx", env: { NOTION_TOKEN: `${ENV_REF_PREFIX}NOTION_TOKEN` } } },
      {},
    );
    expect(servers).toEqual({});
    expect(warnings[0]).toContain("NOTION_TOKEN is unset or empty");
    expect(warnings[0]).toContain("not attached");
  });

  /**
   * An inline value is a WARNING, not the hard error `managementApi` uses for an
   * inline token — because unlike `auth.token`, an MCP `env` entry is not
   * necessarily a secret (`NOTION_VERSION` is not) and paddock is guessing from
   * the key's name. Guessing wrong must not refuse a working config.
   */
  it("warns about an inlined credential without printing it", () => {
    const { servers, errors, warnings } = resolveDeclaredMcpServers(
      { notion: { command: "npx", env: { NOTION_TOKEN: SECRET, NOTION_VERSION: "2022-06-28" } } },
      NO_ENV,
    );
    expect(errors).toEqual([]);
    // Attached anyway: the operator's config works, they are told to move it.
    expect(servers.notion.env).toEqual({ NOTION_TOKEN: SECRET, NOTION_VERSION: "2022-06-28" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("NOTION_TOKEN");
    expect(warnings[0]).toContain(`${ENV_REF_PREFIX}VAR_NAME`);
    expect(warnings[0]).not.toContain(SECRET);
    // …and the non-secret-looking sibling is not nagged about.
    expect(warnings[0]).not.toContain("NOTION_VERSION");
  });

  it("warns about a credential riding in a url's query string, without echoing it", () => {
    const { servers, warnings } = resolveDeclaredMcpServers(
      { remote: { url: `https://mcp.example.test/mcp?apiKey=${SECRET}` } },
      NO_ENV,
    );
    expect(servers.remote.url).toContain(SECRET); // it still reaches the server
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(SECRET);
  });

  /**
   * THE leak test. Take a declaration that is secret in every place a secret can
   * hide, run everything paddock would emit about it, and assert the value is in
   * none of it. `describeServer` is the one function that renders a server for a
   * human, so this is also what pins that it stays the only one.
   */
  it("emits nothing containing a secret, from any diagnostic or notice", () => {
    const { servers, errors, warnings } = resolveDeclaredMcpServers(
      {
        stdio: {
          command: `/opt/${SECRET}/serve`,
          args: [`--token=${SECRET}`],
          env: { API_KEY: SECRET },
        },
        remote: { url: `https://user:${SECRET}@mcp.example.test/mcp?key=${SECRET}` },
      },
      NO_ENV,
    );
    const notices = declaredMcpNotices({ servers, hostNames: ["stdio"], browserMcp: true });
    const everythingSaid = [...errors, ...warnings, ...notices.map((n) => n.message)].join("\n");
    expect(everythingSaid).not.toContain(SECRET);
    // …and it is not vacuous: the servers WERE described, by name.
    expect(everythingSaid).toContain("stdio");
    expect(everythingSaid).toContain("remote");
  });

  it("describeServer counts args and env entries rather than printing them", () => {
    const line = describeServer("notion", {
      command: "npx",
      args: [`--token=${SECRET}`, "-y"],
      env: { API_KEY: SECRET },
    });
    expect(line).toBe("notion (stdio: npx, 2 args, 1 env entry)");
  });

  it("redactUrl strips query, fragment and userinfo", () => {
    expect(redactUrl(`https://u:${SECRET}@host.test/mcp?key=${SECRET}#f`)).toBe(
      "https://<redacted>@host.test/mcp?<redacted>",
    );
    expect(redactUrl("https://host.test/mcp")).toBe("https://host.test/mcp");
    expect(redactUrl(`not a url ${SECRET}`)).toBe("<unparseable url>");
  });
});

describe("mcpServers: what the boot log says", () => {
  it("says nothing at all when nothing is declared", () => {
    expect(declaredMcpNotices({ servers: {} })).toEqual([]);
  });

  it("names each declared server, and flags the ones it shadows", () => {
    const notices = declaredMcpNotices({
      servers: { notion: { command: "npx" } },
      hostNames: ["notion", "pg"],
    });
    expect(notices[0].message).toContain("notion (stdio: npx)");
    expect(notices[1].message).toContain("this instance's own declaration wins");
    // `pg` is inherited but not shadowed, so it is not named as a collision.
    expect(notices[1].message).not.toContain("pg");
  });

  /**
   * The one collision paddock's own side wins, so it must not be silent — an
   * operator who declared `playwright` would otherwise see their flags ignored
   * with no explanation.
   */
  it("warns when a declaration collides with the browser server, which wins", () => {
    const notices = declaredMcpNotices({
      servers: { playwright: { command: "my-playwright" } },
      browserMcp: true,
    });
    expect(notices.some((n) => n.level === "warn" && n.message.includes("WINS"))).toBe(true);
    // …and does not warn when the browser server is not attached at all.
    expect(
      declaredMcpNotices({ servers: { playwright: { command: "my-playwright" } } }).some(
        (n) => n.level === "warn",
      ),
    ).toBe(false);
  });
});
