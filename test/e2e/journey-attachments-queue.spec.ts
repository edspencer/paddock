import { test, expect, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createProjectViaUI, paths, sendChatTurn, uniq } from "./helpers";

/**
 * Journey: composer attachments and the message queue (#728).
 *
 * Attachments had ZERO E2E coverage, and the composer's staging lifecycle is pure
 * client state — the server's upload endpoint (covered by
 * `attachments-upload.test.ts`) never sees the tray at all. So the browser is the
 * only tier that can observe the bug this file locks down: a file staged while a
 * turn was in flight was never consumed by ENQUEUEING, only by sending. The queue
 * is flushed server-side, so `sendText` — the sole consumer of the tray — never
 * ran for a queued message. The tray stayed populated and the file silently rode
 * whatever the user sent NEXT, which is a data-exposure bug, not a cosmetic one.
 *
 * Every test here fails on `main`.
 */

/**
 * The composer textarea. Located by BOTH placeholders on purpose: while a turn
 * streams the placeholder flips to "Queue a message to send next…", so a locator
 * pinned to "Message Claude" silently blocks until the turn ends — which is
 * exactly the window every test in this file needs to act inside.
 */
function composerBox(page: Page) {
  return page.getByPlaceholder(/Message Claude|Queue a message/i);
}

/**
 * Stage a file in the composer.
 *
 * Uses an in-page `DataTransfer` rather than Playwright's `setInputFiles`:
 * `setInputFiles` silently yields ZERO files for a non-ASCII filename over CDP,
 * so a unicode-named attachment quietly becomes "no attachment" and the test
 * passes for the wrong reason. Building the `File` in the page avoids the CDP
 * round trip entirely, and is the same code path a real drag-drop takes.
 */
async function attachFile(page: Page, filename: string, body = "hello from a file"): Promise<void> {
  const chip = page.getByTestId("attachment-tray-item").filter({ hasText: filename });
  // ChatPane remounts for a beat after a project is created / a chat is opened
  // (the projects-context refetch), and an upload that resolves into an unmounted
  // pane is dropped on the floor. Retry rather than sleep on a guessed interval.
  await expect(composerBox(page)).toBeVisible({ timeout: 15_000 });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.evaluate(
      ({ filename, body }) => {
        const input = document.querySelector<HTMLInputElement>('[data-testid="attachment-input"]');
        if (!input) return; // pane mid-remount; the retry below handles it
        const dt = new DataTransfer();
        dt.items.add(new File([body], filename, { type: "text/plain" }));
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      { filename, body },
    );
    try {
      await chip.waitFor({ state: "visible", timeout: 5_000 });
      return;
    } catch {
      /* pane was mid-remount — try again */
    }
    await expect(composerBox(page)).toBeVisible({ timeout: 15_000 });
  }
  await expect(chip, `attachment "${filename}" never staged`).toBeVisible({ timeout: 5_000 });
}

/** Read every user prompt the fake claude was handed for this project, in order. */
function userPrompts(slug: string): string[] {
  const { projectsDir } = paths();
  const chats = path.join(projectsDir, slug, ".chats");
  const files = readdirSync(chats).filter((f) => f.endsWith(".jsonl"));
  const out: string[] = [];
  for (const f of files) {
    for (const line of readFileSync(path.join(chats, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let m: {
        type?: string;
        message?: { role?: string; content?: unknown };
      };
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.type !== "user" || m.message?.role !== "user") continue;
      const c = m.message.content;
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c
                .map((b) =>
                  b && typeof b === "object" && (b as { type?: string }).type === "text"
                    ? String((b as { text?: string }).text ?? "")
                    : "",
                )
                .join("")
            : "";
      if (text) out.push(text);
    }
  }
  return out;
}

test("a message queued mid-turn takes its attachment WITH it, not onto the next message", async ({
  page,
}) => {
  const slug = await createProjectViaUI(page, { name: uniq("AQ Queue") });
  // The preload `<project-context>` block means the reply is no longer a literal
  // echo of the message, so match the prefix rather than the whole thing.
  await sendChatTurn(page, "kick off", { expectReply: /Acknowledged:/ });

  // Hold a turn in flight. While it streams, Send is replaced by Stop, so Enter
  // is the only way to submit — which is exactly the path that ignored the tray.
  const composer = composerBox(page);
  await composer.fill("[[SLOWTOOL]] hold the turn");
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.locator('button[aria-label="Stop"]')).toBeVisible({ timeout: 15_000 });

  await attachFile(page, "queued-file.txt");
  await composer.fill("QUEUEDMSG please read the attachment");
  await composer.press("Enter");

  // Enqueueing CONSUMES the tray, exactly as sending does. On `main` the chip
  // stayed here and went out with the NEXT message.
  await expect(page.getByTestId("attachment-tray-item")).toHaveCount(0);
  // …and the queued toolbar accounts for the file, so it is still visible
  // somewhere: the queue is where it lives now.
  await expect(page.getByTestId("queued-attachment-count")).toBeVisible();

  // The server drains it when the turn ends; the flushed user bubble renders with
  // its attachment chip.
  await expect(page.getByText(/QUEUEDMSG please read the attachment/).first()).toBeVisible({
    timeout: 40_000,
  });
  await expect(
    page.getByTestId("attachment-chip").filter({ hasText: "queued-file.txt" }),
  ).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId("queued-attachment-count")).toHaveCount(0);

  // Now the part that actually made this a data-exposure bug: send something
  // unrelated and prove the file did NOT ride it.
  // NOT the loose /Acknowledged:/ matcher here: the transcript already holds
  // earlier replies, so a loose match returns before this turn has even been
  // written. The default matcher is the literal echo of THIS message.
  await sendChatTurn(page, "POSTQUEUE unrelated message");

  const prompts = userPrompts(slug);
  const queuedPrompt = prompts.find((p) => p.includes("QUEUEDMSG please read the attachment"));
  const unrelated = prompts.find((p) => p.includes("POSTQUEUE unrelated message"));
  expect(queuedPrompt, "the queued message reached the agent").toBeTruthy();
  expect(unrelated, "the later message reached the agent").toBeTruthy();
  expect(queuedPrompt, "the attachment rode the QUEUED message").toContain(
    "<paddock-attachments>",
  );
  expect(queuedPrompt).toContain("queued-file.txt");
  expect(unrelated, "the attachment must NOT ride the next, unrelated message").not.toContain(
    "<paddock-attachments>",
  );
});

