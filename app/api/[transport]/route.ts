import { createMcpHandler } from "mcp-handler";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { SalesforceError } from "@/lib/salesforce";
import {
  sanitizeProduct2Fields,
  createProduct2,
  updateProduct2,
  type FieldValue,
} from "@/lib/product2";

// MCP routes must run on the Node.js runtime (not Edge): they use node:crypto
// and the Salesforce client.
export const runtime = "nodejs";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Helpers for building MCP tool results.
// ---------------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Convert any thrown error into a clean, model-readable MCP error result. */
function toErrorResult(err: unknown): ToolResult {
  if (err instanceof SalesforceError) {
    const detail = err.bodyExcerpt ? ` — ${err.bodyExcerpt}` : "";
    return fail(`Salesforce error (${err.status}): ${err.message}${detail}`);
  }
  if (err instanceof Error) {
    return fail(`Error: ${err.message}`);
  }
  return fail(`Unknown error: ${String(err)}`);
}

// ---------------------------------------------------------------------------
// MCP server definition.
//
// This server is deliberately narrow: it only ever writes to Product2, and
// only via these two tools. It does not expose SOQL or any other sobject —
// that's the read-only sibling server's job. Keeping this one single-purpose
// keeps its blast radius (and its bearer token's blast radius) small.
// ---------------------------------------------------------------------------

const handler = createMcpHandler(
  (server) => {
    // ----- create_product2 ----------------------------------------------------
    // WRITE TOOL. Guarded two ways: (1) sanitizeProduct2Fields rejects any field
    // name that isn't a plain Salesforce API name (no Id, attributes, or
    // relationship paths), and (2) the write only executes when the caller
    // passes confirm: true — otherwise this returns a dry-run preview so the
    // model (and a human watching the transcript) can see the exact payload
    // before anything is written. Requires the ECA's Client Credentials "Run
    // As" user to have Create access on Product2 in Salesforce.
    server.tool(
      "create_product2",
      "Create a new Salesforce Product2 record. Without confirm: true, returns " +
        "a dry-run preview of the record that WOULD be created, with no write " +
        "performed. Pass confirm: true to actually create it.",
      {
        fields: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .describe(
            'Product2 field values, e.g. { "Name": "Widget", "ProductCode": "W-100", ' +
              '"IsActive": true }. Must include a non-empty "Name" (required by Product2). ' +
              'No "Id", "attributes", or relationship fields (e.g. "Owner.Name").',
          ),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Set to true to actually create the record. Omit or set false to preview " +
              "the write without executing it.",
          ),
      },
      async ({ fields, confirm }): Promise<ToolResult> => {
        try {
          const sanitized = sanitizeProduct2Fields(fields as Record<string, FieldValue>);
          if (!sanitized.ok) return fail(sanitized.error);
          if (typeof sanitized.fields.Name !== "string" || !sanitized.fields.Name.trim()) {
            return fail('Product2 requires a non-empty "Name" field.');
          }

          if (!confirm) {
            return ok({
              dryRun: true,
              action: "create",
              sobject: "Product2",
              fields: sanitized.fields,
              note: "No write performed. Call again with confirm: true to create this record.",
            });
          }

          const created = await createProduct2(sanitized.fields);
          return ok({ dryRun: false, ...created });
        } catch (err) {
          return toErrorResult(err);
        }
      },
    );

    // ----- update_product2 ------------------------------------------------------
    // Same two guards as create_product2: field-name sanitization, and a
    // confirm: true gate before any write reaches Salesforce. Requires the
    // ECA's Run As user to have Edit access on Product2.
    server.tool(
      "update_product2",
      "Update an existing Salesforce Product2 record by Id. Without confirm: " +
        "true, returns a dry-run preview of the change, with no write performed. " +
        "Pass confirm: true to actually update it.",
      {
        id: z.string().describe('The Salesforce Id of the Product2 record to update, e.g. "01txx...".'),
        fields: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .describe(
            'Field values to change, e.g. { "IsActive": false }. No "Id", "attributes", ' +
              'or relationship fields (e.g. "Owner.Name").',
          ),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Set to true to actually update the record. Omit or set false to preview " +
              "the write without executing it.",
          ),
      },
      async ({ id, fields, confirm }): Promise<ToolResult> => {
        try {
          if (!id.trim()) {
            return fail("Provide the Salesforce Id of the Product2 record to update.");
          }
          const sanitized = sanitizeProduct2Fields(fields as Record<string, FieldValue>);
          if (!sanitized.ok) return fail(sanitized.error);

          if (!confirm) {
            return ok({
              dryRun: true,
              action: "update",
              sobject: "Product2",
              id,
              fields: sanitized.fields,
              note: "No write performed. Call again with confirm: true to update this record.",
            });
          }

          await updateProduct2(id, sanitized.fields);
          return ok({ dryRun: false, success: true, id });
        } catch (err) {
          return toErrorResult(err);
        }
      },
    );
  },
  {
    // Server metadata surfaced to MCP clients / the Inspector.
    serverInfo: { name: "iki-salesforce-product-mcp", version: "0.1.0" },
  },
  {
    // Route lives at app/api/[transport]/route.ts, so the transport segment is
    // under "/api" → the live endpoint is /api/mcp.
    basePath: "/api",
    // Streamable HTTP only. SSE would require an attached Redis (REDIS_URL);
    // we don't want Redis, and current Claude clients use Streamable HTTP.
    disableSse: true,
    verboseLogs: false,
  },
);

// ---------------------------------------------------------------------------
// Auth layer 1: Claude → this server. A shared secret guards the public URL
// that can write CRM data.
//
// We deliberately do NOT use mcp-handler's withMcpAuth here: it advertises
// OAuth "protected resource" metadata on a 401, which makes the claude.ai
// custom-connector UI attempt a full OAuth sign-in flow against a server that
// has no OAuth authorization server (the connector dialog has no bearer-token
// field). Instead we accept the shared secret two ways and return a PLAIN 401
// (no WWW-Authenticate/resource_metadata) so no client tries to negotiate
// OAuth:
//   1. `Authorization: Bearer <token>` header — for curl, Claude Code, and the
//      Claude API MCP connector (authorization_token).
//   2. a `?token=<token>` (or `?key=`) query param — for the claude.ai custom
//      connector, where the secret is baked into the connector URL.
//
// This bearer token should be treated as MORE sensitive than the read-only
// sibling server's token: anyone holding it can create/update Product2
// records. Use a separate token from the read-only server's, so the two can
// be rotated/revoked independently.
// ---------------------------------------------------------------------------

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function extractToken(req: Request): string | undefined {
  const authHeader = req.headers.get("authorization");
  if (authHeader) {
    const [type, token] = authHeader.split(" ");
    if (type?.toLowerCase() === "bearer" && token) return token;
  }
  const url = new URL(req.url);
  return url.searchParams.get("token") ?? url.searchParams.get("key") ?? undefined;
}

function isAuthorized(req: Request): boolean {
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected) {
    // Misconfiguration: with no configured secret we cannot authenticate
    // anyone, so reject all requests rather than fail open.
    console.error("MCP_BEARER_TOKEN is not set; rejecting all MCP requests.");
    return false;
  }
  const provided = extractToken(req);
  return provided != null && safeEqual(provided, expected);
}

async function guarded(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return new Response(
      JSON.stringify({ error: "unauthorized", error_description: "Missing or invalid token." }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }
  return handler(req);
}

export { guarded as GET, guarded as POST };
