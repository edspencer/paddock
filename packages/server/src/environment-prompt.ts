/**
 * Paddock's built-in **environment** system prompt (issue #635).
 *
 * Paddock injects no system prompt of its own: on a default instance the keeper
 * runs on Claude Code's stock `claude_code` preset, which is written for a
 * terminal. Nothing anywhere tells the model that its replies are rendered as
 * GitHub-Flavored Markdown in a browser (`MarkdownRenderer.tsx` = react-markdown
 * + remark-gfm), or that `mcp__paddock__send_file` renders a file inline.
 *
 * This text is a small **append** to whatever system prompt the agent already
 * has — it states environmental fact about the deployment, and deliberately does
 * not instruct on role, tone or workflow (that is the `CLAUDE.md` hierarchy's
 * layer, and it stays the user's).
 *
 * ## Why exactly two rules
 *
 * The text is not written from first principles — an earlier draft was, and the
 * audit in issue #635 refuted most of it. It comes from auditing the 100 most
 * recent chats on the dogfood instance (3,944 assistant text blocks, 2.1 MB of
 * user-facing prose). Two findings carried ~90% of the measured value:
 *
 *  - **`#123` is dead text.** 4,440 bare refs vs 155 markdown links. Bare URLs
 *    autolink under GFM and came out fine (only 4 inert, all backticked), so the
 *    defect is specifically issue/PR refs — and it is not inability: single
 *    messages link some refs and leave others bare.
 *  - **Visual work is described, never shown.** 194 image reads, 138
 *    screenshots, and **zero** images ever sent to a user. `send_file` was used
 *    10 times, none of them an image. In one chat this cost a full re-work round
 *    — the agent read 17 QC frames, showed none, misread one, and shipped a
 *    regression the user then had to screenshot themselves.
 *
 * Things measured and deliberately **cut**, so they don't get re-added: "no ANSI
 * colour" (0 escapes in 2.1 MB), "don't paste long content" (0 fences ≥40 lines;
 * median fence is 3), "use markdown structure" (580 headings, 892 bullets, 101
 * well-formed tables — already excellent), `file.ts:123` guidance (real but
 * low-stakes; 72 of 75 sampled sit in backticks beside the symbol name), and
 * mermaid (0 genuine missed opportunities; an instruction would over-trigger).
 *
 * ## Keep in sync
 *
 * The `send_file` tool description (`send-file-mcp.ts`) is the only other
 * Paddock-aware signal in a normal turn. These two are the same message told
 * twice; change one and re-read the other.
 */

/**
 * The default environment prompt appended to every keeper turn unless the
 * instance overrides or opts out (see `environmentPrompt` in config.ts).
 *
 * Kept verbatim from issue #635's evidence pass. Resist adding a third rule
 * without measurement — several plausible candidates were cut above.
 */
export const DEFAULT_ENVIRONMENT_PROMPT = `You are running in Paddock, a web app — your replies render as GitHub-Flavored
Markdown in a browser, not as terminal output.

- Show, don't describe. A screenshot, rendering, chart or file the user is meant
  to look at should be sent with \`mcp__paddock__send_file\`, which renders it
  inline. A filesystem path, or "it's up on port 5026", leaves them unable to see
  your evidence — or to catch you misreading it.
- Make clickable things clickable. Bare URLs autolink; \`#123\` does not — write
  \`[#123](https://github.com/owner/repo/issues/123)\`. Prefer a full URL to a bare
  port number, and link a chat or project rather than quoting its id.`;
