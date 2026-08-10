// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import rehypeMermaid from 'rehype-mermaid';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
	site: 'https://paddock.edspencer.net',
	// #585 retired "keeper" as a user-facing word, which moved three published
	// pages. Cloudflare Pages serves this site statically, so these emit
	// meta-refresh stubs at the old paths rather than real 3xx — good enough to
	// keep existing links and search results off a 404.
	redirects: {
		'/concepts/keepers': '/concepts/agents/',
		'/configuration/keeper-recovery': '/configuration/chat-recovery/',
		'/using/reading-a-keepers-work': '/using/reading-claudes-work/',
	},
	vite: {
		plugins: [tailwindcss()],
	},
	markdown: {
		// Mermaid code fences are pre-processed here and rendered client-side (see head script).
		rehypePlugins: [[rehypeMermaid, { strategy: 'pre-mermaid' }]],
	},
	integrations: [
		sitemap(),
		starlight({
			title: 'Paddock',
			tagline: 'Your Claude Code agents, hosted and organized by project.',
			customCss: ['./src/styles/tailwind.css', './src/styles/custom.css'],
			logo: {
				src: './src/assets/paddock-logo.svg',
				alt: 'Paddock',
			},
			favicon: '/favicon.ico',
			head: [
				// Mermaid: themed from Starlight, and kept legible rather than scaled
				// down to fit. Lives in public/mermaid-init.js — it has real logic now
				// (theme re-render, sequence spacing, fit-vs-scroll), and that does not
				// belong in a template string inside this config.
				{ tag: 'script', attrs: { type: 'module', src: '/mermaid-init.js' } },
				// PostHog. Verbatim from PostHog's install snippet (a minified stub that
				// queues calls until array.js loads) — kept inline rather than moved to
				// public/, unlike mermaid-init.js above, because it must run before the
				// SDK arrives and because it is vendor code we do not hand-maintain.
				//
				// `api_host` is our own /ingest path, proxied to PostHog by
				// functions/ingest/[[path]].ts, so requests are same-origin and survive
				// tracker blocklists. The two must be changed together.
				//
				// The phc_ key is a PUBLIC, publishable project key — it ships in every
				// page's HTML by design. It is not a secret and does not belong in an
				// env var: Astro would inline it at build time regardless, so a variable
				// would add no privacy and one more way to deploy an empty key.
				//
				// Starlight is a plain MPA (real page loads, no client router), so
				// PostHog's default pageview capture is correct as-is.
				{
					tag: 'script',
					content: `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group identify setPersonProperties setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags resetGroups onFeatureFlags addFeatureFlagsHandler onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);posthog.init('phc_ptL3HRUzW6RekQ7RqUFnqFYYbDxF8xW43Cc4FuxsVR4Y',{api_host:'https://paddock.edspencer.net/ingest',ui_host:'https://us.posthog.com',person_profiles:'identified_only'});`,
				},
				// Social-share image. Starlight already emits PER-PAGE og:title,
				// og:description, og:url (canonical) and twitter:card=summary_large_image
				// (see @astrojs/starlight/utils/head.ts), and a user `head` entry
				// OVERRIDES those — so we must NOT restate them here (doing so pinned
				// every page's unfurl to the homepage's title/description/URL). The one
				// thing Starlight has no default for is the image, so a large-image card
				// rendered empty. Supply a single global og:image/twitter:image (absolute
				// URLs, as required by crawlers); the per-page title/description still win.
				{ tag: 'meta', attrs: { property: 'og:image', content: 'https://paddock.edspencer.net/og-image.png' } },
				{ tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
				{ tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
				{ tag: 'meta', attrs: { property: 'og:image:alt', content: 'Paddock — your Claude Code agents, hosted and organized by project' } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: 'https://paddock.edspencer.net/og-image.png' } },
			],
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/edspencer/paddock' },
				{ icon: 'rss', label: 'Blog', href: 'https://edspencer.net' },
			],
			editLink: {
				baseUrl: 'https://github.com/edspencer/paddock/edit/main/website/',
			},
			sidebar: [
				{ label: 'Welcome', link: '/' },
				// Getting Started carries the primary CTA (the `npx` badge), so it sits
				// directly under Welcome. The What's New split in #762 had pushed it to
				// fourth, below two release-notes entries a first-time reader doesn't want.
				{ label: 'Getting Started', slug: 'getting-started', badge: { text: 'npx', variant: 'tip' } },
				{ label: "What's New", slug: 'whats-new' },
				{ label: "What's New — earlier releases", slug: 'whats-new-archive' },
				{
					label: 'Using Paddock',
					collapsed: false,
					items: [
						{ label: 'Creating & organizing projects', slug: 'using/creating-and-organizing-projects' },
						{ label: 'Working in chats', slug: 'using/working-in-chats' },
						{ label: 'Automating with hooks', slug: 'using/automating-with-hooks' },
						{ label: 'Sending files & images', slug: 'using/sending-files-and-images' },
						{ label: 'Scheduling recurring work', slug: 'using/scheduling-recurring-work' },
						{ label: "Reading Claude's work", slug: 'using/reading-claudes-work' },
					],
				},
				{
					label: 'Guides',
					collapsed: false,
					items: [
						{ label: 'Who Paddock is for', slug: 'guides/who-its-for' },
						{ label: 'Keeping Paddock running on your laptop', slug: 'guides/running-as-a-service' },
						{ label: 'Deploying Paddock', slug: 'guides/deploying' },
						{ label: 'The Dev Box flavor', slug: 'guides/dev-box-flavor' },
						{ label: 'Running Paddock on Proxmox (LXC)', slug: 'guides/proxmox-lxc' },
						{ label: 'Running Paddock on Kubernetes', slug: 'guides/kubernetes' },
						{ label: 'Connect Claude Code to Paddock', slug: 'guides/connect-claude-code' },
						{ label: 'A home-lab setup', slug: 'guides/home-lab' },
					],
				},
				{
					// Security is two axes, not one: who can start a turn (Securing,
					// Authentication, Binding) and what a turn can then do (Agent
					// capabilities, Untrusted content). Both live here, uncollapsed.
					// This used to be a single entry buried sixth in Guides, below
					// "Deploying" — which read as "stand it up, then maybe secure it".
					// Authentication and Binding keep their `configuration/` slugs (so
					// no redirects are needed); they are listed here rather than under
					// Configuration so the group is complete in one place.
					label: 'Security',
					collapsed: false,
					items: [
						{ label: 'Securing Paddock', slug: 'guides/securing' },
						{ label: 'What Paddock touches on your machine', slug: 'guides/what-paddock-touches' },
						{ label: 'What your agents can do', slug: 'guides/agent-capabilities' },
						{ label: 'Prompt injection & untrusted content', slug: 'guides/untrusted-content' },
						{ label: 'Authentication', slug: 'configuration/authentication' },
						{ label: 'Binding & network exposure', slug: 'configuration/binding-and-exposure' },
					],
				},
				{
					label: 'Concepts',
					collapsed: false,
					items: [
						{ label: 'Overview', slug: 'concepts' },
						{ label: 'Workspaces', slug: 'concepts/workspaces' },
						{ label: 'Projects', slug: 'concepts/projects' },
						{ label: 'Agents', slug: 'concepts/agents' },
						{ label: 'Chats are sessions', slug: 'concepts/chats' },
						{ label: 'Schedules', slug: 'concepts/schedules' },
						{ label: 'Provenance: who did what', slug: 'concepts/provenance' },
						{ label: 'The sweeper', slug: 'concepts/sweeper' },
						{ label: 'Event hooks', slug: 'concepts/hooks' },
					],
				},
				{
					label: 'Configuration',
					collapsed: true,
					items: [
						{ label: 'Appearance', slug: 'configuration/appearance' },
						{ label: 'Environment variables', slug: 'configuration/environment' },
						{ label: 'Config file (YAML)', slug: 'configuration/config-file' },
						{ label: 'The Config screen', slug: 'configuration/instance-settings' },
						// Authentication + Binding are listed under Security, above.
						{ label: 'Model allow-lists', slug: 'configuration/models' },
						{ label: 'OpenAPI & Swagger', slug: 'configuration/openapi' },
						{ label: 'Chat recovery', slug: 'configuration/chat-recovery' },
						{ label: 'Scheduling & the schedule gates', slug: 'configuration/schedules' },
					],
				},
				{
					label: 'Architecture',
					collapsed: true,
					items: [
						{ label: 'Overview', slug: 'architecture/overview' },
						{ label: 'herdctl and Paddock', slug: 'architecture/herdctl-and-paddock' },
						{ label: 'herdctl integration', slug: 'architecture/herdctl-integration' },
					],
				},
				{
					label: 'Reference',
					collapsed: true,
					items: [
						{ label: 'API overview', slug: 'reference/api' },
						{ label: 'HTTP API (Swagger)', link: '/api/' },
						{ label: 'WebSocket protocol', slug: 'reference/websocket' },
						{ label: 'Management API (MCP)', slug: 'reference/mcp' },
						{ label: 'Self-management MCP', slug: 'reference/self-mcp' },
						{ label: 'Hooks', slug: 'reference/hooks' },
						{ label: 'Schedules', slug: 'reference/schedules' },
					],
				},
				{
					label: 'Contributing',
					collapsed: true,
					items: [
						{ label: 'Contributing', slug: 'contributing' },
						{ label: 'Testing', slug: 'contributing/testing' },
					],
				},
			],
		}),
	],
});
