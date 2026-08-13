import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Smoke test for the Salesforce client with the network fully mocked, so the
 * build is verifiable without live credentials. Verifies:
 *  - the Client Credentials token exchange, then an authenticated REST call
 *    against the returned instance_url + v66.0;
 *  - the token is cached and reused across calls (quota-friendly);
 *  - failures surface as SalesforceError with status + body excerpt.
 */

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

describe("salesforce client", () => {
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

  it("authenticates, calls the REST API, and reuses the cached token", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = url.toString();
      calls.push(u);
      if (u === TOKEN_URL) {
        return jsonResponse({
          access_token: "tok-123",
          instance_url: INSTANCE_URL,
          expires_in: 3600,
        });
      }
      if (u.includes("/services/data/v66.0/sobjects/Product2")) {
        return jsonResponse({ id: "01t000000000001AAA", success: true, errors: [] }, { status: 201 });
      }
      throw new Error(`unexpected fetch to ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { sfFetch } = await import("@/lib/salesforce");

    const first = await sfFetch("/services/data/v66.0/sobjects/Product2", {
      method: "POST",
      body: JSON.stringify({ Name: "Widget" }),
    });
    expect(first).toMatchObject({ id: "01t000000000001AAA" });

    // Second call should NOT re-hit the token endpoint.
    await sfFetch("/services/data/v66.0/sobjects/Product2", {
      method: "POST",
      body: JSON.stringify({ Name: "Widget 2" }),
    });

    const tokenCalls = calls.filter((u) => u === TOKEN_URL).length;
    expect(tokenCalls).toBe(1);

    // The call hits the instance URL with the v66.0 REST version and bearer token.
    const restCall = fetchMock.mock.calls.find(([u]) =>
      u.toString().includes("/services/data/v66.0/sobjects/Product2"),
    );
    expect(restCall).toBeTruthy();
    const init = restCall![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
  });

  it("surfaces a REST failure as a SalesforceError with status and excerpt", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = url.toString();
      if (u === TOKEN_URL) {
        return jsonResponse({ access_token: "tok", instance_url: INSTANCE_URL, expires_in: 3600 });
      }
      return jsonResponse([{ message: "REQUIRED_FIELD_MISSING: [Name]" }], { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { sfFetch, SalesforceError } = await import("@/lib/salesforce");

    await expect(
      sfFetch("/services/data/v66.0/sobjects/Product2", { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({
      name: "SalesforceError",
      status: 400,
    });

    // And the excerpt carries the Salesforce body.
    try {
      await sfFetch("/services/data/v66.0/sobjects/Product2", { method: "POST", body: "{}" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SalesforceError);
      expect((err as InstanceType<typeof SalesforceError>).bodyExcerpt).toMatch(
        /REQUIRED_FIELD_MISSING/,
      );
    }
  });

  it("raises a clear error when Salesforce env vars are missing", async () => {
    delete process.env.SF_LOGIN_URL;
    delete process.env.SF_CLIENT_ID;
    delete process.env.SF_CLIENT_SECRET;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("should not be called");
      }),
    );

    const { sfFetch } = await import("@/lib/salesforce");
    await expect(
      sfFetch("/services/data/v66.0/sobjects/Product2", { method: "POST", body: "{}" }),
    ).rejects.toMatchObject({
      name: "SalesforceError",
      status: 500,
    });
  });
});
