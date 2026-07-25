/**
 * Unit tests for `managementApi.clients` resolution (#312 M1).
 *
 * The two behaviours worth guarding hardest:
 *  - an INLINE secret in the git-tracked config file is a hard error, never a
 *    silently-accepted convenience;
 *  - an unresolvable credential DROPS its client (fail closed) rather than
 *    booting a client with no/short token.
 */
import { describe, it, expect } from "vitest";
import {
  resolveManagementApiConfig,
  resolveClientScope,
  tokenInstanceId,
  TOKEN_PREFIX,
  MIN_TOKEN_LENGTH,
  type ManagementApiConfigFile,
} from "../../src/management-config.js";
import { DEFAULT_READ_ONLY_SCOPE, grantsTurnSpawning } from "../../src/management-policy.js";

/** A token that passes the length floor, optionally bound to an instance. */
const tok = (instance?: string): string =>
  instance ? `${TOKEN_PREFIX}${instance}_${"a".repeat(40)}` : "z".repeat(40);

const file = (clients: ManagementApiConfigFile["clients"], instanceId?: string) =>
  ({ ...(instanceId ? { instanceId } : {}), clients }) as ManagementApiConfigFile;

describe("resolveManagementApiConfig — the happy path", () => {
  it("resolves a client from an env reference and defaults it to read-only", () => {
    const { config, errors } = resolveManagementApiConfig(
      file({ "my-laptop": { auth: { type: "token", ref: "env:TOK" } } }),
      { TOK: tok() },
    );
    expect(errors).toEqual([]);
    expect(config.clients).toHaveLength(1);
    expect(config.clients[0].clientId).toBe("my-laptop");
    expect(config.clients[0].token).toBe(tok());
    expect(config.clients[0].scope).toEqual(DEFAULT_READ_ONLY_SCOPE);
    expect(grantsTurnSpawning(config.clients[0].scope)).toBe(false);
  });

  it("defaults auth.type to token when omitted", () => {
    const { config, errors } = resolveManagementApiConfig(
      file({ c: { auth: { ref: "env:TOK" } } }),
      { TOK: tok() },
    );
    expect(errors).toEqual([]);
    expect(config.clients).toHaveLength(1);
  });

  it("resolves an explicit wider scope", () => {
    const { config } = resolveManagementApiConfig(
      file({
        c: {
          auth: { ref: "env:TOK" },
          scope: { projects: ["paddock"], allow: ["list_*", "create_chat"], maxSpawnDepth: 2 },
        },
      }),
      { TOK: tok() },
    );
    expect(config.clients[0].scope.projects).toEqual(["paddock"]);
    expect(config.clients[0].scope.maxSpawnDepth).toBe(2);
    expect(grantsTurnSpawning(config.clients[0].scope)).toBe(true);
  });

  it("warns loudly when a scope grants code execution", () => {
    const { warnings } = resolveManagementApiConfig(
      file({ c: { auth: { ref: "env:TOK" }, scope: { allow: ["send_message"] } } }),
      { TOK: tok() },
    );
    expect(warnings.some((w) => w.includes("run code on this host"))).toBe(true);
  });
});

describe("resolveManagementApiConfig — rejected configuration", () => {
  it("rejects an inline token", () => {
    const { config, errors } = resolveManagementApiConfig(
      file({ c: { auth: { type: "token", token: "supersecretvalue" } } }),
      {},
    );
    expect(config.clients).toEqual([]);
    expect(errors[0]).toContain("inline token material is not allowed");
  });

  it("rejects an inline secret under any spelling", () => {
    const { config, errors } = resolveManagementApiConfig(
      file({ c: { auth: { secret: "supersecretvalue" } } }),
      {},
    );
    expect(config.clients).toEqual([]);
    expect(errors[0]).toContain("inline token material");
  });

  it("rejects a non-env ref", () => {
    const { config, errors } = resolveManagementApiConfig(
      file({ c: { auth: { ref: "file:/etc/secret" } } }),
      {},
    );
    expect(config.clients).toEqual([]);
    expect(errors[0]).toContain("env:VAR_NAME");
  });

  it("rejects an unsupported auth type", () => {
    const { config, errors } = resolveManagementApiConfig(
      file({ c: { auth: { type: "oauth", ref: "env:TOK" } } }),
      { TOK: tok() },
    );
    expect(config.clients).toEqual([]);
    expect(errors[0]).toContain("unsupported type");
  });

  it("rejects a missing ref", () => {
    const { errors } = resolveManagementApiConfig(file({ c: { auth: {} } }), {});
    expect(errors[0]).toContain("auth.ref");
  });
});

