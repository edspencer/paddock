import { test, expect } from "@playwright/test";
import { createProjectViaUI, sendChatTurn, uniq } from "./helpers";

/**
 * Journey: the full-screen sent-file viewer (#944).
 *
 * The fake `claude` sends three inline files ([[SENDFILES:3]] — see
 * test/bin/claude). Maximizing the middle one opens the chat-wide viewer, and
 * ←/→ step through the others. Run twice over the same chat: once on the LIVE
 * turns the socket built, once after a reload rebuilds them from the transcript
 * — the two paths assign different turn ids, and the viewer keys on those.
 */
test("maximize a sent file and step through the chat's files with ←/→ (live + on reload)", async ({
  page,
}) => {
  const slug = await createProjectViaUI(page, { name: uniq("Sent Viewer") });
  await sendChatTurn(page, "send me three files [[SENDFILES:3]]", {
    expectReply: /Acknowledged:/i,
  });

  const walk = async () => {
    await page.getByRole("button", { name: "Maximize sent-2.txt" }).click();
    const viewer = page.getByRole("dialog");
    await expect(viewer).toHaveAccessibleName("sent-2.txt");
    await expect(viewer.getByText("2 / 3")).toBeVisible();
    await expect(viewer.getByText("sent file 2 of 3")).toBeVisible();

    await page.keyboard.press("ArrowRight");
    await expect(viewer).toHaveAccessibleName("sent-3.txt");
    await expect(viewer.getByRole("button", { name: "Next file" })).toBeDisabled();

    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(viewer).toHaveAccessibleName("sent-1.txt");
    await expect(viewer.getByText("sent file 1 of 3")).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Previous file" })).toBeDisabled();

    // Stepping scrolled the transcript to the file's row behind the viewer.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("[data-sent-file-turn]").first()).toBeInViewport();
  };

  await walk();

  await expect(page).toHaveURL(new RegExp(`/projects/${slug}/chat/[a-z0-9-]+`), {
    timeout: 15_000,
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "Maximize sent-3.txt" })).toBeVisible({
    timeout: 15_000,
  });
  await walk();
});
