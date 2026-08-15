/**
 * Landing-page copy, in one place.
 *
 * The hardest part of this page is not the CSS — it's deciding what the fold
 * SAYS. So every string the landing page renders lives here rather than being
 * scattered through the components, and the headline directions we considered
 * are kept as real, switchable data instead of being lost in a PR thread.
 *
 * To try a different fold: change `HEADLINE` to another key of `HEADLINES` and
 * rebuild. Nothing else needs to move.
 *
 * Positioning constraint that shapes all of these: Anthropic now ships web,
 * mobile, remote control and schedules as first-party features. "Reach Claude
 * Code from your phone" is no longer a differentiator, so it must not carry the
 * fold. Self-hosting is the differentiator, and it belongs in the first
 * paragraph of every option below.
 */

export type HeadlineKey = 'projectFirst' | 'selfHosted' | 'tabbedBrowsing';

interface Headline {
	/** Small line above the H1. */
	eyebrow: string;
	/** The H1. Short and declarative — a thesis, not a description. */
	title: string;
	/** What it is, plus status. Carries the self-hosting differentiator. */
	lede: string;
	/** The thesis unpacked into something concrete. */
	body: string;
	/** Why we'd pick this one — shown nowhere, kept for the design discussion. */
	rationale: string;
}

export const HEADLINES: Record<HeadlineKey, Headline> = {
	/**
	 * Structurally the closest mirror of DeepSeek's "Everything is a plugin":
	 * a short declarative sentence that IS the product's model, not a summary
	 * of its features.
	 */
	projectFirst: {
		eyebrow: 'Open source · MIT · self-hosted',
		title: 'Every project gets an agent.',
		lede: 'Paddock is a self-hosted home for Claude Code — source included, MIT, running on hardware you own.',
		body: 'A project is just a directory. Paddock runs an agent in it whose chats persist and resume — driven by you, by a schedule, by an event, or by another agent.',
		rationale:
			'Mirrors the reference page structurally and states the product model in four words. Self-hosting moves to the lede.',
	},

	/**
	 * Leads on the differentiator rather than the model. Sharper positioning,
	 * weaker as a thesis — "your hardware" describes where it runs, not what
	 * it is, so the lede has to do more work.
	 */
	selfHosted: {
		eyebrow: 'Open source · MIT · v0.70',
		title: 'Your agents. Your hardware.',
		lede: 'Paddock is an open-source home for Claude Code that runs on a box you own and answers to a browser you own.',
		body: 'Every project gets a long-lived agent whose chats persist and resume — from your desk, from your phone, or from a schedule that fires while you sleep.',
		rationale:
			'Strongest on the one thing Anthropic does not ship. Weakest at explaining what Paddock actually is.',
	},

	/**
	 * Ed's own line, and the title of the intro video. Most memorable of the
	 * three; says nothing about self-hosting, so the lede carries all of it.
	 */
	tabbedBrowsing: {
		eyebrow: 'Open source · MIT · self-hosted',
		title: 'Like browser tabs, but for Claude Code.',
		lede: 'Paddock is a self-hosted home for your Claude Code agents — source included, MIT, running on hardware you own.',
		body: 'A dozen conversations at once, each in its own project, none of them lost when you close the lid. Chats persist, resume, fork and rewind.',
		rationale:
			'Already the title of the intro video, so the page and the video agree. Comparative rather than declarative.',
	},
};

/** The headline direction this build renders. Change to compare. */
export const HEADLINE: HeadlineKey = 'projectFirst';

export const hero = HEADLINES[HEADLINE];

export const REPO_URL = 'https://github.com/edspencer/paddock';
export const VIDEO_ID = 'B3v6oPbD1F8';
export const VIDEO_TITLE = 'Paddock: like browser tabs, but for Claude Code';

/**
 * The two ways in. The second tab is a real command rather than a link that
 * navigates away — a tab that changes the page is a small lie, and the reader
 * came here for something to paste. The guides link sits under it instead.
 */
export const COMMANDS = [
	{
		id: 'quickstart',
		label: 'Quick start',
		blurb: 'Install Node, then open Paddock on your own Claude Code history. Nothing is written into your directories.',
		command: 'npx @edspencer/paddock -o',
		link: { text: 'How Discover works', href: '/getting-started/#discover-start-from-the-history-you-already-have' },
	},
	{
		id: 'deploy',
		label: 'Deploy anywhere',
		blurb: 'For always-on: two official images, plus Docker, Proxmox, Kubernetes and reverse-proxy-auth recipes.',
		command: 'docker run -d -p 7233:7233 -v paddock-data:/data ghcr.io/edspencer/paddock',
		link: { text: 'Deployment guides', href: '/guides/deploying/' },
	},
] as const;

/** The four hero buttons. */
export const HERO_LINKS = [
	{ text: 'View on GitHub', href: REPO_URL, icon: 'github', primary: true },
	{ text: 'Developer docs', href: '/getting-started/', icon: 'docs' },
	{ text: 'Blog posts', href: 'https://edspencer.net/blog/tag/paddock', icon: 'blog' },
	{ text: 'Watch the video', href: `https://www.youtube.com/watch?v=${VIDEO_ID}`, icon: 'play' },
];

