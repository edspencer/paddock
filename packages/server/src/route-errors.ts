/**
 * Shared REST error helper. `sendProjectError` maps a {@link ProjectError} onto
 * the right HTTP status (404 not_found / 409 exists|not_directory / 400 else) and
 * falls back to a logged 500 for anything unexpected. Used by nearly every
 * handler, so it lands in its own module and is imported everywhere.
 */
import type { FastifyReply } from "fastify";
import { ProjectError } from "./projects.js";

export function sendProjectError(reply: FastifyReply, err: unknown) {
  if (err instanceof ProjectError) {
    const code =
      err.code === "not_found"
        ? 404
        : err.code === "exists" || err.code === "not_directory"
          ? 409
          : 400;
    return reply.code(code).send({ error: err.message, code: err.code });
  }
  reply.log.error({ err }, "route error");
  return reply.code(500).send({ error: (err as Error).message ?? "internal error" });
}
