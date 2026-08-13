#!/usr/bin/env node
/**
 * Proves the bearer-token gate on the MCP endpoint works:
 *   1. a request WITHOUT the bearer token must be rejected (401/403), and
 *   2. a request WITH the correct bearer token must NOT be rejected as auth.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 MCP_BEARER_TOKEN=xxxx node scripts/check-auth.mjs
 *   node scripts/check-auth.mjs https://<project>.vercel.app
 *
 * Defaults: BASE_URL=http://localhost:3000. Run `npm run dev` first for local.
 */

const baseUrl = (process.argv[2] || process.env.BASE_URL || "http://localhost:3000").replace(
  /\/+$/,
  "",
);
const endpoint = `${baseUrl}/api/mcp`;
const token = process.env.MCP_BEARER_TOKEN;

// A minimal MCP JSON-RPC "initialize" request body.
const initBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "check-auth", version: "0.0.0" },
  },
});

const baseHeaders = {
  "Content-Type": "application/json",
  // Streamable HTTP clients must accept both JSON and SSE.
  Accept: "application/json, text/event-stream",
};

async function hit(label, headers) {
  try {
    const res = await fetch(endpoint, { method: "POST", headers, body: initBody });
    console.log(`[${label}] ${res.status} ${res.statusText}`);
    return res.status;
  } catch (err) {
    console.error(`[${label}] request failed: ${err.message}`);
    return null;
  }
}

console.log(`Target: ${endpoint}\n`);

const noAuthStatus = await hit("no token ", baseHeaders);

let withAuthStatus = null;
if (token) {
  withAuthStatus = await hit("with token", { ...baseHeaders, Authorization: `Bearer ${token}` });
} else {
  console.log("[with token] skipped — set MCP_BEARER_TOKEN to test the authorized path.");
}

console.log("\nResult:");
const rejected = noAuthStatus === 401 || noAuthStatus === 403;
console.log(
  rejected
    ? `  ✓ unauthenticated request rejected (${noAuthStatus})`
    : `  ✗ expected 401/403 without a token, got ${noAuthStatus}`,
);

if (withAuthStatus !== null) {
  const authedOk = withAuthStatus !== 401 && withAuthStatus !== 403;
  console.log(
    authedOk
      ? `  ✓ authenticated request accepted (${withAuthStatus})`
      : `  ✗ authenticated request was rejected (${withAuthStatus}) — check MCP_BEARER_TOKEN`,
  );
}

// Exit non-zero if the core guarantee (reject-without-token) fails.
process.exit(rejected ? 0 : 1);
