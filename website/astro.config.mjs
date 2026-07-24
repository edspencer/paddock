// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import rehypeMermaid from 'rehype-mermaid';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
	site: 'https://paddock.edspencer.net',
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
				// Mermaid client-side rendering (dark theme to match the default site theme).
				{
					tag: 'script',
					attrs: { type: 'module' },
					content: `import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'; mermaid.initialize({ startOnLoad: true, theme: 'dark' });`,
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
				{ label: "What's New", slug: 'whats-new' },
				{ label: 'Getting Started', slug: 'getting-started' },
				{
					label: 'Using Paddock',
					collapsed: false,
					items: [
						{ label: 'Creating & organizing projects', slug: 'using/creating-and-organizing-projects' },
						{ label: 'Working in chats', slug: 'using/working-in-chats' },
						{ label: 'Automating with hooks', slug: 'using/automating-with-hooks' },
						{ label: 'Sending files & images', slug: 'using/sending-files-and-images' },
						{ label: 'Scheduling recurring work', slug: 'using/scheduling-recurring-work' },
						{ label: "Reading a keeper's work", slug: 'using/reading-a-keepers-work' },
					],
				},
				{
					label: 'Guides',
					collapsed: false,
					items: [
						{ label: 'Who Paddock is for', slug: 'guides/who-its-for' },
						{ label: 'Deploying Paddock', slug: 'guides/deploying' },
						{ label: 'The Dev Box flavor', slug: 'guides/dev-box-flavor' },
						{ label: 'Running Paddock on Proxmox (LXC)', slug: 'guides/proxmox-lxc' },
						{ label: 'Running Paddock on Kubernetes', slug: 'guides/kubernetes' },
						{ label: 'Securing Paddock', slug: 'guides/securing' },
						{ label: 'A home-lab setup', slug: 'guides/home-lab' },
					],
				},
				{
					label: 'Concepts',
					collapsed: false,
					items: [
						{ label: 'Overview', slug: 'concepts' },
						{ label: 'Projects', slug: 'concepts/projects' },
						{ label: 'Keeper & scratch agents', slug: 'concepts/keeper-and-scratch' },
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
						{ label: 'Environment variables', slug: 'configuration/environment' },
						{ label: 'Config file (YAML)', slug: 'configuration/config-file' },
						{ label: 'Authentication', slug: 'configuration/authentication' },
						{ label: 'Keeper-chat recovery', slug: 'configuration/keeper-recovery' },
						{ label: 'Scheduling & the schedule gates', slug: 'configuration/schedules' },
					],
				},
				{
					label: 'Architecture',
					collapsed: true,
					items: [
						{ label: 'Overview', slug: 'architecture/overview' },
						{ label: 'herdctl integration', slug: 'architecture/herdctl-integration' },
					],
				},
				{
					label: 'Reference',
					collapsed: true,
					items: [
						{ label: 'REST & WebSocket API', slug: 'reference/api' },
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
