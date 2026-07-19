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
				// OpenGraph / Twitter card
				{ tag: 'meta', attrs: { property: 'og:title', content: 'Paddock — Claude Code agents, organized by project' } },
				{ tag: 'meta', attrs: { property: 'og:description', content: 'Persistent, resumable Claude Code sessions with a web UI, built on herdctl.' } },
				{ tag: 'meta', attrs: { property: 'og:type', content: 'website' } },
				{ tag: 'meta', attrs: { property: 'og:url', content: 'https://paddock.edspencer.net' } },
				{ tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
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
				{ label: 'Getting Started', slug: 'getting-started' },
				{
					label: 'Using Paddock',
					collapsed: false,
					items: [
						{ label: 'Creating & organizing projects', slug: 'using/creating-and-organizing-projects' },
						{ label: 'Working in chats', slug: 'using/working-in-chats' },
					],
				},
				{
					label: 'Guides',
					collapsed: false,
					items: [
						{ label: 'Who Paddock is for', slug: 'guides/who-its-for' },
						{ label: 'Deploying Paddock', slug: 'guides/deploying' },
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
						{ label: 'The sweeper', slug: 'concepts/sweeper' },
					],
				},
				{
					label: 'Configuration',
					collapsed: true,
					items: [
						{ label: 'Environment variables', slug: 'configuration/environment' },
						{ label: 'Authentication', slug: 'configuration/authentication' },
						{ label: 'Keeper-chat recovery', slug: 'configuration/keeper-recovery' },
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
