import { test, expect } from "@playwright/test";
import { createProjectViaUI, uniq } from "./helpers";

/**
 * Journey: sub-agents that FINISH while their parent turn is still streaming
 * must leave the running-work bar (#911).
 *
 * ## The bug
 *
 * An agent that fans out, waits, and fans out again accumulated finished rows:
 * five completed deep-reads sat in the bar beside three live edits, under a
 * header reading "8 sub-agents running", until the whole turn ended. Both of the
 * client's exits from "running" were unreachable mid-turn — `subagentDurationMs`
 * is only published on the history join, and the silence-settle is gated on the
 * PARENT's streaming state. The fix adopts the server's live registry as a
 * positive finished-signal: a task it showed us and then evicted is done.
 *
 * ## Why this is a browser test
 *
 * The hook tier (`useSubagentFinished.test.tsx`) proves the verdict is applied,
 * but it supplies the verdict itself. What it cannot prove is that the verdict
 * ever ARRIVES — that the `tool_use_id` the registry folds onto a `local_agent`
 * task is the same id the transcript-derived row is keyed by. Those two ids are
 * produced by different layers and only meet in the browser; if they disagree,
 * every hook test still passes and the bar still never clears. That join is
 * exactly what this spec exercises, with both halves produced by one real run.
 *
 * The count in the header is asserted as well as the rows, because the header is
 * what the user reads first and it was the loudest part of the wrong state.
 */
test("finished sub-agents leave the running-work bar while the parent turn runs on (#911)", async ({
  page,
}) => {
  await createProjectViaUI(page, { name: uniq("Sub-agent Waves") });

  // Five sub-agents that finish mid-turn, then three that keep working — the
  // shape from the original report. The fake holds the parent turn open across
  // both waves, so everything below is asserted against a STREAMING chat.
  await page
    .getByPlaceholder(/Message Claude/i)
    .fill("read the returns then update the files [[SUBAGENTWAVES:5:3]]");
  await page.getByRole("button", { name: /^Send$/ }).click();

  const bar = page.getByTestId("running-work");
  await expect(bar).toBeVisible({ timeout: 30_000 });

  // Wave 1 is live first: the bar has to actually fill before it can be proven
  // to drain, or a fix that simply never shows sub-agents would pass this.
  const rows = bar.getByTestId("running-subagent-row");
  await expect(rows.filter({ hasText: "Deep-read" })).toHaveCount(5, { timeout: 30_000 });

  // The bar auto-collapses above four rows (#847), so expand it to read them.
  const toggle = bar.getByTestId("running-work-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();

  // ── The assertion ────────────────────────────────────────────────────────
  // Wave 1 completes; wave 2 launches; the turn keeps streaming throughout. On
  // main the bar goes to eight rows here and stays there. The finished five must
  // drain while the live three remain.
  await expect(rows.filter({ hasText: "Deep-read" })).toHaveCount(0, { timeout: 30_000 });
  await expect(rows.filter({ hasText: "Update" })).toHaveCount(3);

  // The header counts what is actually running, not what has ever run.
  await expect(bar.getByTestId("running-work-toggle")).toContainText(/3 sub-agents running/i, {
    timeout: 10_000,
  });

  // The CONTROL: the chat is still streaming. Without this the test would also
  // pass against a build that simply tore the bar down when the turn ended,
  // which is the pre-existing behaviour the bug is about.
  await expect(page.getByTestId("running-work")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Stop$/ })).toBeVisible();

  // And the finished sub-agents' CARDS stop claiming RUNNING too — the same
  // `liveActivity.running` drives both, so a fix applied only to the bar would
  // leave five cards lying in the transcript. The card has no testid, so it is
  // reached through its header button, whose title is the sub-agent's spinner
  // tooltip; counting those is the cheapest honest form of the assertion.
  await expect(page.locator('[title="Sub-agent is running"]')).toHaveCount(3, {
    timeout: 15_000,
  });
});
