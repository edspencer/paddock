/**
 * GitHub OAuth device-flow auth for the git backing store (Phase 2).
 *
 * Lets a self-hosted paddock authenticate to GitHub with NO public callback URL:
 * the user approves a short code at github.com/login/device, paddock exchanges
 * it for a scoped token and stores it (0600, under the data dir — never in the
 * repo). Requires a registered OAuth/GitHub App client id in
 * `PADDOCK_GITHUB_CLIENT_ID`; without it the feature reports "not configured".
 *
 * The push target itself (Option B = a bare repo on the NAS over SSH) does not
 * need this — it's for when GitHub is a remote. The stored token is exposed via
 * `token()` so the git layer can inject it for GitHub HTTPS remotes.
 */
import { promises as fs } from "node:fs";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const DEFAULT_SCOPE = "repo";

export interface DeviceFlowStart {
  userCode: string;
  verificationUri: string;
  deviceCode: string;
  interval: number;
  expiresIn: number;
}

export interface GithubStatus {
  /** A client id is configured (PADDOCK_GITHUB_CLIENT_ID). */
  configured: boolean;
  /** A token is stored (the user has connected). */
  connected: boolean;
  login?: string;
}

export type PollResult = { status: "authorized" | "pending" | "slow_down" | "error"; error?: string };

interface StoredToken {
  access_token: string;
  login?: string;
  scope?: string;
}

function field(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

function numField(obj: unknown, key: string): number | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === "number" ? v : undefined;
  }
  return undefined;
}

export class GithubAuth {
  private cached: StoredToken | null | undefined;

  constructor(private readonly tokenFile: string) {}

  /** The configured OAuth/App client id, or undefined when unset. */
  clientId(): string | undefined {
    const id = process.env.PADDOCK_GITHUB_CLIENT_ID;
    return id && id.trim() ? id.trim() : undefined;
  }

  async status(): Promise<GithubStatus> {
    const tok = await this.loadToken();
    return { configured: !!this.clientId(), connected: !!tok, login: tok?.login };
  }

  /** Begin the device flow — returns the code + URL to show the user. */
  async startDeviceFlow(): Promise<DeviceFlowStart> {
    const client_id = this.clientId();
    if (!client_id) throw new Error("GitHub not configured (set PADDOCK_GITHUB_CLIENT_ID)");
    const res = await fetch(DEVICE_CODE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id, scope: DEFAULT_SCOPE }),
    });
    if (!res.ok) throw new Error(`device code request failed (${res.status})`);
    const j = (await res.json()) as unknown;
    const deviceCode = field(j, "device_code");
    const userCode = field(j, "user_code");
    const verificationUri = field(j, "verification_uri");
    if (!deviceCode || !userCode || !verificationUri) {
      throw new Error("malformed device code response");
    }
    return {
      deviceCode,
      userCode,
      verificationUri,
      interval: numField(j, "interval") ?? 5,
      expiresIn: numField(j, "expires_in") ?? 900,
    };
  }

  /** Poll the token endpoint; on success, store the token. */
  async pollDeviceFlow(deviceCode: string): Promise<PollResult> {
    const client_id = this.clientId();
    if (!client_id) return { status: "error", error: "not configured" };
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const j = (await res.json()) as unknown;
    const accessToken = field(j, "access_token");
    if (accessToken) {
      const login = await this.fetchLogin(accessToken);
      await this.saveToken({ access_token: accessToken, login, scope: field(j, "scope") });
      return { status: "authorized" };
    }
    const err = field(j, "error");
    if (err === "authorization_pending") return { status: "pending" };
    if (err === "slow_down") return { status: "slow_down" };
    return { status: "error", error: field(j, "error_description") ?? err ?? "unknown" };
  }

  /** The stored access token (for injecting into GitHub HTTPS pushes). */
  async token(): Promise<string | undefined> {
    return (await this.loadToken())?.access_token;
  }

  async disconnect(): Promise<void> {
    this.cached = null;
    await fs.rm(this.tokenFile, { force: true }).catch(() => undefined);
  }

  private async fetchLogin(token: string): Promise<string | undefined> {
    try {
      const r = await fetch(USER_URL, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "paddock",
        },
      });
      if (!r.ok) return undefined;
      return field(await r.json(), "login");
    } catch {
      return undefined;
    }
  }

  private async loadToken(): Promise<StoredToken | null> {
    if (this.cached !== undefined) return this.cached;
    try {
      this.cached = JSON.parse(await fs.readFile(this.tokenFile, "utf8")) as StoredToken;
    } catch {
      this.cached = null;
    }
    return this.cached;
  }

  private async saveToken(t: StoredToken): Promise<void> {
    this.cached = t;
    await fs.writeFile(this.tokenFile, JSON.stringify(t), { mode: 0o600 });
  }
}
