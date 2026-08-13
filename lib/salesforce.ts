/**
 * Salesforce REST client for the IKI Product2-write MCP server.
 *
 * Auth: OAuth 2.0 Client Credentials flow against an External Client App (ECA).
 * (Professional Edition + API add-on: hosted MCP and the DX MCP server are not
 * options, and new Connected Apps are blocked in Spring '26 — so we talk to the
 * REST API directly.) We POST to the token endpoint, cache the returned
 * access_token + instance_url at module scope, and reuse it across warm
 * invocations to stay well under the Professional Edition daily API quota.
 *
 * All secrets come from env vars — nothing is hardcoded.
 */

export const SF_API_VERSION = "v66.0";

/** Error carrying a Salesforce HTTP status + a trimmed body excerpt for the model. */
export class SalesforceError extends Error {
  readonly status: number;
  readonly bodyExcerpt: string;

  constructor(message: string, status: number, bodyExcerpt = "") {
    super(message);
    this.name = "SalesforceError";
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
  }
}

interface SalesforceConfig {
  loginUrl: string;
  clientId: string;
  clientSecret: string;
}

interface CachedToken {
  accessToken: string;
  instanceUrl: string;
  /** Epoch ms after which we proactively refresh. */
  expiresAt: number;
}

/**
 * Module-scoped token cache. Persists across warm serverless invocations, so a
 * typical write (1–2 REST calls) reuses one token rather than re-authing.
 */
let cachedToken: CachedToken | null = null;
/** De-dupe concurrent token fetches so a cold burst doesn't hammer the token endpoint. */
let inFlightToken: Promise<CachedToken> | null = null;

function readConfig(): SalesforceConfig {
  const loginUrl = process.env.SF_LOGIN_URL;
  const clientId = process.env.SF_CLIENT_ID;
  const clientSecret = process.env.SF_CLIENT_SECRET;

  const missing = [
    ["SF_LOGIN_URL", loginUrl],
    ["SF_CLIENT_ID", clientId],
    ["SF_CLIENT_SECRET", clientSecret],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new SalesforceError(
      `Missing Salesforce env vars: ${missing.join(", ")}. Set them in the environment (see .env.example).`,
      500,
    );
  }

  // SF_LOGIN_URL must be the org's My Domain URL, not login.salesforce.com.
  return {
    loginUrl: loginUrl!.replace(/\/+$/, ""),
    clientId: clientId!,
    clientSecret: clientSecret!,
  };
}

async function fetchToken(): Promise<CachedToken> {
  const { loginUrl, clientId, clientSecret } = readConfig();

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  let res: Response;
  try {
    res = await fetch(`${loginUrl}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    });
  } catch (err) {
    throw new SalesforceError(
      `Network error reaching Salesforce token endpoint: ${(err as Error).message}`,
      502,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    throw new SalesforceError(
      `Salesforce token request failed (${res.status} ${res.statusText}). Check SF_LOGIN_URL / client credentials and that the Client Credentials flow + Run As user are enabled on the ECA.`,
      res.status,
      excerpt(text),
    );
  }

  let json: {
    access_token?: string;
    instance_url?: string;
    expires_in?: number;
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new SalesforceError("Salesforce token response was not valid JSON.", 502, excerpt(text));
  }

  if (!json.access_token || !json.instance_url) {
    throw new SalesforceError(
      "Salesforce token response missing access_token or instance_url.",
      502,
      excerpt(text),
    );
  }

  // Client Credentials tokens often omit expires_in. Default to a conservative
  // 30 min TTL; a 401 mid-flight still triggers a refresh-and-retry below.
  const ttlSeconds = typeof json.expires_in === "number" ? json.expires_in : 30 * 60;

  return {
    accessToken: json.access_token,
    instanceUrl: json.instance_url.replace(/\/+$/, ""),
    // Refresh 60s early to avoid racing expiry.
    expiresAt: Date.now() + Math.max(ttlSeconds - 60, 60) * 1000,
  };
}

async function getToken(forceRefresh = false): Promise<CachedToken> {
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken;
  }
  if (forceRefresh) {
    cachedToken = null;
    inFlightToken = null;
  }
  if (!inFlightToken) {
    inFlightToken = fetchToken()
      .then((tok) => {
        cachedToken = tok;
        return tok;
      })
      .finally(() => {
        inFlightToken = null;
      });
  }
  return inFlightToken;
}

/** Trim a response body to a model-friendly excerpt. */
function excerpt(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Authenticated REST call against Salesforce. `path` is relative to the instance
 * URL, e.g. `/services/data/v66.0/sobjects/Product2`. Refreshes the token once
 * on a 401.
 *
 * By default the response body is JSON-parsed (or `null` if empty). Pass
 * `{ rawResponse: true }` for endpoints that return CSV instead of JSON (e.g.
 * Bulk API's failedResults/successfulResults) — the raw text is returned
 * as-is, with no parse attempt.
 */
export async function sfFetch(path: string, init?: RequestInit): Promise<unknown>;
export async function sfFetch(
  path: string,
  init: RequestInit,
  opts: { rawResponse: true },
): Promise<string>;
export async function sfFetch(
  path: string,
  init: RequestInit = {},
  opts: { rawResponse?: boolean } = {},
): Promise<unknown> {
  const doFetch = async (token: CachedToken): Promise<Response> => {
    try {
      return await fetch(`${token.instanceUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
        cache: "no-store",
      });
    } catch (err) {
      throw new SalesforceError(
        `Network error calling Salesforce REST API: ${(err as Error).message}`,
        502,
      );
    }
  };

  let token = await getToken();
  let res = await doFetch(token);

  if (res.status === 401) {
    // Token may have been revoked/expired server-side; refresh once and retry.
    token = await getToken(true);
    res = await doFetch(token);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new SalesforceError(
      `Salesforce REST call failed (${res.status} ${res.statusText}) for ${path}.`,
      res.status,
      excerpt(text),
    );
  }

  if (opts.rawResponse) return text;

  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new SalesforceError("Salesforce REST response was not valid JSON.", 502, excerpt(text));
  }
}
