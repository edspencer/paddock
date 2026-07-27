/**
 * Trusted-proxy resolution + matching (#474).
 *
 * The property under test is the one the issue is about: `X-Forwarded-Proto` is
 * a CLIENT-SETTABLE header, so the decision to believe it must rest on the
 * immediate peer's socket address — which a client cannot choose — and on an
 * operator-stated list of who the proxies are.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_TRUSTED_PROXIES,
  defaultTrustedProxies,
  isLoopbackAddress,
  isTrustedProxy,
  parseTrustedProxies,
} from "../../src/trusted-proxy.js";
import { resolveManagementApiConfig } from "../../src/management-config.js";

describe("parseTrustedProxies", () => {
  it("defaults to loopback + the private address space when the operator says nothing", () => {
    for (const raw of [undefined, "", "   ", []]) {
      const { trusted, errors } = parseTrustedProxies(raw as string | string[] | undefined);
      expect(errors).toEqual([]);
      expect(trusted.entries).toEqual([...DEFAULT_TRUSTED_PROXIES]);
      // Not explicit: the guard warns when it leans on this rather than a
      // proxy the operator actually named.
      expect(trusted.explicit).toBe(false);
    }
  });

  it("accepts IPs, CIDRs and presets, from an array or a delimited string", () => {
    const fromArray = parseTrustedProxies(["10.1.2.3", "172.18.0.0/16", "loopback"]);
    expect(fromArray.errors).toEqual([]);
    expect(fromArray.trusted).toEqual({
      entries: ["10.1.2.3", "172.18.0.0/16", "loopback"],
      explicit: true,
    });
    const fromString = parseTrustedProxies(" 10.1.2.3 , 172.18.0.0/16\nloopback ");
    expect(fromString.trusted).toEqual(fromArray.trusted);
  });

  it('treats "none" as an explicit empty list — believe no peer at all', () => {
    const { trusted, errors } = parseTrustedProxies("none");
    expect(errors).toEqual([]);
    expect(trusted).toEqual({ entries: [], explicit: true });
    expect(isTrustedProxy("127.0.0.1", trusted)).toBe(false);
  });

  it('treats "all" as trust-everyone, and says so loudly', () => {
    const { trusted, warnings } = parseTrustedProxies("all");
    expect(isTrustedProxy("203.0.113.9", trusted)).toBe(true);
    expect(warnings.join(" ")).toMatch(/every peer/i);
  });

  // A typo in one CIDR must not take the instance down — and dropping an entry
  // can only ever make the guard stricter, never more permissive.
  it("drops an unparseable entry with an error and keeps the rest", () => {
    const { trusted, errors } = parseTrustedProxies(["10.1.2.3", "not-an-ip", "banana/24"]);
    expect(trusted.entries).toEqual(["10.1.2.3"]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/not-an-ip/);
  });
});

describe("isTrustedProxy", () => {
  const explicit = parseTrustedProxies(["172.18.0.0/16"]).trusted;

  it("matches an explicit CIDR, including its IPv4-mapped IPv6 form", () => {
    expect(isTrustedProxy("172.18.0.5", explicit)).toBe(true);
    // What Node reports for an IPv4 peer on a dual-stack listener.
    expect(isTrustedProxy("::ffff:172.18.0.5", explicit)).toBe(true);
    expect(isTrustedProxy("172.19.0.5", explicit)).toBe(false);
  });

  it("never trusts an unknown or malformed peer address", () => {
    for (const addr of [undefined, "", "not-an-ip"]) {
      expect(isTrustedProxy(addr, explicit)).toBe(false);
      expect(isTrustedProxy(addr, defaultTrustedProxies())).toBe(false);
    }
  });

  it("default list covers the private topologies and NEVER a public peer", () => {
    const d = defaultTrustedProxies();
    // Docker bridge gateway, a Compose sidecar, a k8s pod network, ULA v6.
    for (const addr of ["127.0.0.1", "172.17.0.1", "172.18.0.5", "10.42.0.9", "fd00::1"]) {
      expect(isTrustedProxy(addr, d)).toBe(true);
    }
    // The case that previously let any internet client switch the guard off.
    for (const addr of ["203.0.113.9", "8.8.8.8", "2001:db8::1"]) {
      expect(isTrustedProxy(addr, d)).toBe(false);
    }
  });
});

describe("isLoopbackAddress", () => {
  it("recognises every form Node hands us, and nothing else", () => {
    for (const addr of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackAddress(addr)).toBe(true);
    }
    // The Docker bridge gateway is NOT loopback-equivalent: a remote client
    // hitting a 0.0.0.0-published port is SNAT'd to this same address.
    for (const addr of ["172.17.0.1", "192.168.1.50", "203.0.113.9", undefined]) {
      expect(isLoopbackAddress(addr)).toBe(false);
    }
  });
});

describe("resolveManagementApiConfig — trustedProxies", () => {
  const base = {
    publicUrl: "https://paddock.example.test",
    clients: { laptop: { auth: { ref: "env:TOK" } } },
  };
  const env = { TOK: "pdk_testinstance_0123456789abcdef0123456789" };

  it("resolves the YAML list", () => {
    const { config, errors } = resolveManagementApiConfig(
      { ...base, trustedProxies: ["172.18.0.0/16"] },
      env,
    );
    expect(errors).toEqual([]);
    expect(config.trustedProxies).toEqual({
      entries: ["172.18.0.0/16"],
      explicit: true,
    });
  });

  it("lets the env var win over the file, like every other setting", () => {
    const { config } = resolveManagementApiConfig(
      { ...base, trustedProxies: ["172.18.0.0/16"] },
      { ...env, PADDOCK_MANAGEMENT_TRUSTED_PROXIES: "none" },
    );
    expect(config.trustedProxies).toEqual({ entries: [], explicit: true });
  });

  it("falls back to the compatibility default when unset", () => {
    const { config } = resolveManagementApiConfig(base, env);
    expect(config.trustedProxies).toEqual(defaultTrustedProxies());
  });

  it("reports a bad entry as a config error without disabling the API", () => {
    const { config, errors } = resolveManagementApiConfig(
      { ...base, trustedProxies: ["10.0.0.0/8", "nonsense"] },
      env,
    );
    expect(errors.join(" ")).toMatch(/nonsense/);
    expect(config.clients).toHaveLength(1);
    expect(config.trustedProxies?.entries).toEqual(["10.0.0.0/8"]);
  });
});
