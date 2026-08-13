import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { SalesforceError } from "@/lib/salesforce";
import {
  sanitizeProduct2Fields,
  createProduct2,
  updateProduct2,
  type FieldValue,
} from "@/lib/product2";
import {
  validateBulkSampleRows,
  createBulkJob,
  getBulkJobStatus,
  getBulkJobFailedResultsSummary,
  MAX_ROW_COUNT,
  type BulkOperation,
} from "@/lib/bulkProduct2";
import { isAuthorized, unauthorizedResponse } from "@/lib/auth";

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
// This server is deliberately narrow: it only ever writes to Product2. It
// does not expose SOQL or any other sobject — that's the read-only sibling
// server's job. Keeping this one single-purpose keeps its blast radius (and
// its bearer token's blast radius) small.
//
// Four tools: create_product2/update_product2 write one record per call.
// start_bulk_product2_job/get_bulk_product2_job_status handle multi-row CSV
// imports via Salesforce's Bulk API 2.0 — the actual CSV bytes never pass
// through a tool call (see start_bulk_product2_job's doc string and
// app/api/bulk/[jobId]/data/route.ts); only small metadata does.
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

    // ----- start_bulk_product2_job ---------------------------------------------
    // Opens a Salesforce Bulk API 2.0 job for a multi-row CSV import (insert/
    // update/upsert). This tool NEVER carries the actual row data beyond a
    // small validation sample -- a real CSV (the kind previously run through
    // dataloader.io, up to several thousand rows) is far too much to embed in
    // a tool call. Guarded the same way as the single-record tools: without
    // confirm: true, this only validates rowCount + sampleRows and returns a
    // preview, with no Salesforce call made. confirm: true actually opens the
    // job and returns an uploadPath -- a RELATIVE path (there's no reliable
    // way to learn this deployment's own base URL from inside an MCP tool
    // handler), meant to be PUT to via curl from a shell-capable session, not
    // embedded in another tool call. See app/api/bulk/[jobId]/data/route.ts
    // for the upload contract (including chunking for larger files).
    server.tool(
      "start_bulk_product2_job",
      "Open a Salesforce Bulk API 2.0 job to insert, update, or upsert many " +
        "Product2 records from a CSV file. Without confirm: true, validates " +
        "rowCount and sampleRows and returns a preview, with no Salesforce call " +
        "made. Pass confirm: true to actually open the job, which returns an " +
        "uploadPath -- PUT your CSV file to that path (relative to this " +
        "server's host) via curl, NOT through another tool call; the CSV never " +
        "passes through this tool. For upsert, externalIdFieldName must be a " +
        "field already marked as an External ID in Salesforce Object Manager.",
      {
        operation: z
          .enum(["insert", "update", "upsert"])
          .describe('"insert" for new records, "update" by Id, or "upsert" matched by externalIdFieldName.'),
        externalIdFieldName: z
          .string()
          .optional()
          .describe('Required for "upsert" only -- the External ID field to match existing records on.'),
        rowCount: z
          .number()
          .int()
          .positive()
          .describe("Total number of data rows in the CSV file you intend to upload (not counting the header)."),
        sampleRows: z
          .array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])))
          .min(1)
          .max(10)
          .describe(
            "A SMALL sample (1-10 rows) of the real data, used only to validate column names before " +
              "opening a job -- not the full file. For \"update\", each row must include \"Id\". For " +
              '"upsert", each row must include the externalIdFieldName column. No "attributes" or ' +
              "relationship fields (e.g. \"Owner.Name\").",
          ),
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Set to true to actually open the Bulk API job. Omit or set false to validate and preview only.",
          ),
      },
      async ({ operation, externalIdFieldName, rowCount, sampleRows, confirm }): Promise<ToolResult> => {
        try {
          if (rowCount > MAX_ROW_COUNT) {
            return fail(
              `rowCount (${rowCount}) exceeds the ${MAX_ROW_COUNT}-row sanity cap for this tool. ` +
                "This is a mistake-guard against pointing at the wrong file, not a Salesforce limit -- " +
                "if you genuinely need to import more rows than that, split the file.",
            );
          }
          if (operation === "upsert" && !externalIdFieldName?.trim()) {
            return fail('externalIdFieldName is required when operation is "upsert".');
          }

          const validation = validateBulkSampleRows(
            operation as BulkOperation,
            sampleRows as Array<Record<string, FieldValue>>,
            { externalIdFieldName },
          );
          if (!validation.ok) return fail(validation.error);

          if (!confirm) {
            return ok({
              dryRun: true,
              operation,
              externalIdFieldName,
              rowCount,
              sampleRowsValidated: sampleRows.length,
              note: "No job created. Call again with confirm: true to open the Bulk API job.",
            });
          }

          const job = await createBulkJob(operation as BulkOperation, externalIdFieldName);
          return ok({
            dryRun: false,
            jobId: job.id,
            state: job.state,
            uploadPath: `/api/bulk/${job.id}/data`,
            note:
              "PUT your CSV to this path on the SAME HOST you called this MCP endpoint on, via curl " +
              "(e.g. curl --data-binary @file.csv -H \"Authorization: Bearer <MCP_BEARER_TOKEN>\" -X PUT " +
              "\"<host>/api/bulk/" +
              job.id +
              "/data\"), not through another tool call. If the file might exceed a few MB, split it into " +
              "row-aligned chunks: PUT each non-final chunk with ?final=false, and only the LAST chunk " +
              "with ?final=true (or omit the param on a single-shot upload). Only the FIRST chunk may " +
              "include the CSV header row. After uploading, poll get_bulk_product2_job_status.",
          });
        } catch (err) {
          return toErrorResult(err);
        }
      },
    );

    // ----- get_bulk_product2_job_status -----------------------------------------
    // Read-only status check for a job opened by start_bulk_product2_job. Once
    // the job has finished (JobComplete or Failed), also fetches a CAPPED
    // summary of failed rows -- never the full result set, however many
    // thousand rows actually failed.
    server.tool(
      "get_bulk_product2_job_status",
      "Check the status of a Bulk API 2.0 job started by start_bulk_product2_job. " +
        "Once the job has finished, also returns a capped summary of any failed rows.",
      {
        jobId: z.string().describe("The job Id returned by start_bulk_product2_job."),
      },
      async ({ jobId }): Promise<ToolResult> => {
        try {
          const status = await getBulkJobStatus(jobId);
          if (status.state !== "JobComplete" && status.state !== "Failed") {
            return ok(status);
          }
          const failedResults = await getBulkJobFailedResultsSummary(jobId);
          return ok({ ...status, failedResults });
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
// that can write CRM data. Token extraction/comparison lives in lib/auth.ts
// (shared with the bulk-upload route in app/api/bulk/[jobId]/data/route.ts).
//
// We deliberately do NOT use mcp-handler's withMcpAuth here: it advertises
// OAuth "protected resource" metadata on a 401, which makes the claude.ai
// custom-connector UI attempt a full OAuth sign-in flow against a server that
// has no OAuth authorization server (the connector dialog has no bearer-token
// field). Instead lib/auth.ts's isAuthorized() accepts the shared secret two
// ways (Authorization header or ?token=/?key= query param) and this route
// returns a PLAIN 401 (no WWW-Authenticate/resource_metadata) so no client
// tries to negotiate OAuth.
//
// This bearer token should be treated as MORE sensitive than the read-only
// sibling server's token: anyone holding it can create/update Product2
// records. Use a separate token from the read-only server's, so the two can
// be rotated/revoked independently.
// ---------------------------------------------------------------------------

async function guarded(req: Request): Promise<Response> {
  if (!isAuthorized(req)) {
    return unauthorizedResponse();
  }
  return handler(req);
}

export { guarded as GET, guarded as POST };
