/**
 * Shared bearer-token auth for this server's HTTP routes (the MCP endpoint
 * and the bulk-upload endpoint both use this — one shared secret, one gate).
 *
 * Accepts the token two ways:
 *   1. `Authorization: Bearer <token>` header — for curl, Claude Code, and the
 *      Claude API MCP connector (authorization_token).
 *   2. a `?token=<token>` (or `?key=`) query param — for the claude.ai custom
 *      connector, where the secret is baked into the connector URL.
 *
 * Fails closed: with no `MCP_BEARER_TOKEN` configured, every request is
 * rejected rather than authenticated by accident.
 */

import { timingSafeEqual } from "node:crypto";

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function extractToken(req: Request): string | undefined {
  const authHeader = req.headers.get("authorization");
  if (authHeader) {
    const [type, token] = authHeader.split(" ");
    if (type?.toLowerCase() === "bearer" && token) return token;
  }
  const url = new URL(req.url);
  return url.searchParams.get("token") ?? url.searchParams.get("key") ?? undefined;
}

export function isAuthorized(req: Request): boolean {
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected) {
    // Misconfiguration: with no configured secret we cannot authenticate
    // anyone, so reject all requests rather than fail open.
    console.error("MCP_BEARER_TOKEN is not set; rejecting all requests.");
    return false;
  }
  const provided = extractToken(req);
  return provided != null && safeEqual(provided, expected);
}

export function unauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", error_description: "Missing or invalid token." }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}
