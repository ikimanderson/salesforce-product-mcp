# IKI Salesforce Product MCP Server

A private remote [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
server that lets Claude **create and update Salesforce `Product2` records**
via the REST API. Deployed on Vercel. **Write-only, scoped to `Product2`** —
it does not expose SOQL or any other object. That's intentional: it's a
sibling to a separate read-only server (`soql_query`, `account_intel`), kept
apart so the token that can mutate CRM data is distinct from — and smaller in
blast radius than — the one that only reads it.

- **Endpoint:** `https://<project>.vercel.app/api/mcp` (Streamable HTTP)
- **Tools:** `create_product2`, `update_product2`
- **Transport:** Streamable HTTP only (no SSE, no Redis)
- **Runtime:** Node.js (not Edge)

## Why this shape

Salesforce here is **Professional Edition + the paid API add-on**. Salesforce's
hosted MCP servers require Enterprise+, and the local DX MCP server isn't the
target, so this server calls the **Salesforce REST API directly** (`v66.0`).
Auth to Salesforce uses an **External Client App (ECA) with the Client
Credentials flow** — new Connected Apps are blocked as of Spring '26.

## Architecture — two auth layers

1. **Claude → this server:** a shared bearer token (`MCP_BEARER_TOKEN`). This
   token can write CRM data, so treat it as more sensitive than a read-only
   token and use a **different** one than any sibling read-only server.
   Requests without a valid token get a `401` (never a `500`).
2. **This server → Salesforce:** the OAuth 2.0 Client Credentials flow. The
   server POSTs to `${SF_LOGIN_URL}/services/oauth2/token`, caches the returned
   `access_token` + `instance_url` at module scope, and reuses that token across
   warm invocations to stay within the Professional Edition API quota. A `401`
   mid-flight triggers a single refresh-and-retry.

## Tools

Both tools share two guards:

1. **Field-name sanitization** (`lib/product2.ts`) — every key in `fields`
   must match a plain Salesforce API-name pattern (leading letter,
   alphanumerics/underscores, optional `__c` custom-field suffix). `Id`,
   `attributes`, and relationship paths (e.g. `Owner.Name`) are rejected
   outright, so a write can only ever set flat scalar fields on the target
   record — never traverse into a related object or override the identity
   fields Salesforce manages itself.
2. **Confirm-before-write** — without `confirm: true`, both tools return a
   dry-run preview (`{ dryRun: true, action, fields, ... }`) showing exactly
   what would be sent, **without calling Salesforce**. Only `confirm: true`
   performs the actual `POST`/`PATCH`.

### `create_product2(fields, confirm?)`
Creates a `Product2` record. `fields` must include a non-empty `Name`
(Salesforce rejects a `Product2` insert without one).

### `update_product2(id, fields, confirm?)`
Updates an existing `Product2` record by Id.

> ⚠️ **Before using either tool**, the ECA's Client Credentials "Run As" user
> needs Create + Edit object permissions on `Product2` (and field-level
> security on any custom fields you intend to write) — set this via a
> Permission Set assigned to that user in Salesforce Setup. Object-level CRUD
> is normally gated by the Run As user's permissions rather than the ECA's
> OAuth scope list, but **verify this against Salesforce Setup / current
> Salesforce docs for your org's edition** before relying on it — this is an
> area that shifts across Salesforce releases.

## Environment variables

See [`.env.example`](./.env.example). Copy it to `.env.local` for local dev;
never commit real secrets.

| Variable            | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `SF_LOGIN_URL`      | Org **My Domain** URL (not `login.salesforce.com`)             |
| `SF_CLIENT_ID`      | ECA Consumer Key                                               |
| `SF_CLIENT_SECRET`  | ECA Consumer Secret                                            |
| `MCP_BEARER_TOKEN`  | Shared bearer token for Claude → server (`openssl rand -hex 32`) |

## Local development

```bash
npm install
cp .env.example .env.local   # fill in values
npm run dev                  # http://localhost:3000, endpoint /api/mcp
```

### Verify the build (no live credentials needed)

```bash
npm run typecheck   # tsc --noEmit
npm run build       # next build
npm test            # vitest — mocks the SF token + REST responses
```

### Prove the auth gate

With the server running (`npm run dev` or `npm run start`):

```bash
MCP_BEARER_TOKEN=<your-token> npm run check-auth
# or against a deployment:
MCP_BEARER_TOKEN=<your-token> node scripts/check-auth.mjs https://<project>.vercel.app
```

Expected: the request **without** a token returns `401`; the request **with**
the correct token is accepted.

### Inspect with the MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Point it at `http://localhost:3000/api/mcp` (Streamable HTTP) with an
`Authorization: Bearer <MCP_BEARER_TOKEN>` header. You should see
`create_product2` and `update_product2` listed. Try a call **without**
`confirm: true` first to see the dry-run preview before writing anything.

## Deployment (Vercel)

This is IKI business use, so it must be deployed to a **Vercel Pro team**, not a
personal/Hobby account (Hobby prohibits commercial use).

```bash
vercel link                          # link to the Pro team/project
vercel env add SF_LOGIN_URL          # repeat for each variable, all environments
vercel env add SF_CLIENT_ID
vercel env add SF_CLIENT_SECRET
vercel env add MCP_BEARER_TOKEN
vercel                               # preview deploy — verify /api/mcp
vercel --prod                        # promote to production
```

- **Fluid compute** keeps functions warm, which helps the module-scoped
  Salesforce token cache survive between requests. Enable it in
  Project → Settings → Functions.
- The URL registered as the Claude connector **must be the stable production
  domain** (`https://<project>.vercel.app/api/mcp` or a custom domain). Preview
  URLs change on every deploy and would silently break the connector.

## Connecting from Claude

Add a custom connector pointing at the production `/api/mcp` URL, with the
bearer token as the authorization credential. (Exact steps depend on the
Claude client.) Use a bearer token distinct from the read-only sibling
server's, so the two can be rotated/revoked independently.

## Operational notes

Professional Edition's API add-on has a modest **daily API call quota**. This
server makes only 1–2 REST calls per write and reuses its cached token rather
than re-authenticating each request. Watch usage at:

> Salesforce **Setup → Company Information → API Requests, Last 24 Hours**

## Notes on dependencies

- `@modelcontextprotocol/sdk` is pinned to **1.26.0** (mcp-handler's peer;
  ≥ 1.26.0 is required — earlier versions have a security vulnerability).

## Project layout

```
app/
  layout.tsx
  page.tsx
  api/[transport]/route.ts   # MCP handler: bearer auth + create_product2 + update_product2
lib/
  salesforce.ts              # Client Credentials auth, token cache, REST helper (sfFetch)
  product2.ts                # Field-name sanitization + create/update calls
scripts/
  check-auth.mjs             # proves the bearer gate (with/without token)
tests/
  salesforce.test.ts         # mocked token + REST call smoke test
  product2.test.ts           # field sanitization + mocked create/update smoke test
```
