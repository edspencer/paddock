import { test, expect, type Page } from "@playwright/test";
import { createProjectViaUI, sendChatTurn, uniq } from "./helpers";

/**
 * Journey: a BACKGROUND sub-agent that outlives its parent turn (#725).
 *
 * ## Why this is a browser test and not a unit test
 *
 * The defect was mount-scoped client state — `useSubagentActivity` armed
 * polling in a `useRef` while the parent turn was live, so a component
 * REMOUNT arrived with nothing armed and the poll loop never ran. There is no
 * way to observe that without actually unmounting and remounting the pane, and
 * the two ways a user does it are a tab switch (`ChatPane` is rendered behind
 * `view === "chat"`, so switching to Files unmounts it outright) and a reload.
 * Both arms are here; the reload arm is separate because it re-derives
 * everything from `/messages` rather than from the client's existing turn list,
 * and the reported symptom was specifically that a reload did NOT recover.
 *
 * ## Why `[[BGSUBAGENT]]` and not `[[SLOWTOOL]]` / `[[SUBAGENT]]`
 *
 * Sub-agent progress is never streamed over the WebSocket — the server strips
 * every sidechain message out of the parent stream, and the client learns about
 * sub-agents purely by REST polling. A LIVE PARENT TURN IS WHAT KEEPS THAT POLL
 * ALIVE, so any directive that holds the parent turn open makes a
 * nav-away/nav-back test pass while the bug is live. That is exactly how this
 * shipped: the state was unreachable in the harness for months and the naive
 * test was green.
 *
 * `[[BGSUBAGENT]]` (#739) is the only directive that detaches the two: the
 * `Task` tool_result is written immediately, the parent turn runs on to its
 * terminal `result`, and the sub-agent keeps appending steps to its own sidecar
 * afterwards. The precondition is asserted directly, and independently of the
 * UI, by `packages/server/test/integration/ws-subagent-background.test.ts` —
 * which pins that the parent turn ends first AND that `/messages` then serves
 * the `Task` with `hasSubagent: true` and NO `subagentDurationMs` (the server's
 * finished signal, #725 cause A). If either stops holding, this spec is
 * measuring nothing, and that file goes red first.
 *
 * The turn is asserted COMPLETE here before any navigation, so a pass can never
 * be explained by the parent turn still holding the poll open.
 */

/**
 * Highest `BG_STEP_<n>` the EXPANDED CARD is showing.
 *
 * Scoped to the card's own step list on purpose: the running bar renders the
 * latest step too, so a page-wide scan would keep climbing on the bar alone
 * while the card sat frozen — which is one of the two symptoms.
 */
async function latestStep(page: Page): Promise<number> {
  const texts = await page.getByTestId("subagent-steps").first().allInnerTexts();
  const ns = texts.flatMap((t) => [...t.matchAll(/BG_STEP_(\d+)/g)].map((m) => Number(m[1])));
  return ns.length ? Math.max(...ns) : 0;
}

/** The bar, the card's running chip, and a step list that keeps moving. */
async function expectStillRunning(page: Page, where: string): Promise<void> {
  await expect(page.getByTestId("running-subagents"), `bar (${where})`).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTitle("Sub-agent is running").first(), `card (${where})`).toBeVisible({
    timeout: 15_000,
  });

  // Expand the card and watch its steps advance. A frozen expanded step list was
  // the audit's sharpest symptom, and it is the strongest signal available: the
  // bar can be right for a moment on stale state, but a list that keeps growing
  // can only come from a poll that is still running.
  await page.getByRole("button", { name: /general-purpose/i }).first().click();
  await expect
    .poll(() => latestStep(page), {
      message: `no steps rendered in the expanded card (${where})`,
      timeout: 15_000,
      intervals: [500],
    })
    .toBeGreaterThan(0);
  const before = await latestStep(page);
  await expect
    .poll(() => latestStep(page), {
      message: `expanded step list stopped updating (${where})`,
      timeout: 15_000,
      intervals: [500],
    })
    .toBeGreaterThan(before);
}

test("a running sub-agent survives navigating away and back, and a reload (#725)", async ({
  page,
}) => {
  // Three observation windows (initial, after the tab switch, after the reload),
  // each waiting on a 2s REST poll cadence and preceded by a turn completion,
  // do not fit the suite's 60s default. PADDOCK_FAKE_BGSUBAGENT_MS is set beyond
  // this so the sub-agent cannot settle mid-test.
  test.setTimeout(120_000);

  await createProjectViaUI(page, { name: uniq("SA Background") });

  // NOT the literal-echo matcher: once a project has an OVERVIEW.md the preload
  // injects a <project-context> block, so the reply is no longer
  // "Acknowledged: <message>" verbatim.
  await sendChatTurn(page, "spawn one [[BGSUBAGENT]]", { expectReply: /Acknowledged:/i });

  // The PRECONDITION, asserted before anything else: the parent turn is over
  // (Stop is gone, Send is back) while the sub-agent is still working. Without
  // this the whole spec is vacuous — a live parent turn masks the bug, which is
  // the entire reason it went unnoticed. Read off Stop specifically because the
  // pane's `streaming` flag is what used to arm the poll; the server agreeing is
  // not enough.
  //
  // Generously timed: `chat:complete` lands within a second when this spec runs
  // alone, but it is driven by herdctl's transcript watcher, and under a loaded
  // full-suite run it has been seen to take tens of seconds. Waiting costs
  // nothing in the common case and a slow completion is not this bug.
  await expect(page.getByRole("button", { name: /Stop/ })).toHaveCount(0, { timeout: 45_000 });
  await expect(page.getByRole("button", { name: /^Send$/ })).toBeVisible();
  await expectStillRunning(page, "before navigating");
  const chatUrl = page.url();

  // ── arm 1: tab switch (a real unmount of ChatPane, no page load) ──────────
  // Back rather than the Chat tab: that tab navigates to the bare `/chat`, i.e.
  // a NEW chat, which would drop this session entirely and prove nothing.
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByTestId("running-subagents")).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(chatUrl);
  await expectStillRunning(page, "after navigating back");

  // ── arm 2: full reload (rehydrates from /messages, a separate path) ───────
  await page.reload();
  await expectStillRunning(page, "after reload");
});
