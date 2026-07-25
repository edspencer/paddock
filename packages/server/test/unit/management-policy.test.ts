/**
 * Unit tests for the Management API policy primitives (#312 M1).
 *
 * These are the security-critical decisions, so the tests are written to be
 * paranoid rather than tidy: every predicate is exercised for its DENY path as
 * well as its allow path, and the deny-biased edges (unknown operation, empty
 * allow-list, deny-beats-allow, malformed pattern) each get their own case.
 * A regression in any of them silently widens a grant, which is exactly the
 * class of bug that would hand an external caller code execution on the host.
 */
import { describe, it, expect } from "vitest";
import {
  matchesPattern,
  isOperationAllowed,
  isProjectAllowed,
  allowedOperations,
  grantsTurnSpawning,
  assertOperation,
  assertProject,
  ManagementDeniedError,
  isInternalPrincipal,
  INTERNAL_PRINCIPAL,
  DEFAULT_READ_ONLY_SCOPE,
  FULL_SCOPE,
  ALL_OPERATIONS,
  READ_OPERATIONS,
  WRITE_OPERATIONS,
  TURN_SPAWNING_OPERATIONS,
  type ManagementScope,
  type ManagementPrincipal,
} from "../../src/management-policy.js";

const scope = (over: Partial<ManagementScope> = {}): ManagementScope => ({
  projects: ["*"],
  allow: [],
  deny: [],
  ...over,
});

const principal = (s: ManagementScope): ManagementPrincipal => ({
  clientId: "test-client",
  kind: "token",
  scope: s,
});

describe("matchesPattern", () => {
  it("matches everything on a bare star", () => {
    expect(matchesPattern("*", "anything")).toBe(true);
    expect(matchesPattern("*", "")).toBe(true);
  });

  it("matches a trailing-star prefix", () => {
    expect(matchesPattern("list_*", "list_chats")).toBe(true);
    expect(matchesPattern("list_*", "list_")).toBe(true);
    expect(matchesPattern("list_*", "read_chat")).toBe(false);
  });

  it("matches exactly when there is no wildcard", () => {
    expect(matchesPattern("read_chat", "read_chat")).toBe(true);
    expect(matchesPattern("read_chat", "read_chats")).toBe(false);
    expect(matchesPattern("read", "read_chat")).toBe(false);
  });

  // A pattern we do NOT support must fail closed (match nothing) rather than be
  // reinterpreted into something broader.
  it("treats an unsupported wildcard form as a literal (fails closed)", () => {
    expect(matchesPattern("*_chat", "read_chat")).toBe(false);
    expect(matchesPattern("list_*_x", "list_a_x")).toBe(false);
    expect(matchesPattern("re?d_chat", "read_chat")).toBe(false);
  });
});

describe("isOperationAllowed", () => {
  it("denies everything under an empty allow-list", () => {
    for (const op of ALL_OPERATIONS) {
      expect(isOperationAllowed(scope(), op)).toBe(false);
    }
  });

  it("allows what the allow-list names", () => {
    const s = scope({ allow: ["read_chat"] });
    expect(isOperationAllowed(s, "read_chat")).toBe(true);
    expect(isOperationAllowed(s, "create_chat")).toBe(false);
  });

  it("lets deny beat allow, even a star allow", () => {
    const s = scope({ allow: ["*"], deny: ["create_chat"] });
    expect(isOperationAllowed(s, "create_chat")).toBe(false);
    expect(isOperationAllowed(s, "read_chat")).toBe(true);
  });

  it("lets a deny pattern beat a broader allow pattern", () => {
    const s = scope({ allow: ["*"], deny: ["list_*"] });
    expect(isOperationAllowed(s, "list_chats")).toBe(false);
    expect(isOperationAllowed(s, "read_chat")).toBe(true);
  });

  // The catalogue gate: a name we don't know is refused even under `"*"`, so a
  // typo in config or a newly-added tool can't be reached by a stale grant.
  it("denies an operation outside the catalogue even with a star allow", () => {
    const s = scope({ allow: ["*"] });
    expect(isOperationAllowed(s, "delete_everything")).toBe(false);
    expect(isOperationAllowed(s, "read_chatt")).toBe(false);
    expect(isOperationAllowed(s, "")).toBe(false);
  });
});

describe("isProjectAllowed", () => {
  it("allows all projects under a star", () => {
    expect(isProjectAllowed(scope({ projects: ["*"] }), "paddock")).toBe(true);
  });

  it("restricts to the named projects", () => {
    const s = scope({ projects: ["paddock", "herdctl"] });
    expect(isProjectAllowed(s, "paddock")).toBe(true);
    expect(isProjectAllowed(s, "herdctl")).toBe(true);
    expect(isProjectAllowed(s, "eightsleep")).toBe(false);
  });

  it("reaches nothing under an empty project list", () => {
    expect(isProjectAllowed(scope({ projects: [] }), "paddock")).toBe(false);
  });

  it("lets denyProjects beat a star allow", () => {
    const s = scope({ projects: ["*"], denyProjects: ["secret-project"] });
    expect(isProjectAllowed(s, "paddock")).toBe(true);
    expect(isProjectAllowed(s, "secret-project")).toBe(false);
  });
});

