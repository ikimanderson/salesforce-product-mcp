import { SalesforceError } from "@/lib/salesforce";
import { uploadBulkJobBatch, closeBulkJob } from "@/lib/bulkProduct2";
import { isAuthorized, unauthorizedResponse } from "@/lib/auth";

/**
 * Plain HTTP upload endpoint for Bulk API 2.0 CSV data -- NOT an MCP tool.
 * This exists specifically so the actual CSV bytes never have to pass through
 * an MCP tool call (see start_bulk_product2_job in app/api/[transport]/route.ts
 * for why: a real multi-thousand-row file is far too much to embed in a
 * tool-call argument). A shell-capable session streams the file here directly
 * via `curl --data-binary @file.csv`, guarded by the same bearer token as the
 * MCP endpoint -- no new secret.
 *
 * PUT /api/bulk/{jobId}/data
 *   Body: raw CSV text (Content-Type doesn't matter to us; we don't parse it here).
 *   Query: ?final=false to upload one batch of a larger, chunked file without
 *     closing the job yet (Vercel's Node.js serverless functions have a hard
 *     ~4.5 MB request-body ceiling that isn't tunable from Next.js config --
 *     that limit only applies to the legacy Pages API, not App Router route
 *     handlers -- so a file that might be a few MB should be split into
 *     row-aligned chunks). Omit the param, or pass final=true, on the last
 *     (or only) chunk to close the job and kick off Salesforce's processing.
 *
 * Only the FIRST chunk may include the CSV header row; every later chunk must
 * be pure data rows, and splits must land on row boundaries -- this route
 * just relays bytes to Salesforce, it can't validate or fix a mid-row split.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

async function handlePut(
  req: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  if (!isAuthorized(req)) {
    return unauthorizedResponse();
  }

  const { jobId } = await params;
  if (!jobId?.trim()) {
    return Response.json(
      { error: "bad_request", error_description: "Missing jobId in the URL path." },
      { status: 400 },
    );
  }

  const url = new URL(req.url);
  const isFinal = url.searchParams.get("final") !== "false";

  const csvChunk = await req.text();
  if (!csvChunk) {
    return Response.json(
      { error: "bad_request", error_description: "Empty request body -- expected raw CSV data." },
      { status: 400 },
    );
  }

  try {
    await uploadBulkJobBatch(jobId, csvChunk);
    if (isFinal) {
      await closeBulkJob(jobId);
    }
    return Response.json({
      jobId,
      closed: isFinal,
      note: isFinal
        ? "Upload complete; job closed and Salesforce has started processing. Poll get_bulk_product2_job_status for results."
        : "Chunk uploaded; job still open. PUT the next chunk to this same URL, and pass final=true (or omit it) on the last one.",
    });
  } catch (err) {
    if (err instanceof SalesforceError) {
      return Response.json(
        {
          error: "salesforce_error",
          error_description: err.message,
          status: err.status,
          bodyExcerpt: err.bodyExcerpt,
        },
        { status: 502 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: "internal_error", error_description: message }, { status: 500 });
  }
}

export { handlePut as PUT };
