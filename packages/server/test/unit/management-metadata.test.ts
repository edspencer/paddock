/**
 * Unit tests for the RFC 9728 protected-resource metadata (#312 M2).
 *
 * Two rules carry the weight here, both learned from live discovery traces
 * rather than from reading the spec:
 *
 *  - the URL is path-INSERTED, because that is the only form a real MCP client
 *    requests for a resource that has a path;
 *  - the document is served only when it can be COMPLETE, because a document
 *    without `authorization_servers` sends clients hunting for an authorization
 *    server that does not exist.
 */
import { describe, it, expect } from "vitest";
import {
  buildProtectedResourceMetadata,
  metadataUrl,
  resourceIdentifier,
  PROTECTED_RESOURCE_METADATA_PREFIX,
} from "../../src/management-metadata.js";
import type { ManagementApiConfig } from "../../src/management-config.js";

const cfg = (over: Partial<ManagementApiConfig> = {}): ManagementApiConfig => ({
  clients: [],
  publicUrl: "https://paddock.example.test",
  authorizationServers: ["https://idp.example.test/application/o/paddock"],
  ...over,
});

describe("resourceIdentifier", () => {
  // Must byte-match the URL the client used, or RFC 9728 §3.3 says the client
  // MUST discard the document.
  it("is the public URL plus the resource path", () => {
    expect(resourceIdentifier(cfg())).toBe("https://paddock.example.test/mcp");
  });

  it("is undefined without a public URL", () => {
    expect(resourceIdentifier({ clients: [] })).toBeUndefined();
  });
});

describe("metadataUrl", () => {
  // Path-INSERTED: the well-known segment goes between host and resource path.
  it("inserts the well-known segment before the resource path", () => {
    expect(metadataUrl(cfg())).toBe(
      `https://paddock.example.test${PROTECTED_RESOURCE_METADATA_PREFIX}/mcp`,
    );
  });

  it("is not the appended form", () => {
    expect(metadataUrl(cfg())).not.toContain("/mcp/.well-known");
  });
});

describe("buildProtectedResourceMetadata", () => {
  it("produces a complete document", () => {
    expect(buildProtectedResourceMetadata(cfg())).toEqual({
      resource: "https://paddock.example.test/mcp",
      authorization_servers: ["https://idp.example.test/application/o/paddock"],
      scopes_supported: ["paddock:read", "paddock:write"],
      bearer_methods_supported: ["header"],
      resource_name: "Paddock Management API",
    });
  });

  // The MCP spec makes `authorization_servers` mandatory; a token-only
  // deployment has none, so it publishes nothing rather than an invalid doc.
  it("publishes nothing when no authorization server is configured", () => {
    expect(buildProtectedResourceMetadata({ ...cfg(), authorizationServers: [] })).toBeUndefined();
    expect(
      buildProtectedResourceMetadata({ ...cfg(), authorizationServers: undefined }),
    ).toBeUndefined();
  });

  it("publishes nothing without a public URL", () => {
    expect(buildProtectedResourceMetadata({ ...cfg(), publicUrl: undefined })).toBeUndefined();
  });
});
