/**
 * Salesforce Bulk API 2.0 client for bulk Product2 insert/update/upsert.
 *
 * Why this exists alongside the single-record create_product2/update_product2
 * tools: those write one record per REST call, which is fine for ad-hoc edits
 * but not for a multi-thousand-row CSV import (the kind previously done via
 * dataloader.io) — looping single-record calls at that scale is slow and
 * burns through the Professional Edition API add-on's daily quota fast.
 *
 * The actual CSV bytes never pass through an MCP tool call (see route.ts's
 * start_bulk_product2_job / the upload route in
 * app/api/bulk/[jobId]/data/route.ts) — only small metadata (row counts,
 * a handful of sample rows, job status, capped failure summaries) does.
 * This file is the thin Salesforce-facing half of that: create a job, accept
 * CSV batches, close the job, poll status, and summarize failures without
 * ever returning a full (potentially huge) result set to the caller.
 */

import { sfFetch, SF_API_VERSION } from "@/lib/salesforce";
import { FIELD_NAME_PATTERN, DISALLOWED_FIELDS, type FieldValue } from "@/lib/product2";

export type BulkOperation = "insert" | "update" | "upsert";

/**
 * Self-imposed sanity cap on the DECLARED row count passed through the MCP
 * tool call — a mistake-guard against pointing at the wrong file, not a
 * Salesforce limit. Bulk API 2.0 itself handles orders of magnitude more
 * (well beyond what this server is ever asked to process).
 */
export const MAX_ROW_COUNT = 50_000;

export interface BulkJob {
  id: string;
  state: string;
}

/** Loosely typed: Salesforce returns many more fields than these; callers get the full object at runtime. */
export interface BulkJobStatus {
  id: string;
  state: string;
  numberRecordsProcessed?: number;
  numberRecordsFailed?: number;
}

export interface FailedResultsSummary {
  totalFailedRows: number;
  sample: Array<Record<string, string>>;
  truncated: boolean;
}

