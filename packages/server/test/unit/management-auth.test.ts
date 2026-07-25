/**
 * Unit tests for the Management API token authenticator (#312 M1).
 *
 * Covers the three refusal shapes an MCP client must be able to act on
 * (missing / malformed / invalid), the instance-binding rejection that makes a
 * credential minted elsewhere useless here, and the challenge header — which
 * must be a real `WWW-Authenticate`, never a redirect.
 */
import { describe, it, expect } from "vitest";
import {
  bearerToken,
  constantTimeEqual,
  resolveTokenPrincipal,
  authenticateManagementRequest,
  challengeHeader,
  isManagementApiEnabled,
  insufficientScopeChallenge,
  denialResponse,
  resourceMetadataUrl,
} from "../../src/management-auth.js";
import { TOKEN_PREFIX } from "../../src/management-config.js";
import {
  DEFAULT_READ_ONLY_SCOPE,
  FULL_SCOPE,
  ManagementDeniedError,
} from "../../src/management-policy.js";
import type { ManagementApiConfig } from "../../src/management-config.js";

const SECRET = "z".repeat(40);
const BOUND = `${TOKEN_PREFIX}alpha_${"a".repeat(40)}`;

const cfg = (over: Partial<ManagementApiConfig> = {}): ManagementApiConfig => ({
  clients: [{ clientId: "laptop", token: SECRET, scope: DEFAULT_READ_ONLY_SCOPE }],
  publicUrl: "https://paddock.example.test",
  ...over,
});

