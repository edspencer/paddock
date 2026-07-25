/**
 * OpenAPI document scaffolding for the Paddock HTTP API.
 *
 * The spec is *derived from the route schemas* — every REST route attaches a
 * Fastify `schema` ({ tags, summary, description, params, querystring, body,
 * response }) and `@fastify/swagger` (registered in app.ts before the routes)
 * collects them into a live OpenAPI 3 document served at `/docs` (Swagger UI)
 * and `/docs/json` (raw spec). This module only provides the top-level document
 * metadata (info, tags, security) that Fastify can't infer from routes, plus the
 * Paddock-branded Swagger-UI mount options.
 *
 * IMPORTANT — the live conversational surface is NOT REST. Sending a message,
 * streaming the reply, tool-call events, cancel, slash-commands and the live
 * queue all flow over the WebSocket at `GET /ws` (see ws-protocol.ts). This spec
 * documents the HTTP surface (reads + project/chat/trigger/git management +
 * config + attachment upload/serve); the WS frame protocol is described in
 * docs/API.md.
 */
import type { SwaggerOptions } from "@fastify/swagger";
import type { FastifySwaggerUiOptions } from "@fastify/swagger-ui";
import type { OpenAPIV3 } from "openapi-types";
import type { AuthConfig } from "./config.js";

/** Tag groups — these MUST match the `tags` each route declares in its schema. */
export const OPENAPI_TAGS = [
  { name: "System", description: "Health, identity, models, fleet, instance config, voice." },
  { name: "Attachments", description: "Composer file uploads and serving agent-shared file bytes." },
  { name: "Git", description: "Repo remote state, GitHub auth, per-project status/diff/commit." },
  { name: "Projects", description: "Project CRUD, promote, files, changelog/overview, pins." },
  {
    name: "Triggers",
    description: "Unified schedule/event/webhook triggers: CRUD, runtime status, run-now.",
  },
  {
    name: "Chats",
    description:
      "Chat (session) lifecycle: list, read messages, usage/context, fork, archive, star, rename, delete, run history, promote. NOTE: sending a message is WebSocket-only (GET /ws).",
  },
] as const;

const BASE_DESCRIPTION = [
  "HTTP API for Paddock — the keeper-agent platform (persistent chats, projects, unified triggers).",
  "",
  "This document is **generated from the server's route schemas** via `@fastify/swagger`, so it",
  "tracks the code: a new or changed route with a schema shows up here automatically.",
  "",
  "**Live chat is WebSocket, not REST.** Sending a message, streaming the response, tool-call",
  "events, cancel, slash-commands and the live queue all flow over `GET /ws`. This spec covers the",
  "HTTP surface: reads, project/chat/trigger/git management, instance config, and attachment",
  "upload/serve. The two-step attachment flow is: `POST .../chats/:sessionId/upload` (HTTP, here)",
  "then reference the returned file ids in the `chat:send` WebSocket frame.",
].join("\n");

/**
 * Resolve the OpenAPI security schemes + global requirement + a docs paragraph
 * from the *running instance's* auth config. Paddock has no login of its own —
 * auth is provider-agnostic (see AUTH.md), so the schemes reflect whichever mode
 * this instance is configured for:
 *
 *  - `none`           → no scheme, no requirement (open; every request anonymous).
 *  - `trusted-header` → apiKey in the configured identity header (proxy-injected).
 *  - `jwt`            → bearer (when the header is `Authorization`) or apiKey in
 *                       the configured header, verified against the JWKS.
 *
 * The single most important operational note: when Swagger UI is served BY an
 * authenticated Paddock instance on the SAME origin (e.g. behind Authentik /
 * oauth2-proxy), a "Try it out" call is a same-origin XHR that already carries
 * the browser's SSO session — the proxy authenticates it and injects the
 * identity, so no token needs to be pasted into the Authorize dialog at all. The
 * Authorize button matters for the token path: calling from a different origin,
 * or a programmatic client, or testing jwt mode without the proxy in front.
 */