describe("resolveManagementApiConfig — fail-closed drops", () => {
  it("drops a client whose env var is unset", () => {
    const { config, warnings } = resolveManagementApiConfig(
      file({ c: { auth: { ref: "env:NOPE" } } }),
      {},
    );
    expect(config.clients).toEqual([]);
    expect(warnings[0]).toContain("unset or empty");
  });

  it("drops a client whose token is too short", () => {
    const { config, warnings } = resolveManagementApiConfig(
      file({ c: { auth: { ref: "env:TOK" } } }),
      { TOK: "short" },
    );
    expect(config.clients).toEqual([]);
    expect(warnings[0]).toContain(`${MIN_TOKEN_LENGTH} characters`);
  });

  it("keeps working clients when a sibling drops", () => {
    const { config, warnings } = resolveManagementApiConfig(
      file({
        good: { auth: { ref: "env:TOK" } },
        bad: { auth: { ref: "env:MISSING" } },
      }),
      { TOK: tok() },
    );
    expect(config.clients.map((c) => c.clientId)).toEqual(["good"]);
    expect(warnings.some((w) => w.includes("client disabled"))).toBe(true);
  });

  it("yields no clients at all for an absent block (so /mcp stays 404)", () => {
    expect(resolveManagementApiConfig(undefined, {}).config.clients).toEqual([]);
    expect(resolveManagementApiConfig({}, {}).config.clients).toEqual([]);
  });
});

describe("instance binding advice", () => {
  it("warns that an unprefixed token is not bound to this instance", () => {
    const { warnings } = resolveManagementApiConfig(
      file({ c: { auth: { ref: "env:TOK" } } }, "alpha"),
      { TOK: tok() },
    );
    expect(warnings.some((w) => w.includes("NOT bound to this instance"))).toBe(true);
  });

  it("warns when a prefixed token names a DIFFERENT instance", () => {
    const { warnings } = resolveManagementApiConfig(
      file({ c: { auth: { ref: "env:TOK" } } }, "alpha"),
      { TOK: tok("beta") },
    );
    expect(warnings.some((w) => w.includes("will be REJECTED"))).toBe(true);
  });

  it("is quiet when a prefixed token matches this instance", () => {
    const { warnings } = resolveManagementApiConfig(
      file({ c: { auth: { ref: "env:TOK" } } }, "alpha"),
      { TOK: tok("alpha") },
    );
    expect(warnings).toEqual([]);
  });

  it("warns when a bound token cannot be enforced (no instanceId configured)", () => {
    const { warnings } = resolveManagementApiConfig(
      file({ c: { auth: { ref: "env:TOK" } } }),
      { TOK: tok("alpha") },
    );
    expect(warnings.some((w) => w.includes("cannot be enforced"))).toBe(true);
  });
});

describe("tokenInstanceId", () => {
  it("extracts the instance segment from a prefixed token", () => {
    expect(tokenInstanceId(`${TOKEN_PREFIX}alpha_secretpart`)).toBe("alpha");
  });

  it("returns undefined for an unprefixed or degenerate token", () => {
    expect(tokenInstanceId("plainsecret")).toBeUndefined();
    expect(tokenInstanceId(`${TOKEN_PREFIX}nounderscore`)).toBeUndefined();
    expect(tokenInstanceId(`${TOKEN_PREFIX}_leadingsep`)).toBeUndefined();
  });
});

describe("resolveClientScope", () => {
  it("defaults to read-only when absent", () => {
    expect(resolveClientScope(undefined)).toEqual(DEFAULT_READ_ONLY_SCOPE);
  });

  it("accepts comma/newline-delimited strings as lists", () => {
    const s = resolveClientScope({ allow: "list_*, read_chat", projects: "a\nb" });
    expect(s.allow).toEqual(["list_*", "read_chat"]);
    expect(s.projects).toEqual(["a", "b"]);
  });

  it("keeps an explicitly empty allow-list empty (granting nothing)", () => {
    expect(resolveClientScope({ allow: [] }).allow).toEqual([]);
  });
});