/**
 * The scroll-swap section: each entry is one sticky piece of media and the prose
 * that selects it.
 *
 * MEDIA RULE, learned the hard way: these must be CROPS OF ONE FEATURE, never
 * full-window screenshots. The first version used the 1280x800 captures the docs
 * pages use. In a docs page they are fine — they render at full width and you can
 * read them. Here the media column is about 640px wide, so a full window lands at
 * roughly half scale and every label in it becomes unreadable mush. The section
 * looked right in wireframe and communicated nothing.
 *
 * So each entry points at something tightly framed on the one thing the sentence
 * next to it is about, at close to 1:1 pixel scale. Sources, in preference order:
 *
 *   1. The existing crop library under src/assets — the What's New pages have
 *      been accumulating well-framed crops for months (see per-message-hover,
 *      root-home, running-chats-filter, revert-modal, appearance-panel).
 *   2. A crop of a bigger asset, cut with ffmpeg. schedule-editor-crop.png is
 *      the top of the 654x1330 editor; cropping also drops a stale "keeper"
 *      reference further down the form (#871).
 *   3. A cropped video, also via ffmpeg. The five demo clips are all full-window
 *      1280x800 recordings and need the same treatment as the stills.
 *
 * Sizes are declared so the stage can reserve space and nothing shifts on load.
 */
export const FEATURES = [
	{
		title: 'Start from the history you already have',
		body: 'Paddock opens on Discover: it reads the Claude Code history already on your machine, lists the directories you have been working in, and turns the ones you tick into projects — conversations and all. Nothing to clone, and nothing written into your directories.',
		media: {
			type: 'video',
			src: '/demo/discover-crop.mp4',
			poster: '/demo/discover-crop-poster.jpg',
			width: 740,
			height: 444,
			alt: 'Discover listing three directories with existing Claude Code history and their conversation counts, importing two of them into projects',
		},
	},
	{
		title: 'Every project gets an agent',
		body: 'A project is just a directory — a codebase, a research notebook, a home-ops runbook. Paddock runs Claude Code in it, and the chats you see are that agent’s sessions, persisted on disk. Home opens on what needs you.',
		media: {
			type: 'image',
			src: 'root-home',
			width: 732,
			height: 521,
			alt: 'Paddock’s Home: four unread chat rows across different projects, above a Projects grid grouped by area with cards for Lanternfish and Harbourmaster',
		},
	},
	{
		title: 'Point a project at a git repo',
		body: 'A project can be a plain directory or a clone of a repo you own. Either way the agent works on a real checkout, and the Changes tab shows you the actual diff — stage what you want, leave the rest, commit and push from the browser.',
		media: {
			type: 'image',
			src: 'promote-to-repo-backed',
			width: 720,
			height: 347,
			alt: 'The Repository backing section of a project’s Settings tab, with a git URL entered and a confirmation step describing what promotion will do',
		},
	},
	{
		title: 'Chats open other chats — in other projects',
		body: 'A conversation is not a dead end. Claude can open a fresh chat and hand it a kickoff prompt, in this project or a different one, and each new chat records the parent it came from. Work that belongs somewhere else goes and happens there.',
		media: {
			type: 'image',
			src: 'spawn-cross-project',
			width: 676,
			height: 346,
			alt: 'Two Create chat tool blocks in a Lumen CLI conversation, each badged TRAIL-ATLAS, reading “Created chat … in trail-atlas” with the kickoff prompt each new chat was handed',
		},
	},
	{
		title: 'It sends things back',
		body: 'Not just text. The agent can hand you a diagram, a document, an image or a chart and it renders in the conversation where you can read it — rather than a filename you have to go and open somewhere else.',
		media: {
			type: 'image',
			src: 'sendfile-inline',
			width: 676,
			height: 520,
			alt: 'Two files sent by the assistant and rendered inline in a Paddock chat: a Mermaid flowchart of a colour pipeline, and a Markdown document titled “How a seed colour becomes a theme”',
		},
	},
	{
		title: 'Watch the work, not just the answer',
		body: 'File writes, commands and nested sub-agents render as live cards as they run — current step, step counts, durations. Here one chat runs two research sub-agents in parallel and writes a haiku while they work.',
		media: {
			type: 'video',
			src: '/demo/subagent-bar-crop.mp4',
			poster: '/demo/subagent-bar-crop-poster.jpg',
			width: 740,
			height: 428,
			alt: 'A bar above the message box reading “2 SUB-AGENTS RUNNING”, listing both agents with their live current step and a climbing step count',
		},
	},
	{
		title: 'Fork it, or rewind it',
		body: 'Sessions live on the server, so they survive reloads, reconnects and devices. Hover any message to see how old it is, how full the context window was at that point, and to branch a new chat from there — or roll the conversation back to it.',
		media: {
			type: 'image',
			src: 'per-message-hover',
			width: 796,
			height: 254,
			alt: 'An assistant reply in a Paddock chat with its hover rail showing “3m ago · 1K · 0%” beside a fork icon and a revert icon',
		},
	},
	{
		title: 'Work that starts itself',
		body: 'One triggers model covers both halves of unattended work: cron schedules, and event hooks that fire a scoped agent when something happens. Run history shows what ran while you were away, and you read the transcript in the morning.',
		media: {
			type: 'image',
			src: 'schedule-editor-crop',
			width: 654,
			height: 388,
			alt: 'Paddock’s schedule editor: a trigger named morning-triage on the cron expression “0 9 * * *”, with the prompt “Triage any issues opened overnight, label them, and post a short summary.”',
		},
	},
] as const;
