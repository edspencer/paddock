import type { Tip } from "./types";
// Tips for the onboarding card's Tips tab.
//
// The card shows exactly ONE of these at a time, chosen at random, with nothing
// around it (#865). So every tip is written to be read cold and out of order:
// no "as mentioned above", no assumed previous tip, nothing that reads like
// item 7 of a list, and no dependency on which tab or entry the reader saw last.
//
// The bar for inclusion: specific, non-obvious and actionable. Something a
// competent user would not guess and is glad to learn — a hidden affordance, a
// config key that fixes a real annoyance, a default that surprises people, a
// gotcha worth knowing before it bites. "Paddock has projects" is not a tip.
//
// Every one of these was harvested from the documentation under
// `website/src/content/docs/`, and the load-bearing ones were checked against
// the code rather than trusted from the prose.

// The sibling PR for #865 lands `./types.js` with these exact interfaces and
// will consolidate this declaration; it did not exist on main when this file
// was written.

const DOCS = "https://paddock.edspencer.net";

export const TIPS: Tip[] = [
  // ── The composer and the chat itself ──────────────────────────────────────
  {
    id: "paste-a-screenshot-into-the-composer",
    title: "Paste a screenshot straight into the composer",
    body: "Ctrl+V or Cmd+V with the composer focused attaches whatever is on your clipboard, and dragging files onto it works too. A message with an attachment can be sent with no text at all.",
    href: `${DOCS}/using/sending-files-and-images/#three-ways-to-attach`,
  },
  {
    id: "queue-a-message-mid-turn",
    title: "Type while Claude is still working",
    body: "A message typed during a turn is queued on the server and sent the moment that turn finishes, so it survives a reload and a closed tab. Pressing Stop hands it back to the composer rather than sending it.",
    href: `${DOCS}/using/working-in-chats/#type-while-a-turn-is-running-the-queue`,
  },
  {
    id: "link-to-a-single-message",
    title: "Deep-link to one message in a chat",
    body: "Hover any settled message and click the small time and context chip: it copies a link to that exact message. Opening it loads the chat, scrolls to the message and flashes it.",
    href: `${DOCS}/using/working-in-chats/#hover-a-message-time-context-link-fork-and-rewind`,
  },
  {
    id: "revert-rewinds-the-transcript",
    title: "Revert rewinds the chat, not the world",
    body: "Reverting a conversation back to a message removes the tail of the transcript, but files written, commits pushed and messages sent are not undone. The discarded tail is backed up rather than destroyed.",
    href: `${DOCS}/using/working-in-chats/#hover-a-message-time-context-link-fork-and-rewind`,
  },
  {
    id: "your-first-message-names-the-chat",
    title: "Your first message names the chat",
    body: "The chat list shows your opening prompt in full, not a summary, so a chat is as findable later as that first line is descriptive. You can rename it afterwards from the row's hover actions.",
    href: `${DOCS}/using/working-in-chats/#start-a-chat`,
  },
  {
    id: "shift-click-a-chat-family",
    title: "Shift-click acts on a whole family",
    body: "When a chat has spawned or forked children nested beneath it, Shift-clicking archive, delete or mark-read on its row applies to the whole subtree instead of just that one chat. The tooltip tells you how many it would hit.",
    href: `${DOCS}/using/working-in-chats/#nested-chats--a-fan-out-reads-as-a-tree`,
  },
  {
    id: "close-the-laptop-mid-turn",
    title: "You can close the laptop mid-turn",
    body: "The turn keeps running on the server, and when you reconnect the client replays the frames you missed rather than restarting the stream. If you were away long enough for the buffer to age out, it re-reads the transcript instead.",
    href: `${DOCS}/using/working-in-chats/#resume-from-anywhere`,
  },
  {
    id: "drafts-are-per-browser",
    title: "Drafts stay in the browser that typed them",
    body: "An unsent draft is kept per chat in local storage, so it is still there tomorrow — but it never follows you to another device. Read state, stars and archiving are server-side and do follow you.",
    href: `${DOCS}/using/working-in-chats/#the-composer`,
  },
  {
    id: "search-reaches-archived-chats",
    title: "Chat search reaches archived chats",
    body: "The Search chats box filters on both name and first-message preview, and it looks inside the Archived section too. A match pulls its parent rows into view as scaffolding, and your folded state comes back when you clear the box.",
    href: `${DOCS}/using/working-in-chats/#search`,
  },

  // ── Files, changes, and what Claude sends back ────────────────────────────
  {
    id: "pin-a-file-as-a-tab",
    title: "Pin any file as a project tab",
    body: "From the Files tab you can pin a file at any depth, and it becomes a tab in the project header with its own URL. Nested pins show just the basename — hover for the full path.",
    href: `${DOCS}/using/reading-claudes-work/#pin-a-file-as-a-tab--at-any-depth`,
  },
  {
    id: "commit-only-some-files",
    title: "Commit only some of the changes",
    body: "The Changes tab gives every changed file a checkbox, so you can commit a subset instead of everything at once. The projects grid also flags each project's uncommitted-file count before you open it.",
    href: `${DOCS}/using/reading-claudes-work/#review-and-commit-the-changes-tab`,
  },
  {
    id: "ask-claude-to-send-a-file",
    title: "Ask Claude to send you a file",
    body: "Every turn can render a file inline in the chat — a chart, a screenshot, a generated report — rather than telling you a path you would have to go and open. Just ask for the file itself.",
    href: `${DOCS}/guides/agent-capabilities/#reach-where-an-agent-can-go`,
  },

  // ── Projects, settings, and the curated notes ─────────────────────────────
  {
    id: "curated-notes-is-the-only-managed-section",
    title: "CLAUDE.md has a section Paddock owns",
    body: "In a managed project the automatic curator rewrites only the body under the ## Curated notes heading. Everything you write above that heading is preserved verbatim, sweep after sweep.",
    href: `${DOCS}/concepts/sweeper/#what-it-produces`,
  },
  {
    id: "the-sweeper-rewrites-whole-files",
    title: "OVERVIEW.md and CHANGELOG.md get rewritten",
    body: "Curation is a full-file rewrite, not an append, so hand edits to those two files can be reworded or dropped on the next sweep. Anything you want kept permanently belongs above the curated heading in CLAUDE.md, or in a file nothing curates.",
    href: `${DOCS}/concepts/sweeper/#what-it-produces`,
  },
  {
    id: "steer-the-curator-with-a-file",
    title: "Steer the curator with one file",
    body: "Drop a .paddock/hooks/sweep.md into a project and its contents are appended to the curator's prompt every sweep — \"always keep a Glossary section\", say. It is git-tracked, has no UI, and changes only how the notes are written.",
    href: `${DOCS}/using/automating-with-hooks/#steer-the-built-in-curator`,
  },
  {
    id: "preload-context-is-a-composer-toggle",
    title: "Preload project context is on the composer",
    body: "The switch that feeds a project's curated OVERVIEW.md and CHANGELOG.md into a chat lives on the composer, not in Settings, and it only acts on the first turn of a new chat. On a brand-new project it sits disabled until the curator has written something.",
    href: `${DOCS}/using/creating-and-organizing-projects/#preload-project-context-in-the-composer-not-settings`,
  },
  {
    id: "saving-settings-freezes-four-fields",
    title: "Saving Settings pins four fields",
    body: "The first save on a project's Settings tab writes model, permission mode, max turns and Docker into its project.yaml as concrete values, so they stop tracking the instance default. Drive mode, max spawn depth, offered models and the curation budgets keep inheriting.",
    href: `${DOCS}/using/creating-and-organizing-projects/#tune-the-agent-the-settings-tab`,
  },
  {
    id: "a-projects-directory-is-permanent",
    title: "A project's directory can never move",
    body: "The working directory is baked into the path of every transcript, so it is fixed at creation and there is no re-point later. Moving the directory on disk strands that project's chat history.",
    href: `${DOCS}/concepts/projects/#axis-2--where-the-content-lives`,
  },
  {
    id: "areas-are-not-a-fixed-list",
    title: "Areas are not a fixed list",
    body: "The Settings dropdown offers Homelab, House, Side Projects and Unsorted, but the field is a free-form string: set group: in a project's project.yaml to invent your own and the dropdown offers it from then on.",
    href: `${DOCS}/using/creating-and-organizing-projects/#organize-projects-into-areas`,
  },

  // ── Triggers and schedules ────────────────────────────────────────────────
  {
    id: "new-triggers-start-disabled",
    title: "A new trigger is saved disabled",
    body: "Writing a schedule or an event hook never arms it — every trigger is created with enabled false and fires nothing until you flip it. \"I created it and it never ran\" is almost always this.",
    href: `${DOCS}/using/scheduling-recurring-work/#add-a-schedule-from-the-triggers-tab`,
  },
  {
    id: "run-a-trigger-on-demand",
    title: "Fire a trigger now to test it",
    body: "Running a trigger by hand goes down the same path a real firing takes and works even while the trigger is still disabled. You never have to wait until 9am to find out whether the prompt was any good.",
    href: `${DOCS}/reference/schedules/#the-trigger-schema-schedule`,
  },
  {
    id: "an-empty-tool-list-means-every-tool",
    title: "A schedule with no tool list gets everything",
    body: "Leaving a schedule's tool allow-list empty reads like \"no tools\" and means the opposite: the firing runs as the project's own agent with the full toolset, Bash included. Naming even one tool moves it onto its own scoped agent.",
    href: `${DOCS}/guides/agent-capabilities/#scoped-agents-triggers-and-hooks`,
  },
  {
    id: "trigger-prompts-can-live-in-git",
    title: "A trigger's prompt can live in git",
    body: "Instead of pasting text into the form, point a trigger at a .md file under the project's .paddock/triggers/ directory. It is read fresh on every firing, so a long runbook prompt can evolve in version control.",
    href: `${DOCS}/using/automating-with-hooks/#create-an-onarchive-hook`,
  },
  {
    id: "accrete-into-one-session",
    title: "A schedule can remember its last run",
    body: "By default each firing starts a fresh chat. Turn on \"accrete into one session\" and every firing resumes the same chat instead, which is how a recurring job builds up context rather than starting from nothing each time.",
    href: `${DOCS}/concepts/schedules/#fresh-chat-vs-one-accreting-session`,
  },

  // ── Configuration ────────────────────────────────────────────────────────
  {
    id: "your-user-claude-md-is-not-loaded",
    title: "Your own CLAUDE.md is not loaded",
    body: "By default Paddock borrows only your Claude Code login — your ~/.claude/CLAUDE.md, agents, commands and plugins are deliberately left out. Set claude.instructions: host in paddock.config.yaml to bring them in.",
    href: `${DOCS}/guides/what-paddock-touches/#turning-sharing-on`,
  },
  {
    id: "host-claude-hooks-do-not-run",
    title: "Your Claude Code hooks do not run here",
    body: "Hooks configured in your own ~/.claude/settings.json are not executed inside Paddock turns unless you set claude.hooks: host. The rest of that file still applies either way.",
    href: `${DOCS}/configuration/config-file/#hooks`,
  },
  {
    id: "declare-mcp-servers-to-paddock",
    title: "MCP servers must be declared to Paddock",
    body: "Running claude mcp add inside the instance attaches a server that can never be called: agents carry an explicit tool allow-list, and a server Paddock did not attach itself is refused silently. Declare it in the top-level mcpServers: block instead.",
    href: `${DOCS}/configuration/config-file/#mcpservers--the-servers-this-instance-declares-itself`,
  },
  {
    id: "config-saves-need-a-restart",
    title: "Config is frozen at boot",
    body: "Instance config is resolved once at startup, so a save on the Config screen takes effect at the next restart rather than immediately. A field pinned by an environment variable renders read-only and names the variable that wins.",
    href: `${DOCS}/configuration/instance-settings/#2-an-environment-variable-wins-and-the-screen-tells-you`,
  },
  {
    id: "dictation-is-one-variable-away",
    title: "Dictation is one variable away",
    body: "Set PADDOCK_WHISPER_ENDPOINT to a Whisper-compatible endpoint and a microphone button appears in the composer — nothing else needs configuring. Nothing in the UI hints the feature exists until it is set.",
    href: `${DOCS}/configuration/environment/#voice-dictation-whisper`,
  },
  {
    id: "themes-are-per-browser",
    title: "Themes are yours, not the instance's",
    body: "Config → Appearance offers four themes and an accent picker that re-solves any colour you choose for readable contrast, and the choice is stored per browser. Two people on one instance can see completely different Paddocks.",
    href: `${DOCS}/configuration/appearance/#scope-per-browser-not-per-instance`,
  },

  // ── Reach and blast radius ───────────────────────────────────────────────
  {
    id: "a-project-is-not-a-sandbox",
    title: "A project is not a security boundary",
    body: "Project agents have Bash and no confinement, so one can read and edit another project's files and notes. If two bodies of work need different trust levels, that means two Paddock instances, not two projects.",
    href: `${DOCS}/guides/agent-capabilities/#reach-where-an-agent-can-go`,
  },
  {
    id: "root-chats-reach-every-project",
    title: "A root chat can reach every project",
    body: "Chats started from Home run with the whole projects directory as their working directory, which is both the point and a real step up in reach. Worth remembering before handing one a broad instruction.",
    href: `${DOCS}/using/working-in-chats/#project-chats-vs-root-chats`,
  },
];
