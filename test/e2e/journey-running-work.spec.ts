import { test, expect } from "@playwright/test";
import { createProjectViaUI, uniq } from "./helpers";

/**
 * Journey: a background shell's COMMAND in the running-work bar (#853).
 *
 * ## Why this is a browser test
 *
 * The command is not on the registry's wire. It is recovered by JOINING two
 * independent sources that meet only in the browser:
 *
 *  - the live background-task registry, whose `task_started` edge folds a
 *    `tool_use_id` onto the task; and
 *  - the transcript, whose Bash tool call carries the command as its
 *    `inputSummary`.
 *
 * A component test has to supply both halves itself, so it can only ever prove
 * that the lookup works on ids it invented. The failure this is here to catch is
 * the two sources DISAGREEING — the registry folding one id while the tool frame
 * carries another, or the summary not being the command at all. That needs both
 * halves produced by the same run, which is what the fake `claude`'s
 * `[[BGTASK]]` directive now does: it emits the real launching
 * `Bash` tool_use/tool_result pair and puts that pair's id on the task edges,
 * exactly as the CLI does.
 *
 * The complementary server-tier assertion — that the id reaches the wire on a
 * LIVE frame rather than only via history — is
 * `packages/server/test/integration/ws-background.test.ts`. This spec is the
 * proof it renders.
 */
test("the running-work bar shows a background shell's command, not just its description (#853)", async ({
  page,
}) => {
  await createProjectViaUI(page, { name: uniq("Bar Command") });

  // NOT the literal-echo matcher: a project with an OVERVIEW.md gets a
  // <project-context> preload block, so the reply is not "Acknowledged: <msg>".
  await page.getByPlaceholder(/Message Claude/i).fill("kick off a poll [[BGTASK]]");
  await page.getByRole("button", { name: /^Send$/ }).click();

  const bar = page.getByTestId("running-work");
  await expect(bar).toBeVisible({ timeout: 30_000 });

  // The shell row's wide column is the COMMAND, joined from the transcript —
  // the thing that made fifteen identical wedged polls obvious at a glance.
  const detail = bar.getByTestId("running-task-detail").first();
  await expect(detail).toContainText("SCANDONE", { timeout: 30_000 });
  await expect(detail).toContainText("2>/dev/null");

  // And the description is kept beside it rather than replaced by it: the gap
  // between stated intent and actual command is the whole diagnostic.
  await expect(bar.getByTestId("running-task-intent").first()).toContainText("wait for CI");

  // One truncating line, whatever the command's length — the bar docks above the
  // composer and must not grow into the conversation.
  await expect(detail).toHaveClass(/truncate/);
});