describe("constantTimeEqual", () => {
  it("is true only for identical strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });

  // Differing lengths must not throw (timingSafeEqual would) nor leak length.
  it("handles different lengths without throwing", () => {
    expect(constantTimeEqual("a", "aaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(constantTimeEqual("", "a")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("bearerToken", () => {
  it("extracts a bearer token case-insensitively", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("BEARER   abc  ")).toBe("abc");
  });

  it("returns undefined when absent and null when unparseable", () => {
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken("")).toBeUndefined();
    expect(bearerToken("   ")).toBeUndefined();
    expect(bearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer   ")).toBeNull();
  });

  it("reads the first value of a repeated header", () => {
    expect(bearerToken(["Bearer abc", "Bearer def"])).toBe("abc");
  });
});

describe("resolveTokenPrincipal", () => {
  it("resolves a matching token to its client identity and scope", () => {
    const p = resolveTokenPrincipal(SECRET, cfg());
    expect(p).not.toBeNull();
    expect(p!.clientId).toBe("laptop");
    expect(p!.kind).toBe("token");
    expect(p!.scope).toEqual(DEFAULT_READ_ONLY_SCOPE);
  });

  it("refuses an unknown token", () => {
    expect(resolveTokenPrincipal("y".repeat(40), cfg())).toBeNull();
  });

  it("refuses when no clients are configured", () => {
    expect(resolveTokenPrincipal(SECRET, { clients: [] })).toBeNull();
  });

  it("picks the right client out of several", () => {
    const many = cfg({
      clients: [
        { clientId: "a", token: "a".repeat(40), scope: DEFAULT_READ_ONLY_SCOPE },
        { clientId: "b", token: "b".repeat(40), scope: FULL_SCOPE },
      ],
    });
    expect(resolveTokenPrincipal("b".repeat(40), many)!.clientId).toBe("b");
  });

  // The audience check: same secret bytes, wrong instance ⇒ refused.
  it("refuses a token bound to a different instance", () => {
    const c: ManagementApiConfig = {
      instanceId: "beta",
      clients: [{ clientId: "laptop", token: BOUND, scope: DEFAULT_READ_ONLY_SCOPE }],
    };
    expect(resolveTokenPrincipal(BOUND, c)).toBeNull();
  });

  it("accepts a token bound to THIS instance", () => {
    const c: ManagementApiConfig = {
      instanceId: "alpha",
      clients: [{ clientId: "laptop", token: BOUND, scope: DEFAULT_READ_ONLY_SCOPE }],
    };
    expect(resolveTokenPrincipal(BOUND, c)!.clientId).toBe("laptop");
  });
});

describe("authenticateManagementRequest", () => {
  it("reports the three refusal shapes distinctly", () => {
    expect(authenticateManagementRequest(undefined, cfg())).toEqual({
      ok: false,
      failure: "missing",
    });
    expect(authenticateManagementRequest("Basic xyz", cfg())).toEqual({
      ok: false,
      failure: "malformed",
    });
    expect(authenticateManagementRequest(`Bearer ${"q".repeat(40)}`, cfg())).toEqual({
      ok: false,
      failure: "invalid",
    });
  });

  it("succeeds with a principal for a good token", () => {
    const r = authenticateManagementRequest(`Bearer ${SECRET}`, cfg());
    expect(r.ok).toBe(true);
    expect(r.ok && r.principal.clientId).toBe("laptop");
  });
});

describe("challengeHeader", () => {
  it("is a bearer challenge, never a redirect", () => {
    expect(challengeHeader("missing")).toBe('Bearer realm="paddock"');
  });

  it("marks an invalid token with the RFC 6750 error code", () => {
    const h = challengeHeader("invalid");
    expect(h).toContain('error="invalid_token"');
    expect(h).toContain("realm=");
  });

  it("advertises the RFC 9728 metadata location when supplied (M2)", () => {
    const h = challengeHeader("missing", "https://example.test/.well-known/oauth-protected-resource");
    expect(h).toContain('resource_metadata="https://example.test/.well-known/oauth-protected-resource"');
  });
});

describe("isManagementApiEnabled", () => {
  it("is false without configured clients (drives the fail-closed 404)", () => {
    expect(isManagementApiEnabled(undefined)).toBe(false);
    expect(isManagementApiEnabled({ clients: [] })).toBe(false);
  });

  it("is true once a client AND a public URL are configured", () => {
    expect(isManagementApiEnabled(cfg())).toBe(true);
  });

  // Without a canonical public URL, M2's discovery document could not be served
  // correctly — so the surface stays off rather than half-working.
  it("is false when the public URL is missing", () => {
    expect(isManagementApiEnabled({ ...cfg(), publicUrl: undefined })).toBe(false);
  });
});

describe("insufficientScopeChallenge", () => {
  // A valid credential with too narrow a grant is a 403 + this challenge —
  // re-authenticating wouldn't help, so it must not look like a 401.
  it("names the required scope and the RFC 6750 error code", () => {
    const h = insufficientScopeChallenge("create_chat");
    expect(h).toContain('error="insufficient_scope"');
    expect(h).toContain('scope="create_chat"');
    expect(h).not.toContain("invalid_token");
  });

  it("advertises the metadata URL when supplied", () => {
    expect(insufficientScopeChallenge("read_chat", "https://x.test/.well-known/y")).toContain(
      'resource_metadata="https://x.test/.well-known/y"',
    );
  });
});

describe("denialResponse", () => {
  it("maps an operation denial to 403 naming the operation", () => {
    const r = denialResponse(
      new ManagementDeniedError({
        code: "operation_denied",
        clientId: "laptop",
        operation: "create_chat",
      }),
    );
    expect(r.status).toBe(403);
    expect(r.challenge).toContain('scope="create_chat"');
    expect(r.body.code).toBe("operation_denied");
  });

  it("maps a project denial to 403 naming the project scope", () => {
    const r = denialResponse(
      new ManagementDeniedError({
        code: "project_denied",
        clientId: "laptop",
        operation: "read_chat",
        projectSlug: "secret",
      }),
    );
    expect(r.status).toBe(403);
    expect(r.challenge).toContain('scope="project:secret"');
  });
});

describe("resourceMetadataUrl", () => {
  // Clients request the PATH-INSERTED form for a resource that has a path.
  it("builds the path-inserted well-known URL from the public URL", () => {
    expect(resourceMetadataUrl(cfg())).toBe(
      "https://paddock.example.test/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("is undefined without a public URL", () => {
    expect(resourceMetadataUrl({ clients: [] })).toBeUndefined();
  });
});