function authDoc(auth: AuthConfig): {
  securitySchemes?: Record<string, OpenAPIV3.SecuritySchemeObject>;
  security?: OpenAPIV3.SecurityRequirementObject[];
  paragraph: string;
} {
  const header = "\n\n## Authentication\n\n";
  const shared =
    "Paddock has no built-in login — authentication is provider-agnostic and handled at the edge " +
    "(reverse proxy / IdP). **When these docs are served by the Paddock instance itself, behind your " +
    "proxy, a `Try it out` request is a same-origin call that inherits your existing SSO session — it " +
    "authenticates automatically, nothing to paste here.** Use the **Authorize** button only for the " +
    "explicit-token path (a different origin, a programmatic client, or testing without the proxy).";

  if (auth.mode === "trusted-header") {
    return {
      securitySchemes: {
        proxyIdentity: {
          type: "apiKey",
          in: "header",
          name: auth.userHeader,
          description:
            `Trusted-header auth (\`PADDOCK_AUTH_MODE=trusted-header\`). The identity header your ` +
            `reverse proxy injects after SSO — here \`${auth.userHeader}\` ` +
            `(configurable via \`PADDOCK_AUTH_USER_HEADER\`). In production the proxy sets this and ` +
            `Paddock trusts it, so the app MUST be reachable only through the proxy (a direct client ` +
            `could otherwise forge the header).`,
        },
      },
      security: [{ proxyIdentity: [] }],
      paragraph:
        header +
        shared +
        `\n\nThis instance runs **trusted-header** mode: identity comes from the \`${auth.userHeader}\` header.`,
    };
  }

  if (auth.mode === "jwt") {
    const isBearer = auth.jwtHeader.toLowerCase() === "authorization";
    const scheme: Record<string, OpenAPIV3.SecuritySchemeObject> = isBearer
      ? {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description:
              "JWT auth (`PADDOCK_AUTH_MODE=jwt`). A signed token verified against the configured " +
              "JWKS (`PADDOCK_AUTH_JWKS_URL`), sent as `Authorization: Bearer <token>`.",
          },
        }
      : {
          jwtHeader: {
            type: "apiKey",
            in: "header",
            name: auth.jwtHeader,
            description:
              `JWT auth (\`PADDOCK_AUTH_MODE=jwt\`). A signed token verified against the JWKS, sent ` +
              `in the \`${auth.jwtHeader}\` header.`,
          },
        };
    const schemeName = isBearer ? "bearerAuth" : "jwtHeader";
    return {
      securitySchemes: scheme,
      security: [{ [schemeName]: [] }],
      paragraph:
        header +
        shared +
        `\n\nThis instance runs **jwt** mode: a signed token in the \`${auth.jwtHeader}\` header, ` +
        `verified against the JWKS.`,
    };
  }

  // mode === "none"
  return {
    paragraph:
      header +
      shared +
      "\n\nThis instance runs **none** mode (open, unauthenticated) — every request is anonymous. " +
      "A real deployment sits behind a proxy in `trusted-header` or `jwt` mode.",
  };
}

/**
 * Build the @fastify/swagger options for a given app version + auth config. The
 * security schemes and the Authentication section of the description reflect the
 * running instance's mode (see {@link authDoc}).
 */
export function buildSwaggerOptions(version: string, auth: AuthConfig): SwaggerOptions {
  const a = authDoc(auth);
  return {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "Paddock HTTP API",
        description: BASE_DESCRIPTION + a.paragraph,
        version,
      },
      tags: OPENAPI_TAGS.map((t) => ({ name: t.name, description: t.description })),
      ...(a.securitySchemes ? { components: { securitySchemes: a.securitySchemes } } : {}),
      ...(a.security ? { security: a.security } : {}),
    },
    // Keep untagged routes visible rather than hidden (the /ws upgrade is hidden
    // separately via schema.hide).
    hideUntagged: false,
  };
}

/** A logo/favicon image passed to Swagger UI ({ type, content } bytes). */
export interface SwaggerImage {
  type: string;
  content: Buffer;
}

export interface SwaggerUiBranding {
  /** Route prefix the UI mounts under (e.g. `/open-api`). */
  routePrefix: string;
  /** Topbar logo image (the Paddock horse). */
  logo?: SwaggerImage;
  /** Browser-tab favicon image. */
  favicon?: SwaggerImage;
  /** Brand accent hex (e.g. #c2603c) used for the topbar trim. */
  accent: string;
}

/**
 * Custom Swagger-UI CSS: swap in the Paddock look. Darkens the topbar, sizes the
 * injected logo, tints the trim with the brand accent, and hides the spec-URL bar
 * (which otherwise exposes the server's own URL in the header). Everything else
 * is stock Swagger UI.
 */
function brandCss(accent: string): string {
  return [
    ".swagger-ui .topbar { background-color: #14181f; border-bottom: 3px solid " + accent + "; }",
    ".swagger-ui .topbar .download-url-wrapper { display: none; }",
    ".swagger-ui .topbar a { max-height: 40px; }",
    ".swagger-ui .topbar a img { height: 36px; width: auto; content: normal; }",
    ".swagger-ui .info .title small.version-stamp { background: " + accent + "; }",
  ].join("\n");
}

/** Swagger-UI mount options (served at /docs), Paddock-branded. */
export function buildSwaggerUiOptions(brand: SwaggerUiBranding): FastifySwaggerUiOptions {
  const opts: FastifySwaggerUiOptions = {
    routePrefix: brand.routePrefix,
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
      displayRequestDuration: true,
      persistAuthorization: true,
    },
    theme: {
      title: "Paddock HTTP API",
      css: [{ filename: "paddock.css", content: brandCss(brand.accent) }],
      ...(brand.favicon
        ? {
            favicon: [
              {
                filename: "favicon.png",
                rel: "icon",
                type: brand.favicon.type,
                sizes: "32x32",
                content: brand.favicon.content,
              },
            ],
          }
        : {}),
    },
  };
  if (brand.logo) opts.logo = { type: brand.logo.type, content: brand.logo.content };
  return opts;
}
