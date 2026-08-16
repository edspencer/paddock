/**
 * The #882 transcript-migration offer.
 *
 * This is the whole discovery surface for the migration, so the tests that
 * matter are the ones about when it is NOT shown — a banner that appears when it
 * shouldn't is a nag, and one that vanishes when it should appear is the feature
 * silently not shipping. In particular:
 *
 *   - It keys off `eligible` and never off `pendingChats`. A `.chats/` holding
 *     only an agent `memory/` directory is `eligible: true` with
 *     `pendingChats: 0`; #899 pinned that server-side and this pins the client.
 *   - An unrecognised `reason` from a newer server means "no banner", not a
 *     crash and not a half-drawn one.
 *   - A failing probe renders nothing at all, and does not take the app down
 *     with it — this component mounts in the shell on every route.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { MigrationOfferBanner, MigrationOfferCard } from "./MigrationOffer";
import { invalidateMigrationProbe } from "../lib/useMigrationOffer";
import type { TranscriptsMigrationProbe } from "../lib/types";

// `vi.hoisted` because `vi.mock` is lifted above the imports, and this factory
// runs while `../lib/useMigrationOffer` is being evaluated — a plain
// module-scope `const` is still in its temporal dead zone at that point.
const { transcriptsMigration } = vi.hoisted(() => ({ transcriptsMigration: vi.fn() }));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: { ...actual.api, transcriptsMigration } };
});

function probe(over: Partial<TranscriptsMigrationProbe> = {}): TranscriptsMigrationProbe {
  return {
    mode: "own",
    eligible: true,
    pendingChats: 12,
    pendingProjects: 3,
    scannedProjects: 4,
    computedAt: "2026-08-15T00:00:00.000Z",
    ...over,
  };
}

function renderBanner() {
  return render(
    <MemoryRouter>
      <MigrationOfferBanner />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // The probe is memoised at module scope for the page's lifetime, which is the
  // point of it — one request however many consumers mount. Each test is a
  // fresh page load.
  invalidateMigrationProbe();
  localStorage.clear();
  transcriptsMigration.mockReset();
});

describe("MigrationOfferBanner — when it appears", () => {
  it("offers the migration when the server says it is eligible", async () => {
    transcriptsMigration.mockResolvedValue(probe());
    renderBanner();
    const offer = await screen.findByTestId("migration-offer");
    expect(offer).toHaveTextContent("Chats are separate from");
    expect(offer).toHaveTextContent("~/.claude");
    expect(offer).toHaveTextContent("Merge");
  });

  it("still offers it when pendingChats is 0 — the memory-only case", async () => {
    // `.chats/` holding nothing but the agent's `memory/` dir: eligible, and the
    // count of TRANSCRIPTS is zero. A count-driven banner would vanish here, on
    // an instance that genuinely cannot flip the lever until it migrates.
    transcriptsMigration.mockResolvedValue(probe({ pendingChats: 0, pendingProjects: 1 }));
    renderBanner();
    expect(await screen.findByTestId("migration-offer")).toBeInTheDocument();
  });

  it("shows no count in the strip, whatever the size of it", async () => {
    transcriptsMigration.mockResolvedValue(probe({ pendingChats: 2599, pendingProjects: 16 }));
    renderBanner();
    const offer = await screen.findByTestId("migration-offer");
    // Four digits cannot push the readout around because no digit is rendered
    // here at all. The number lives in the dialog, where it can be qualified as
    // the lower bound it is.
    expect(offer.textContent).not.toMatch(/\d/);
  });
});

describe("MigrationOfferBanner — when it stays away", () => {
  for (const reason of ["already-host", "env-shadowed", "nothing-pending", "scan-failed"]) {
    it(`renders nothing for reason "${reason}"`, async () => {
      transcriptsMigration.mockResolvedValue(
        probe({ eligible: false, reason, mode: reason === "already-host" ? "host" : "own" }),
      );
      renderBanner();
      await waitFor(() => expect(transcriptsMigration).toHaveBeenCalled());
      expect(screen.queryByTestId("migration-offer")).not.toBeInTheDocument();
    });
  }

  it("renders nothing for a reason this build has never heard of", async () => {
    // A newer server growing a fifth reason must not produce a crash or a
    // broken chip. Gating on the boolean is what makes that free.
    transcriptsMigration.mockResolvedValue(probe({ eligible: false, reason: "moon-phase" }));
    renderBanner();
    await waitFor(() => expect(transcriptsMigration).toHaveBeenCalled());
    expect(screen.queryByTestId("migration-offer")).not.toBeInTheDocument();
  });

  it("renders nothing when the probe fails, and does not throw", async () => {
    transcriptsMigration.mockRejectedValue(new Error("500"));
    renderBanner();
    await waitFor(() => expect(transcriptsMigration).toHaveBeenCalled());
    expect(screen.queryByTestId("migration-offer")).not.toBeInTheDocument();
  });

  it("survives an api client that has no such method at all", async () => {
    // A synchronous throw inside the mount effect. This component renders in the
    // app shell on every route, so an escape here is a white screen, not a
    // missing chip.
    transcriptsMigration.mockImplementation(() => {
      throw new TypeError("not a function");
    });
    expect(() => renderBanner()).not.toThrow();
    expect(screen.queryByTestId("migration-offer")).not.toBeInTheDocument();
  });

  it("asks once however many consumers mount", async () => {
    transcriptsMigration.mockResolvedValue(probe());
    render(
      <MemoryRouter>
        <MigrationOfferBanner />
        <MigrationOfferCard />
      </MemoryRouter>,
    );
    await screen.findByTestId("migration-offer");
    expect(transcriptsMigration).toHaveBeenCalledTimes(1);
  });
});

describe("MigrationOfferBanner — dismissal", () => {
  it("hides the chip, says where it went, and stays hidden across a reload", async () => {
    transcriptsMigration.mockResolvedValue(probe());
    const user = userEvent.setup();
    const first = renderBanner();

    await screen.findByTestId("migration-offer");
    await user.click(screen.getByTestId("migration-offer-dismiss"));

    expect(screen.queryByTestId("migration-offer")).not.toBeInTheDocument();
    // The toast is the only thing left rendering, and it has to name the place
    // the offer went — a dismissal with no forwarding address loses the feature.
    expect(screen.getByRole("status")).toHaveTextContent(/Config screen/i);
    expect(screen.getByRole("button", { name: "Open Config" })).toBeInTheDocument();

    // A reload: the component remounts and reads the dismissal back off the
    // browser. The probe still says eligible.
    first.unmount();
    invalidateMigrationProbe();
    renderBanner();
    await waitFor(() => expect(transcriptsMigration).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("migration-offer")).not.toBeInTheDocument();
  });

  it("forgets a dismissal once the instance is no longer eligible", async () => {
    // So a dismissal cannot outlive the offer that provoked it: an instance that
    // migrates, and months later finds itself back on `own` with chats pending,
    // gets a fresh offer rather than inheriting one answered long ago.
    localStorage.setItem("paddock:transcriptsMigration:dismissed", "1");
    transcriptsMigration.mockResolvedValue(probe({ eligible: false, reason: "already-host", mode: "host" }));
    renderBanner();
    await waitFor(() =>
      expect(localStorage.getItem("paddock:transcriptsMigration:dismissed")).toBeNull(),
    );
  });

  it("leaves a dismissal alone when the probe merely FAILS", async () => {
    // A server hiccup must not resurrect a banner the user has already answered.
    localStorage.setItem("paddock:transcriptsMigration:dismissed", "1");
    transcriptsMigration.mockRejectedValue(new Error("502"));
    renderBanner();
    await waitFor(() => expect(transcriptsMigration).toHaveBeenCalled());
    expect(localStorage.getItem("paddock:transcriptsMigration:dismissed")).toBe("1");
  });
});

describe("MigrationOfferBanner — the placeholder", () => {
  it("opens a dialog that says plainly it does not do anything yet", async () => {
    transcriptsMigration.mockResolvedValue(probe({ pendingChats: 2599, pendingProjects: 16 }));
    const user = userEvent.setup();
    renderBanner();

    await user.click(await screen.findByRole("button", { name: /Merge/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(/Not built yet/i);
    // The count appears HERE, qualified as the lower bound the schema says it is.
    expect(screen.getByTestId("migration-placeholder-scope")).toHaveTextContent(
      "At least 2,599 chats across 16 projects would move.",
    );
  });

  it("falls back to the project count when pendingChats is 0", async () => {
    transcriptsMigration.mockResolvedValue(probe({ pendingChats: 0, pendingProjects: 1 }));
    const user = userEvent.setup();
    renderBanner();

    await user.click(await screen.findByRole("button", { name: /Merge/ }));
    // Never "0 chats", which reads as a bug on an instance that is genuinely
    // eligible.
    expect(screen.getByTestId("migration-placeholder-scope")).toHaveTextContent(
      "1 project has files waiting to move",
    );
  });
});

describe("MigrationOfferCard — the Config screen's copy", () => {
  it("appears for a paranoid instance, which gets no banner", async () => {
    // Design §10.4: `paranoid` suppresses the banner because a permanent offer to
    // undo the posture you chose is nagging — but the migration itself stays
    // reachable, and this is where.
    transcriptsMigration.mockResolvedValue(probe({ eligible: false, reason: "profile-paranoid" }));
    render(
      <MemoryRouter>
        <MigrationOfferBanner />
        <MigrationOfferCard />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("migration-offer-card")).toBeInTheDocument();
    expect(screen.queryByTestId("migration-offer")).not.toBeInTheDocument();
  });

  it("survives a dismissal that hid the banner", async () => {
    // Otherwise "dismissible yet findable" is a lie and the toast points at an
    // empty screen.
    localStorage.setItem("paddock:transcriptsMigration:dismissed", "1");
    transcriptsMigration.mockResolvedValue(probe());
    render(
      <MemoryRouter>
        <MigrationOfferBanner />
        <MigrationOfferCard />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("migration-offer-card")).toBeInTheDocument();
    expect(screen.queryByTestId("migration-offer")).not.toBeInTheDocument();
  });

  it("stays away when the instance is already on host", async () => {
    transcriptsMigration.mockResolvedValue(
      probe({ mode: "host", eligible: false, reason: "already-host" }),
    );
    render(
      <MemoryRouter>
        <MigrationOfferCard />
      </MemoryRouter>,
    );
    await waitFor(() => expect(transcriptsMigration).toHaveBeenCalled());
    expect(screen.queryByTestId("migration-offer-card")).not.toBeInTheDocument();
  });
});
