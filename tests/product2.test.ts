import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sanitizeProduct2Fields } from "@/lib/product2";

describe("sanitizeProduct2Fields", () => {
  it("passes through valid standard and custom field names", () => {
    const r = sanitizeProduct2Fields({
      Name: "Widget",
      ProductCode: "W-100",
      My_Field__c: 1,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fields).toEqual({ Name: "Widget", ProductCode: "W-100", My_Field__c: 1 });
  });

  it("rejects an empty fields object", () => {
    const r = sanitizeProduct2Fields({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least one field/i);
  });

  it("rejects Id and attributes", () => {
    const r = sanitizeProduct2Fields({ Id: "01t000000000001AAA", Name: "Widget" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Id/);
  });

  it("rejects relationship-path field names", () => {
    const r = sanitizeProduct2Fields({ "Owner.Name": "x" } as Record<string, string>);
    expect(r.ok).toBe(false);
  });

  it("rejects field names that don't start with a letter", () => {
    const r = sanitizeProduct2Fields({ "1Field": "x" } as Record<string, string>);
    expect(r.ok).toBe(false);
  });
});

describe("createProduct2 / updateProduct2", () => {
  const TOKEN_URL = "https://iki.my.salesforce.com/services/oauth2/token";
  const INSTANCE_URL = "https://iki.my.salesforce.com";

  function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}) {
    const status = init.status ?? 200;
    return {
      ok: init.ok ?? (status >= 200 && status < 300),
      status,
      statusText: status === 200 ? "OK" : "ERR",
      text: async () => (body === null ? "" : JSON.stringify(body)),
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

  it("POSTs a create to /sobjects/Product2 with the sanitized body", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = url.toString();
      if (u === TOKEN_URL) {
        return jsonResponse({ access_token: "tok", instance_url: INSTANCE_URL, expires_in: 3600 });
      }
      if (u.endsWith("/services/data/v66.0/sobjects/Product2") && init?.method === "POST") {
        return jsonResponse({ id: "01t000000000001AAA", success: true, errors: [] }, { status: 201 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createProduct2 } = await import("@/lib/product2");
    const result = await createProduct2({ Name: "Widget" });
    expect(result).toEqual({ id: "01t000000000001AAA", success: true, errors: [] });

    const createCall = fetchMock.mock.calls.find(
      ([u, init]) =>
        u.toString().endsWith("/sobjects/Product2") && (init as RequestInit)?.method === "POST",
    );
    expect(createCall).toBeTruthy();
    expect(JSON.parse((createCall![1] as RequestInit).body as string)).toEqual({ Name: "Widget" });
  });

  it("PATCHes an update to /sobjects/Product2/{id} with the sanitized body", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = url.toString();
      if (u === TOKEN_URL) {
        return jsonResponse({ access_token: "tok", instance_url: INSTANCE_URL, expires_in: 3600 });
      }
      if (
        u.endsWith("/services/data/v66.0/sobjects/Product2/01t000000000001AAA") &&
        init?.method === "PATCH"
      ) {
        return jsonResponse(null, { status: 204 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { updateProduct2 } = await import("@/lib/product2");
    await expect(updateProduct2("01t000000000001AAA", { IsActive: false })).resolves.toBeUndefined();

    const updateCall = fetchMock.mock.calls.find(([u]) =>
      u.toString().endsWith("/sobjects/Product2/01t000000000001AAA"),
    );
    expect(updateCall).toBeTruthy();
    expect(JSON.parse((updateCall![1] as RequestInit).body as string)).toEqual({ IsActive: false });
  });

  it("surfaces a Salesforce write failure as SalesforceError", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = url.toString();
      if (u === TOKEN_URL) {
        return jsonResponse({ access_token: "tok", instance_url: INSTANCE_URL, expires_in: 3600 });
      }
      return jsonResponse(
        [{ message: "REQUIRED_FIELD_MISSING: [Name]", errorCode: "REQUIRED_FIELD_MISSING" }],
        { status: 400 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createProduct2 } = await import("@/lib/product2");
    await expect(createProduct2({ ProductCode: "W-100" })).rejects.toMatchObject({
      name: "SalesforceError",
      status: 400,
    });
  });
});
