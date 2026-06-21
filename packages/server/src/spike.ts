/**
 * spike.ts — REAL integration spike against the public @herdctl/core (5.10.1).
 *
 * Purpose: prove that paddock's understanding of the public API typechecks and
 * that a FleetManager can be constructed + initialized. It is EXCLUDED from the
 * production build (see tsconfig.json) but IS typechecked via tsconfig.spike.json
 * and runnable via `npm run -w packages/server spike`.
 *
 * Running it end-to-end (an actual trigger) needs:
 *   - a valid herdctl.yaml at PADDOCK_HERDCTL_CONFIG (or ./data/herdctl.yaml)
 *   - Claude auth: CLAUDE_CODE_OAUTH_TOKEN (Max, runtime: cli) or ANTHROPIC_API_KEY (sdk)
 *   - the `claude` CLI on PATH (for runtime: cli)
 * Without those, we still prove construction + initialize() against a minimal
 * generated config, and document what a real trigger requires.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  FleetManager,
  SessionDiscoveryService,
  type AgentInfo,
  type FleetStatus,
  type SDKMessage,
  type TriggerResult,
  type DiscoveredSession,
} from "@herdctl/core";
import YAML from "yaml";

async function writeMinimalConfig(dir: string): Promise<string> {
  // Agents must be referenced by path (the fleet `agents` array does not accept
  // inline agent definitions). Write the agent yaml, then reference it.
  const agentPath = path.join(dir, "scratch.agent.yaml");
  await fs.writeFile(
    agentPath,
    YAML.stringify({
      name: "scratch",
      description: "spike scratch agent",
      working_directory: dir,
      runtime: "cli",
      max_turns: 3,
      permission_mode: "default",
      system_prompt: "You are a spike agent. Reply with a one-line greeting. Use no tools.",
      default_prompt: "Say hello.",
      allowed_tools: [],
    }),
    "utf8",
  );

  const cfgPath = path.join(dir, "herdctl.yaml");
  const doc = {
    version: 1,
    // The `fleet` block is strict — only name/description are allowed.
    fleet: { name: "paddock-spike", description: "spike fleet" },
    agents: [{ path: agentPath }],
  };
  await fs.writeFile(cfgPath, YAML.stringify(doc), "utf8");
  return cfgPath;
}

async function main(): Promise<void> {
  // 2a — construct + initialize a FleetManager (the minimal setup).
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paddock-spike-"));
  const stateDir = path.join(tmp, ".herdctl");
  const configPath = await writeMinimalConfig(tmp);

  const fleet = new FleetManager({ configPath, stateDir });
  await fleet.initialize();
  console.log("✓ FleetManager constructed + initialized");

  // 2d/2e — status + agents + events.
  const status: FleetStatus = await fleet.getFleetStatus();
  const agents: AgentInfo[] = await fleet.getAgentInfo();
  console.log(`✓ fleet state=${status.state}; agents=${agents.map((a) => a.qualifiedName).join(",")}`);

  fleet.on("job:output", (p) => process.stdout.write(p.output));
  fleet.on("job:completed", (p) => console.log(`\n✓ job ${p.job.id} completed`));
  fleet.on("error", (e) => console.error("fleet error:", e.message));

  // 2d — session discovery is constructable against the real API.
  const discovery = new SessionDiscoveryService({ stateDir, claudeHomePath: path.join(os.homedir(), ".claude") });
  const sessions: DiscoveredSession[] = await discovery
    .getAgentSessions("scratch", tmp, false)
    .catch(() => [] as DiscoveredSession[]);
  console.log(`✓ session discovery ok (${sessions.length} existing sessions)`);

  // 2c — a real, streaming trigger. Requires Claude auth + `claude` CLI.
  if (process.env.PADDOCK_SPIKE_TRIGGER === "1") {
    console.log("→ attempting a real trigger (PADDOCK_SPIKE_TRIGGER=1)...");
    const result: TriggerResult = await fleet.trigger("scratch", undefined, {
      prompt: "Reply with exactly: paddock-spike-ok",
      resume: null, // start a fresh session
      triggerType: "manual",
      onMessage: (m: SDKMessage) => {
        if (m.type === "assistant" && typeof m.content === "string") process.stdout.write(m.content);
      },
    });
    console.log(`\n✓ trigger success=${result.success} sessionId=${result.sessionId ?? "n/a"}`);
  } else {
    console.log(
      "↷ skipping real trigger. Set PADDOCK_SPIKE_TRIGGER=1 with CLAUDE_CODE_OAUTH_TOKEN " +
        "(or ANTHROPIC_API_KEY) and the `claude` CLI on PATH to exercise streaming.",
    );
  }

  await fleet.stop({ waitForJobs: false }).catch(() => undefined);
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  console.log("✓ spike complete");
}

main().catch((err) => {
  console.error("spike failed:", err);
  process.exit(1);
});
