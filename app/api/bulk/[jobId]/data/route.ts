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
 *   Body: the ENTIRE CSV (header + all data rows), in one request.
 *
 * IMPORTANT, learned the hard way against a real org: Salesforce's Bulk API
 * 2.0 ingest jobs accept exactly ONE `PUT .../batches` call per job -- a
 * second PUT to the same job is rejected outright ("Found multiple contents
 * for job"). There is no way to append data in multiple calls to one job.
 * An earlier version of this route supported a `?final=false` chunking
 * scheme; that was based on a wrong assumption about the API and has been
 * removed. The real, unavoidable ceiling is Vercel's Node.js serverless
 * request-body limit (~4.5 MB, not tunable from Next.js config -- that
 * config only applies to the legacy Pages API, not App Router route
 * handlers), so the whole CSV must fit under roughly 4.4 MB in one request.
 * A file that large would need to be split across multiple separate Bulk
 * API jobs (each with its own single PUT) -- not built here, since it
 * wasn't needed for the files this server was built for (a few thousand
 * rows, well under that ceiling).
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

  const csv = await req.text();
  if (!csv) {
    return Response.json(
      { error: "bad_request", error_description: "Empty request body -- expected the full raw CSV." },
      { status: 400 },
    );
  }

  try {
    await uploadBulkJobBatch(jobId, csv);
    await closeBulkJob(jobId);
    return Response.json({
      jobId,
      closed: true,
      note: "Upload complete; job closed and Salesforce has started processing. Poll get_bulk_product2_job_status for results.",
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