test("an attachment-only submit during a live turn queues instead of silently no-opping", async ({
  page,
}) => {
  await createProjectViaUI(page, { name: uniq("AQ AttOnly") });
  await sendChatTurn(page, "kick off", { expectReply: /Acknowledged:/ });

  const composer = composerBox(page);
  await composer.fill("[[SLOWTOOL]] hold the turn");
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.locator('button[aria-label="Stop"]')).toBeVisible({ timeout: 15_000 });

  await attachFile(page, "solo.txt");
  // No text at all — an image/file-only message is valid (#328). On `main` this
  // passed the send guard, called setQueued("") — falsy — and did nothing: no
  // queue, no toolbar, no error.
  await composer.press("Enter");

  await expect(page.getByTestId("attachment-tray-item")).toHaveCount(0);
  await expect(page.getByText(/1 attachment/)).toBeVisible();

  // It drains as its own turn when the slow tool finishes.
  await expect(page.getByTestId("attachment-chip").filter({ hasText: "solo.txt" })).toBeVisible({
    timeout: 40_000,
  });
});

test("Stop hands a queued message's attachments back to the tray, not just its text", async ({
  page,
}) => {
  await createProjectViaUI(page, { name: uniq("AQ Halt") });
  await sendChatTurn(page, "kick off", { expectReply: /Acknowledged:/ });

  const composer = composerBox(page);
  await composer.fill("[[SLOWTOOL]] hold the turn");
  await page.getByRole("button", { name: /^Send$/ }).click();
  const stop = page.locator('button[aria-label="Stop"]');
  await expect(stop).toBeVisible({ timeout: 15_000 });

  await attachFile(page, "returned.txt");
  await composer.fill("STOPME queued behind the turn");
  await composer.press("Enter");
  await expect(page.getByTestId("attachment-tray-item")).toHaveCount(0);

  // #751 returns a queued message to the composer on Stop rather than sending it.
  // The message is being handed back WHOLE, so its files come back too — leaving
  // them on the cleared slot would strand them server-side.
  await stop.click();
  await expect(composer).toHaveValue(/STOPME queued behind the turn/, { timeout: 20_000 });
  await expect(
    page.getByTestId("attachment-tray-item").filter({ hasText: "returned.txt" }),
  ).toBeVisible({ timeout: 20_000 });
});

test("a file staged on an ABANDONED new chat does not follow the next new chat", async ({
  page,
}) => {
  await createProjectViaUI(page, { name: uniq("AQ NewChat") });

  // Stage on a brand-new, never-sent chat, then walk away from it.
  await attachFile(page, "abandoned.txt");
  await page.getByRole("button", { name: /New Chat/i }).click();

  // On `main` the pre-session tray was keyed "new:<slug>" — ONE key shared by
  // every future new chat in the project — so the chip came back here, pre-staged
  // and easy to miss, and rode the first message of a conversation it had nothing
  // to do with.
  await expect(page.getByTestId("attachment-tray-item")).toHaveCount(0);

  // …and returning to the same new chat by navigating away and back still keeps
  // it (#346), which is the behaviour the per-instance key has to preserve.
  await attachFile(page, "kept.txt");
  await page.getByRole("main").getByRole("button", { name: "Files", exact: true }).click();
  await page.goBack();
  await expect(
    page.getByTestId("attachment-tray-item").filter({ hasText: "kept.txt" }),
  ).toBeVisible({ timeout: 15_000 });
});

test("a slash command leaves staged files in the tray — visibly, rather than silently dropping them", async ({
  page,
}) => {
  await createProjectViaUI(page, { name: uniq("AQ Slash") });
  await sendChatTurn(page, "kick off", { expectReply: /Acknowledged:/ });

  const composer = composerBox(page);
  await composer.fill("[[SLOWTOOL]] hold the turn");
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.locator('button[aria-label="Stop"]')).toBeVisible({ timeout: 15_000 });

  await attachFile(page, "kept-through-slash.txt");
  // A slash command is dispatched by the CLI and cannot carry attachments — the
  // live send path has always excluded them. The audit called for clearing the
  // tray here; that would reintroduce exactly the silent drop #346 exists to
  // prevent (the user's uploaded file, gone, with no way to get it back). So the
  // files STAY, and stay VISIBLE: the chip in the tray is the honest statement
  // that they will go out with the next real message. What must not happen is
  // them travelling invisibly, which is what the queue path did.
  await composer.fill("/compact");
  await composer.press("Enter");

  await expect(
    page.getByTestId("attachment-tray-item").filter({ hasText: "kept-through-slash.txt" }),
  ).toBeVisible();
  // …and the queue slot did NOT take them, so nothing is staged in two places at
  // once (the duplicate-key state the audit also flagged).
  await expect(page.getByTestId("queued-attachment-count")).toHaveCount(0);
});
