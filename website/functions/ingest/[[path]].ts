/**
 * PostHog reverse proxy.
 *
 * The analytics snippet in astro.config.mjs points `api_host` at
 * https://paddock.edspencer.net/ingest rather than at PostHog directly, so
 * analytics requests are same-origin and are not dropped by the tracker
 * blocklists that ship in most browsers and extensions. This function is the
 * other half of that: it forwards /ingest/* on to PostHog.
 *
 * Cloudflare Pages picks this up automatically from `functions/` under the
 * project root directory (`website/`) — there is no build step or wrangler
 * config to keep in sync.
 *
 * The two-host split matters. PostHog serves the SDK bundles from a separate
 * assets host, and the install snippet's built-in
 * `api_host.replace('.i.posthog.com', '-assets.i.posthog.com')` is a no-op once
 * api_host is our own domain — so the routing has to happen here instead.
 */
export const onRequest: PagesFunction = async ({ request }) => {
	const url = new URL(request.url);
	const path = url.pathname.replace(/^\/ingest/, '');

	const origin = path.startsWith('/static/')
		? 'https://us-assets.i.posthog.com'
		: 'https://us.i.posthog.com';

	// Drop Host: it still says paddock.edspencer.net here, and forwarding that
	// upstream makes PostHog serve (or reject) against the wrong vhost.
	const headers = new Headers(request.headers);
	headers.delete('host');

	return fetch(`${origin}${path}${url.search}`, {
		method: request.method,
		headers,
		body: request.body,
	});
};