/** Open a new Bulk API 2.0 ingest job for Product2. */
export async function createBulkJob(
  operation: BulkOperation,
  externalIdFieldName?: string,
): Promise<BulkJob> {
  if (operation === "upsert" && !externalIdFieldName?.trim()) {
    throw new Error("externalIdFieldName is required for upsert.");
  }

  const body: Record<string, unknown> = {
    object: "Product2",
    operation,
    contentType: "CSV",
    lineEnding: "LF",
  };
  // Omit externalIdFieldName entirely for insert/update rather than sending
  // it empty -- Salesforce only expects this key for upsert.
  if (operation === "upsert") {
    body.externalIdFieldName = externalIdFieldName;
  }

  const result = await sfFetch(`/services/data/${SF_API_VERSION}/jobs/ingest`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return result as BulkJob;
}

/** Poll a job's current state and processed/failed counts. */
export async function getBulkJobStatus(jobId: string): Promise<BulkJobStatus> {
  const result = await sfFetch(
    `/services/data/${SF_API_VERSION}/jobs/ingest/${encodeURIComponent(jobId)}`,
  );
  return result as BulkJobStatus;
}

/**
 * Upload the full CSV (header + all data rows) to an open job.
 *
 * Verified against a real org: Salesforce accepts exactly ONE call to this
 * endpoint per job -- a second call on the same job is rejected outright
 * ("Found multiple contents for job"). There is no multi-batch append; the
 * whole file must go in this one call, capped in practice by Vercel's
 * request-body limit (~4.5 MB) rather than anything Salesforce-side.
 */
export async function uploadBulkJobBatch(jobId: string, csv: string): Promise<void> {
  await sfFetch(
    `/services/data/${SF_API_VERSION}/jobs/ingest/${encodeURIComponent(jobId)}/batches`,
    { method: "PUT", headers: { "Content-Type": "text/csv" }, body: csv },
  );
}

/** Close a job so Salesforce starts (or aborts) processing it. */
export async function closeBulkJob(
  jobId: string,
  state: "UploadComplete" | "Aborted" = "UploadComplete",
): Promise<void> {
  await sfFetch(
    `/services/data/${SF_API_VERSION}/jobs/ingest/${encodeURIComponent(jobId)}`,
    { method: "PATCH", body: JSON.stringify({ state }) },
  );
}

/**
 * Fetch and summarize a job's failed rows -- capped at `sampleLimit`
 * regardless of how many thousand rows actually failed, so a bad file never
 * dumps an enormous result set into a tool response.
 */
export async function getBulkJobFailedResultsSummary(
  jobId: string,
  sampleLimit = 25,
): Promise<FailedResultsSummary> {
  const csv = await sfFetch(
    `/services/data/${SF_API_VERSION}/jobs/ingest/${encodeURIComponent(jobId)}/failedResults`,
    {},
    { rawResponse: true },
  );

  const rows = parseCsv(csv).filter((row) => row.length > 1 || row[0] !== "");
  if (rows.length === 0) {
    return { totalFailedRows: 0, sample: [], truncated: false };
  }

  const [header, ...dataRows] = rows;
  const totalFailedRows = dataRows.length;
  const sample = dataRows.slice(0, sampleLimit).map((row) => {
    const record: Record<string, string> = {};
    header.forEach((col, i) => {
      record[col] = row[i] ?? "";
    });
    return record;
  });

  return { totalFailedRows, sample, truncated: totalFailedRows > sampleLimit };
}

export type BulkValidation = { ok: true } | { ok: false; error: string };

/**
 * Validate a small sample of rows against per-operation rules before a
 * bulk job is even created. Runs only against the sample passed through the
 * MCP tool call (at most a handful of rows) -- the full file's data is
 * validated Salesforce-side once actually uploaded and processed.
 */
export function validateBulkSampleRows(
  operation: BulkOperation,
  sampleRows: Array<Record<string, FieldValue>>,
  opts: { externalIdFieldName?: string } = {},
): BulkValidation {
  if (sampleRows.length === 0) {
    return { ok: false, error: "Provide at least one sample row to validate." };
  }

  for (const row of sampleRows) {
    const keys = Object.keys(row);
    if (keys.length === 0) {
      return { ok: false, error: "Sample row has no fields." };
    }

    if (operation === "insert" && keys.includes("Id")) {
      return { ok: false, error: '"insert" rows must not include an "Id" column.' };
    }
    if (operation === "update" && !keys.includes("Id")) {
      return {
        ok: false,
        error: '"update" rows must include an "Id" column identifying the record to update.',
      };
    }
    if (operation === "upsert") {
      if (!opts.externalIdFieldName?.trim()) {
        return { ok: false, error: "externalIdFieldName is required for upsert." };
      }
      if (keys.includes("Id")) {
        return {
          ok: false,
          error: '"upsert" rows must not include an "Id" column -- match on the external ID field instead.',
        };
      }
      if (!keys.includes(opts.externalIdFieldName)) {
        return {
          ok: false,
          error: `"upsert" rows must include the "${opts.externalIdFieldName}" column.`,
        };
      }
    }

    // "Id" is the per-row target key for "update", not a guarded write field --
    // every other key still goes through the same allowlist as single-record writes.
    const bad = keys.filter((key) => {
      if (key === "Id" && operation === "update") return false;
      return DISALLOWED_FIELDS.has(key) || !FIELD_NAME_PATTERN.test(key);
    });
    if (bad.length > 0) {
      return {
        ok: false,
        error:
          `Invalid or disallowed field name(s): ${bad.join(", ")}. ` +
          'Field names must be plain Salesforce API names (e.g. "Name", "ProductCode", ' +
          '"My_Field__c") -- no "attributes" or relationship paths like "Owner.Name".',
      };
    }
  }

  return { ok: true };
}

/**
 * Minimal RFC4180-ish CSV parser (no dependency): handles quoted fields with
 * embedded commas/newlines and "" escaped quotes, and both \n and \r\n line
 * endings. Only used here to parse Salesforce's own failedResults CSV, which
 * is well-formed -- this is not meant to handle arbitrary hostile input.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // skip; \n (below) ends the row
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
