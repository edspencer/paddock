/**
 * Unit tests for GithubAuth — the GitHub OAuth device flow (github-auth.ts).
 *
 * Security-sensitive: this is the credential path for the git backing store, so
 * we exercise it thoroughly with a MOCKED global `fetch` (zero network):
 *   - clientId() surfaces the injected client id (trim + empty handling)
 *   - status() reports configured/connected/login
 *   - startDeviceFlow() POSTs the device-code endpoint (happy + error + malformed)
 *   - pollDeviceFlow() POSTs the token endpoint (pending/slow_down/authorized/error)
 *   - token()/disconnect() and the 0600 token-file mode
 *
 * fetch is stubbed per-test via `vi.fn()` assigned to globalThis.fetch and
 * restored in afterEach. The token file lives under a fresh temp dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { GithubAuth } from "../../src/github-auth.js";
import { makeTmpDir, rmTmpDir } from "../helpers/tmp.js";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

/** A minimal Response stand-in for the fields github-auth reads (ok/status/json). */
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

describe("GithubAuth", () => {
  let tmp: string;
  let tokenFile: string;
  let auth: GithubAuth;
  let fetchMock: ReturnType<typeof vi.fn>;
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    tmp = await makeTmpDir("paddock-gh-");
    tokenFile = path.join(tmp, "github-auth.json");
    // The client id is now injected (folded into PaddockConfig, issue #269).
    auth = new GithubAuth(tokenFile, "Iv1.testclientid");
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await rmTmpDir(tmp);
  });

  // --- clientId() -------------------------------------------------------------

  describe("clientId", () => {
    it("returns the trimmed injected client id", () => {
      expect(new GithubAuth(tokenFile, "  Iv1.abc  ").clientId()).toBe("Iv1.abc");
    });
    it("returns undefined when unset", () => {
      expect(new GithubAuth(tokenFile).clientId()).toBeUndefined();
    });
    it("returns undefined for a whitespace-only value", () => {
      expect(new GithubAuth(tokenFile, "   ").clientId()).toBeUndefined();
    });
  });

  // --- status() ---------------------------------------------------------------

  describe("status", () => {
    it("reports configured:true, connected:false when no token is stored", async () => {
      const s = await auth.status();
      expect(s).toEqual({ configured: true, connected: false, login: undefined });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("reports configured:false when no client id is set", async () => {
      const bare = new GithubAuth(tokenFile);
      const s = await bare.status();
      expect(s.configured).toBe(false);
      expect(s.connected).toBe(false);
    });

    it("reports connected:true + login when a token file exists", async () => {
      await fs.writeFile(
        tokenFile,
        JSON.stringify({ access_token: "gho_x", login: "octocat" }),
        "utf8",
      );
      const s = await auth.status();
      expect(s.connected).toBe(true);
      expect(s.login).toBe("octocat");
    });
  });

  // --- startDeviceFlow() ------------------------------------------------------

  describe("startDeviceFlow", () => {
    it("POSTs the device-code endpoint and maps the response", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          device_code: "dev123",
          user_code: "WXYZ-1234",
          verification_uri: "https://github.com/login/device",
          interval: 7,
          expires_in: 600,
        }),
      );

      const out = await auth.startDeviceFlow();
      expect(out).toEqual({
        deviceCode: "dev123",
        userCode: "WXYZ-1234",
        verificationUri: "https://github.com/login/device",
        interval: 7,
        expiresIn: 600,
      });

      // Verify the exact request shape (client_id + scope, JSON body).
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(DEVICE_CODE_URL);
      expect(init.method).toBe("POST");
      expect(init.headers.accept).toBe("application/json");
      expect(JSON.parse(init.body)).toEqual({
        client_id: "Iv1.testclientid",
        scope: "repo",
      });
    });

    it("defaults interval=5 and expiresIn=900 when omitted", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          device_code: "dev",
          user_code: "AAAA-BBBB",
          verification_uri: "https://github.com/login/device",
        }),
      );
      const out = await auth.startDeviceFlow();
      expect(out.interval).toBe(5);
      expect(out.expiresIn).toBe(900);
    });

    it("throws when no client id is configured (and never calls fetch)", async () => {
      const bare = new GithubAuth(tokenFile);
      await expect(bare.startDeviceFlow()).rejects.toThrow(/not configured/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("throws on a non-ok HTTP response", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 503 }));
      await expect(auth.startDeviceFlow()).rejects.toThrow(/device code request failed \(503\)/);
    });

    it("throws on a malformed response (missing fields)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ device_code: "only-this" }));
      await expect(auth.startDeviceFlow()).rejects.toThrow(/malformed device code response/);
    });
  });

  // --- pollDeviceFlow() -------------------------------------------------------

  describe("pollDeviceFlow", () => {
    it("authorizes: stores the token (0600), fetches the login, returns authorized", async () => {
      // 1st call: token endpoint returns an access token; 2nd: the user endpoint.
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "gho_secret", scope: "repo" }))
        .mockResolvedValueOnce(jsonResponse({ login: "octocat" }));

      const res = await auth.pollDeviceFlow("dev123");
      expect(res).toEqual({ status: "authorized" });

      // The token endpoint was POSTed with the device-flow grant.
      const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
      expect(tokenUrl).toBe(TOKEN_URL);
      expect(JSON.parse(tokenInit.body)).toEqual({
        client_id: "Iv1.testclientid",
        device_code: "dev123",
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      // The user endpoint was called with the bearer token.
      const [userUrl, userInit] = fetchMock.mock.calls[1];
      expect(userUrl).toBe(USER_URL);
      expect(userInit.headers.authorization).toBe("Bearer gho_secret");

      // The token file was written and round-trips via token()/status().
      expect(await auth.token()).toBe("gho_secret");
      const s = await auth.status();
      expect(s.connected).toBe(true);
      expect(s.login).toBe("octocat");

      // 0600 mode — owner read/write only (security: never group/world readable).
      const st = await fs.stat(tokenFile);
      expect(st.mode & 0o777).toBe(0o600);
      const stored = JSON.parse(await fs.readFile(tokenFile, "utf8"));
      expect(stored.access_token).toBe("gho_secret");
      expect(stored.login).toBe("octocat");
      expect(stored.scope).toBe("repo");
    });

    it("stores the token even when the login lookup fails (login left undefined)", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "gho_nologin" }))
        .mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 401 }));
      const res = await auth.pollDeviceFlow("dev");
      expect(res.status).toBe("authorized");
      expect(await auth.token()).toBe("gho_nologin");
      const s = await auth.status();
      expect(s.login).toBeUndefined();
    });

    it("tolerates the login fetch throwing (network error → login undefined)", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "gho_throw" }))
        .mockRejectedValueOnce(new Error("network down"));
      const res = await auth.pollDeviceFlow("dev");
      expect(res.status).toBe("authorized");
      expect(await auth.token()).toBe("gho_throw");
    });

    it("maps authorization_pending → pending (no token written)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "authorization_pending" }));
      expect(await auth.pollDeviceFlow("dev")).toEqual({ status: "pending" });
      expect(await auth.token()).toBeUndefined();
    });

    it("maps slow_down → slow_down", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "slow_down" }));
      expect(await auth.pollDeviceFlow("dev")).toEqual({ status: "slow_down" });
    });

    it("maps an error with error_description → error + message", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: "expired_token", error_description: "The device code expired" }),
      );
      expect(await auth.pollDeviceFlow("dev")).toEqual({
        status: "error",
        error: "The device code expired",
      });
    });

    it("falls back to the error code when no description is present", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "access_denied" }));
      expect(await auth.pollDeviceFlow("dev")).toEqual({
        status: "error",
        error: "access_denied",
      });
    });

    it("returns error:'unknown' when the response has neither token nor error", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({}));
      expect(await auth.pollDeviceFlow("dev")).toEqual({ status: "error", error: "unknown" });
    });

    it("returns error 'not configured' (without calling fetch) when no client id", async () => {
      const bare = new GithubAuth(tokenFile);
      expect(await bare.pollDeviceFlow("dev")).toEqual({ status: "error", error: "not configured" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("resolves to a clean error (not a throw) on a non-JSON token response (issue #21)", async () => {
      // A gateway 502 / rate-limit HTML page → res.json() throws. The poll must
      // resolve to a clean error result, never propagate the SyntaxError.
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0");
        },
      } as unknown as Response);
      const res = await auth.pollDeviceFlow("dev");
      expect(res.status).toBe("error");
      expect(res.error).toContain("502");
      // No token was stored on the error path.
      expect(await auth.token()).toBeUndefined();
    });
  });

  // --- token() / disconnect() -------------------------------------------------

  describe("token + disconnect", () => {
    it("token() returns undefined with no stored token", async () => {
      expect(await auth.token()).toBeUndefined();
    });

    it("disconnect() removes the token file and clears the cache", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "gho_bye" }))
        .mockResolvedValueOnce(jsonResponse({ login: "octocat" }));
      await auth.pollDeviceFlow("dev");
      expect(await auth.token()).toBe("gho_bye");

      await auth.disconnect();
      expect(await auth.token()).toBeUndefined();
      await expect(fs.stat(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
      // status() reflects the disconnect.
      const s = await auth.status();
      expect(s.connected).toBe(false);
    });

    it("disconnect() is a no-op when there's no token file", async () => {
      await expect(auth.disconnect()).resolves.toBeUndefined();
    });

    it("treats a corrupt token file as no token", async () => {
      await fs.writeFile(tokenFile, "{not json", "utf8");
      const fresh = new GithubAuth(tokenFile);
      expect(await fresh.token()).toBeUndefined();
      expect((await fresh.status()).connected).toBe(false);
    });

    it("caches the loaded token (a single read backs repeated calls)", async () => {
      await fs.writeFile(
        tokenFile,
        JSON.stringify({ access_token: "gho_cached", login: "octocat" }),
        "utf8",
      );
      expect(await auth.token()).toBe("gho_cached");
      // Remove the file underneath; the cached value still answers.
      await fs.rm(tokenFile, { force: true });
      expect(await auth.token()).toBe("gho_cached");
    });
  });
});
