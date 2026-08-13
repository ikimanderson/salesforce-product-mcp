import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateBulkSampleRows } from "@/lib/bulkProduct2";

describe("validateBulkSampleRows", () => {
  it("rejects an empty sample", () => {
    const r = validateBulkSampleRows("insert", []);
    expect(r.ok).toBe(false);
  });

  describe("insert", () => {
    it("passes valid rows with no Id column", () => {
      const r = validateBulkSampleRows("insert", [{ Name: "Widget", ProductCode: "W-100" }]);
      expect(r.ok).toBe(true);
    });

    it("rejects a row that includes an Id column", () => {
      const r = validateBulkSampleRows("insert", [{ Id: "01t000000000001AAA", Name: "Widget" }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/insert.*Id/i);
    });
  });

  describe("update", () => {
    it("requires an Id column on every row", () => {
      const r = validateBulkSampleRows("update", [{ IsActive: false }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/update.*Id/i);
    });

    it("passes a row with Id plus other valid fields", () => {
      const r = validateBulkSampleRows("update", [{ Id: "01t000000000001AAA", IsActive: false }]);
      expect(r.ok).toBe(true);
    });
  });

  describe("upsert", () => {
    it("fails without an externalIdFieldName option", () => {
      const r = validateBulkSampleRows("upsert", [{ ProductCode: "W-100", Name: "Widget" }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/externalIdFieldName/);
    });

    it("requires the externalIdFieldName column on every row", () => {
      const r = validateBulkSampleRows(
        "upsert",
        [{ Name: "Widget" }],
        { externalIdFieldName: "ProductCode" },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/ProductCode/);
    });

    it("rejects a row that includes an Id column", () => {
      const r = validateBulkSampleRows(
        "upsert",
        [{ Id: "01t000000000001AAA", ProductCode: "W-100" }],
        { externalIdFieldName: "ProductCode" },
      );
      expect(r.ok).toBe(false);
    });

    it("passes a valid row with the external id column present", () => {
      const r = validateBulkSampleRows(
        "upsert",
        [{ ProductCode: "W-100", Name: "Widget" }],
        { externalIdFieldName: "ProductCode" },
      );
      expect(r.ok).toBe(true);
    });
  });

  it("rejects disallowed/relationship field names regardless of operation", () => {
    const r = validateBulkSampleRows("insert", [{ Name: "Widget", "Owner.Name": "x" }]);
    expect(r.ok).toBe(false);
  });
});

describe("Bulk API client", () => {
  const TOKEN_URL = "https://iki.my.salesforce.com/services/oauth2/token";
  const INSTANCE_URL = "https://iki.my.salesforce.com";
  const JOBS_PATH = "/services/data/v66.0/jobs/ingest";

  function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}) {
    const status = init.status ?? 200;
    return {
      ok: init.ok ?? (status >= 200 && status < 300),
      status,
      statusText: status === 200 ? "OK" : "ERR",
      text: async () => (body === null ? "" : JSON.stringify(body)),
    } as unknown as Response;
  }

  function textResponse(text: string, init: { status?: number; ok?: boolean } = {}) {
    const status = init.status ?? 200;
    return {
      ok: init.ok ?? (status >= 200 && status < 300),
      status,
      statusText: status === 200 ? "OK" : "ERR",
      text: async () => text,
    } as unknown as Response;
  }

  beforeEach(() => {
    vi.resetModules();
    process.env.SF_LOGIN_URL = INSTANCE_URL;
    process.env.SF_CLIENT_ID = "client-id";
    process.env.SF_CLIENT_SECRET = "client-secret";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("createBulkJob omits externalIdFieldName for insert", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = url.toString();
      if (u === TOKEN_URL) {
        return jsonResponse({ access_token: "tok", instance_url: INSTANCE_URL, expires_in: 3600 });
      }
      if (u.endsWith(JOBS_PATH) && init?.method === "POST") {
        return jsonResponse({ id: "750xx0000000001", state: "Open" }, { status: 201 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createBulkJob } = await import("@/lib/bulkProduct2");
    const job = await createBulkJob("insert");
    expect(job).toEqual({ id: "750xx0000000001", state: "Open" });

    const call = fetchMock.mock.calls.find(([u]) => u.toString().endsWith(JOBS_PATH));
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body).toEqual({ object: "Product2", operation: "insert", contentType: "CSV", lineEnding: "LF" });
    expect(body.externalIdFieldName).toBeUndefined();
  });

  it("createBulkJob includes externalIdFieldName for upsert", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = url.toString();
      if (u === TOKEN_URL) {
        return jsonResponse({ access_token: "tok", instance_url: INSTANCE_URL, expires_in: 3600 });
      }
      if (u.endsWith(JOBS_PATH) && init?.method === "POST") {
        return jsonResponse({ id: "750xx0000000002", state: "Open" }, { status: 201 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createBulkJob } = await import("@/lib/bulkProduct2");
    await createBulkJob("upsert", "ProductCode");

    const call = fetchMock.mock.calls.find(([u]) => u.toString().endsWith(JOBS_PATH));
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.operation).toBe("upsert");
    expect(body.externalIdFieldName).toBe("ProductCode");
  });

  it("createBulkJob rejects upsert without externalIdFieldName before ever calling fetch", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("should not be called");
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createBulkJob } = await import("@/lib/bulkProduct2");
    await expect(createBulkJob("upsert")).rejects.toThrow(/externalIdFieldName/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("getBulkJobStatus GETs the job and returns its state", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = url.toString();
      if (u === TOKEN_URL) {
        return jsonResponse({ access_token: "tok", instance_url: INSTANCE_URL, expires_in: 3600 });
      }
      if (u.endsWith(`${JOBS_PATH}/750xx0000000001`)) {
        return jsonResponse({
          id: "750xx0000000001",
          state: "JobComplete",
          numberRecordsProcessed: 3,
          numberRecordsFailed: 1,
        });
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getBulkJobStatus } = await import("@/lib/bulkProduct2");
    const status = await getBulkJobStatus("750xx0000000001");
    expect(status).toMatchObject({ state: "JobComplete", numberRecordsProcessed: 3, numberRecordsFailed: 1 });
  });

  it("uploadBulkJobBatch PUTs raw CSV with a text/csv content type", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = url.toString();
      if (u === TOKEN_URL) {
        return jsonResponse({ access_token: "tok", instance_url: INSTANCE_URL, expires_in: 3600 });
      }
      if (u.endsWith(`${JOBS_PATH}/750xx0000000001/batches`) && init?.method === "PUT") {
        return jsonResponse(null, { status: 201 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { uploadBulkJobBatch } = await import("@/lib/bulkProduct2");
    await uploadBulkJobBatch("750xx0000000001", "Name,ProductCode\nWidget,W-100\n");

    const call = fetchMock.mock.calls.find(([u]) => u.toString().endsWith("/batches"));
    const init = call![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("text/csv");
    expect(init.body).toBe("Name,ProductCode\nWidget,W-100\n");
  });

  it("closeBulkJob PATCHes the job with the given state", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = url.toString();
      if (u === TOKEN_URL) {
        return jsonResponse({ access_token: "tok", instance_url: INSTANCE_URL, expires_in: 3600 });
      }
      if (u.endsWith(`${JOBS_PATH}/750xx0000000001`) && init?.method === "PATCH") {
        return jsonResponse({ id: "750xx0000000001", state: "UploadComplete" });
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { closeBulkJob } = await import("@/lib/bulkProduct2");
    await closeBulkJob("750xx0000000001");

    const call = fetchMock.mock.calls.find(
      ([u, init]) => u.toString().endsWith(`${JOBS_PATH}/750xx0000000001`) && (init as RequestInit)?.method === "PATCH",
    );
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ state: "UploadComplete" });
  });

  it("getBulkJobFailedResultsSummary parses CSV and caps the sample", async () => {
    const header = "sf__Id,sf__Error,Name,ProductCode";
    const rows = Array.from({ length: 30 }, (_, i) =>
      `,"REQUIRED_FIELD_MISSING: [Name]",,"W-${i}"`,
    );
    const csv = [header, ...rows].join("\n") + "\n";

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = url.toString();
      if (u === TOKEN_URL) {
        return jsonResponse({ access_token: "tok", instance_url: INSTANCE_URL, expires_in: 3600 });
      }
      if (u.endsWith(`${JOBS_PATH}/750xx0000000001/failedResults`)) {
        return textResponse(csv);
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getBulkJobFailedResultsSummary } = await import("@/lib/bulkProduct2");
    const summary = await getBulkJobFailedResultsSummary("750xx0000000001");

    expect(summary.totalFailedRows).toBe(30);
    expect(summary.truncated).toBe(true);
    expect(summary.sample).toHaveLength(25);
    expect(summary.sample[0].ProductCode).toBe("W-0");
    expect(summary.sample[0].sf__Error).toBe("REQUIRED_FIELD_MISSING: [Name]");
  });

  it("getBulkJobFailedResultsSummary reports zero failures on an empty result set", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = url.toString();
      if (u === TOKEN_URL) {
        return jsonResponse({ access_token: "tok", instance_url: INSTANCE_URL, expires_in: 3600 });
      }
      if (u.endsWith(`${JOBS_PATH}/750xx0000000001/failedResults`)) {
        return textResponse("");
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { getBulkJobFailedResultsSummary } = await import("@/lib/bulkProduct2");
    const summary = await getBulkJobFailedResultsSummary("750xx0000000001");
    expect(summary).toEqual({ totalFailedRows: 0, sample: [], truncated: false });
  });
});
