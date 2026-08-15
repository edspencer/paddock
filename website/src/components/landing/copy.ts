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
 * The scroll-swap section: each entry is one sticky screenshot and the prose
 * that selects it. Images are 8:5 to match the media frame's aspect ratio, so
 * nothing is letterboxed.
 */
export const FEATURES = [
	{
		title: 'Every project gets an agent',
		body: 'A project is just a directory — a codebase, a research notebook, a home-ops runbook. Paddock runs Claude Code in it, and the chats you see are that agent’s sessions, persisted on disk. Home shows you what needs you: unread replies first, then what is still running.',
		image: 'home-attention',
		alt: 'Paddock’s Home screen listing unread replies and running chats across every project',
	},
	{
		title: 'Chats persist and resume',
		body: 'Sessions live on the server, so they survive reloads, reconnects and devices. Close the lid mid-turn and pick it up on your phone. Queue a message while the agent is still talking, fork a chat from any point in its history, or rewind it.',
		image: 'chat-streaming-queued',
		alt: 'A Paddock chat streaming a reply with a queued follow-up message beneath it',
	},
	{
		title: 'Watch the work, not just the answer',
		body: 'File writes, commands and nested sub-agents render as live cards as they run — diffs inline, step counts, durations. Per-chat cost and a context meter you can read at any point in the transcript, not just at the end.',
		image: 'reading-tool-block-diff',
		alt: 'A tool block in a Paddock chat expanded to show an inline file diff',
	},
	{
		title: 'Work that starts itself',
		body: 'One triggers model covers both halves of unattended work: cron schedules, and event hooks that fire a scoped agent when something happens. Run history shows what ran while you were away, and you read the transcript in the morning.',
		image: 'triggers-tab-schedules',
		alt: 'The Triggers tab of a Paddock project, listing scheduled runs',
	},
] as const;