describe("DEFAULT_READ_ONLY_SCOPE", () => {
  it("grants exactly the read verbs and nothing that mutates", () => {
    for (const op of READ_OPERATIONS) {
      expect(isOperationAllowed(DEFAULT_READ_ONLY_SCOPE, op)).toBe(true);
    }
    for (const op of WRITE_OPERATIONS) {
      expect(isOperationAllowed(DEFAULT_READ_ONLY_SCOPE, op)).toBe(false);
    }
  });

  // The whole point of the default: it cannot reach code execution.
  it("grants NO turn-spawning operation", () => {
    expect(grantsTurnSpawning(DEFAULT_READ_ONLY_SCOPE)).toBe(false);
    for (const op of TURN_SPAWNING_OPERATIONS) {
      expect(isOperationAllowed(DEFAULT_READ_ONLY_SCOPE, op)).toBe(false);
    }
  });

  it("allows reading triggers but not writing or firing them", () => {
    expect(isOperationAllowed(DEFAULT_READ_ONLY_SCOPE, "list_triggers")).toBe(true);
    expect(isOperationAllowed(DEFAULT_READ_ONLY_SCOPE, "set_trigger")).toBe(false);
    expect(isOperationAllowed(DEFAULT_READ_ONLY_SCOPE, "remove_trigger")).toBe(false);
    expect(isOperationAllowed(DEFAULT_READ_ONLY_SCOPE, "run_trigger")).toBe(false);
  });
});

describe("grantsTurnSpawning", () => {
  it("is true as soon as one spawning verb is granted", () => {
    expect(grantsTurnSpawning(scope({ allow: ["send_message"] }))).toBe(true);
    expect(grantsTurnSpawning(scope({ allow: ["set_trigger"] }))).toBe(true);
  });

  // archive/unarchive mutate presentational metadata but start no turn, so a
  // client with only those is not in the RCE risk class.
  it("is false for mutating verbs that start no turn", () => {
    expect(grantsTurnSpawning(scope({ allow: ["archive_chat", "unarchive_chat"] }))).toBe(false);
  });
});

describe("allowedOperations", () => {
  it("expands a pattern to concrete catalogue entries", () => {
    expect(allowedOperations(scope({ allow: ["list_*"] }))).toEqual([
      "list_projects",
      "list_chats",
      "list_triggers",
    ]);
  });

  it("returns the whole catalogue for a full scope and nothing for an empty one", () => {
    expect(allowedOperations(FULL_SCOPE)).toEqual([...ALL_OPERATIONS]);
    expect(allowedOperations(scope())).toEqual([]);
  });
});

describe("the internal principal", () => {
  it("is recognised as internal and may do everything", () => {
    expect(isInternalPrincipal(INTERNAL_PRINCIPAL)).toBe(true);
    for (const op of ALL_OPERATIONS) {
      expect(isOperationAllowed(INTERNAL_PRINCIPAL.scope, op)).toBe(true);
    }
    expect(isProjectAllowed(INTERNAL_PRINCIPAL.scope, "any-project")).toBe(true);
  });

  it("does not treat a token principal as internal", () => {
    expect(isInternalPrincipal(principal(FULL_SCOPE))).toBe(false);
  });
});

describe("assertOperation / assertProject", () => {
  it("passes silently when permitted", () => {
    const p = principal(scope({ allow: ["read_chat"], projects: ["paddock"] }));
    expect(() => assertOperation(p, "read_chat")).not.toThrow();
    expect(() => assertProject(p, "read_chat", "paddock")).not.toThrow();
  });

  it("throws a typed denial carrying the client + operation, never a credential", () => {
    const p = principal(scope({ allow: ["read_chat"] }));
    try {
      assertOperation(p, "create_chat");
      expect.unreachable("expected a denial");
    } catch (err) {
      expect(err).toBeInstanceOf(ManagementDeniedError);
      const e = err as ManagementDeniedError;
      expect(e.code).toBe("operation_denied");
      expect(e.clientId).toBe("test-client");
      expect(e.operation).toBe("create_chat");
      expect(e.message).toContain("create_chat");
    }
  });

  it("throws a project denial naming the refused slug", () => {
    const p = principal(scope({ allow: ["*"], projects: ["paddock"] }));
    try {
      assertProject(p, "read_chat", "eightsleep");
      expect.unreachable("expected a denial");
    } catch (err) {
      const e = err as ManagementDeniedError;
      expect(e.code).toBe("project_denied");
      expect(e.projectSlug).toBe("eightsleep");
    }
  });
});
