# IKI Salesforce Product MCP Server

A private remote [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
server that lets Claude **create and update Salesforce `Product2` records**
via the REST API. Deployed on Vercel. **Write-only, scoped to `Product2`** —
it does not expose SOQL or any other object. That's intentional: it's a
sibling to a separate read-only server (`soql_query`, `account_intel`), kept
apart so the token that can mutate CRM data is distinct from — and smaller in
blast radius than — the one that only reads it.

- **Endpoint:** `https://salesforce-product-mcp.vercel.app/api/mcp` (Streamable HTTP)
- **Tools:** `create_product2`, `update_product2`, `start_bulk_product2_job`, `get_bulk_product2_job_status`
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

## Bulk import (Bulk API 2.0)

`create_product2`/`update_product2` write one record per REST call — fine for
ad-hoc edits, but not for a multi-thousand-row CSV import (the kind
previously done via dataloader.io). `start_bulk_product2_job` and
`get_bulk_product2_job_status` add that via Salesforce's
[Bulk API 2.0](https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/),
which handles orders of magnitude more data far more efficiently than looping
single-record calls (and without burning through the Professional Edition API
add-on's daily quota).

**The actual CSV bytes never pass through an MCP tool call.** A real import
file (several thousand rows) is roughly 200k+ tokens of raw text — far too
much to embed in a tool-call argument: slow, expensive, and it risks
transcription errors as an LLM copies that much data through its own
context. Instead:

1. Call `start_bulk_product2_job` with `operation` (`insert`/`update`/
   `upsert`), the total `rowCount`, and a **small sample** (1-10 rows) of the
   real data for validation. Without `confirm: true`, this only validates
   the sample and returns a preview — no Salesforce call is made.
2. With `confirm: true`, it opens a real Bulk API job and returns a relative
   `uploadPath` (e.g. `/api/bulk/{jobId}/data`).
3. **From a shell-capable session** (Claude Code or similar — not the
   Desktop/claude.ai chat connector, which has no way to stream a local file
   outside the tool-call schema), stream the **entire** CSV file to that path
   in **one request**:
   ```bash
   curl --data-binary @file.csv \
     -H "Authorization: Bearer <MCP_BEARER_TOKEN>" \
     -X PUT "https://salesforce-product-mcp.vercel.app/api/bulk/<jobId>/data"
   ```
   This closes the job and starts Salesforce processing it. The row data
   never enters the calling model's context — `curl` reads it straight off
   disk.
4. Poll `get_bulk_product2_job_status` (an MCP tool call — cheap, small
   response) until `state` is `JobComplete`. If any rows failed, the result
   includes a **capped** summary (default: first 25 failures + a total
   count) — never a full multi-thousand-row result dump.

**No chunking — one PUT per job, verified against a real org.** An earlier
version of this doc (and the route) assumed Salesforce's Bulk API 2.0 would
accept multiple sequential `PUT` calls to build up a job's data before
closing it. Live testing proved that wrong: a second `PUT .../batches` call
on the same job is rejected outright ("Found multiple contents for job").
**The entire CSV must go in a single request.** The real, unavoidable
ceiling is Vercel's Node.js serverless request-body limit (~4.5 MB, not
tunable from Next.js config — that only applies to the legacy Pages API), so
a file needs to fit under roughly 4.4 MB to be safe. For context: a typical
Product2 row (a handful of fields) is well under 1 KB, so even a 6,500-row
file is normally a few hundred KB — comfortably under that ceiling. A file
that genuinely exceeds it would need to be split across **multiple separate
Bulk API jobs** (each with its own single PUT) — not built here, since it
wasn't needed for what this server was built for.

**Row cap:** `start_bulk_product2_job` rejects a declared `rowCount` above
`MAX_ROW_COUNT` (50,000, in `lib/bulkProduct2.ts`). This is a self-imposed
mistake-guard against pointing at the wrong file — **not** a Salesforce
limit; Bulk API 2.0 itself handles far more than that.

**Operation-specific row rules** (validated against the sample you pass to
`start_bulk_product2_job`, and enforced by Salesforce on the real file):
- `insert` — rows must NOT include an `Id` column.
- `update` — every row MUST include an `Id` column (the record to update).
- `upsert` — every row MUST include the `externalIdFieldName` column, and
  must NOT include `Id`.

> ⚠️ **Upsert requires Salesforce-side setup that isn't done automatically**:
> the field you pass as `externalIdFieldName` (e.g. `ProductCode`) must
> already have the **External ID** checkbox enabled in Salesforce Object
> Manager → Product2 → Fields & Relationships. It is **not** on by default
> for standard fields like `ProductCode` — a job created with an
> unqualified field will fail Salesforce-side.

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
# or against the live deployment:
MCP_BEARER_TOKEN=<your-token> node scripts/check-auth.mjs https://salesforce-product-mcp.vercel.app
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

Settings → Connectors → **Add custom connector**. Name it something that
signals its blast radius — e.g. "Salesforce Product Write (USE CAUTION!)" —
since it's easy to lose track of which connector can write CRM data once
you have several. Use a bearer token distinct from the read-only sibling
server's, so the two can be rotated/revoked independently.

The dialog's auth options vary by rollout:

- **If there's a "Request headers" field** (beta, gradually rolled out):
  set header `Authorization` to `Bearer <MCP_BEARER_TOKEN>` (space after
  `Bearer`), and use the plain endpoint URL.
- **If the dialog only shows OAuth Client ID/Secret** (no headers field —
  the common case as of this writing): leave those blank and instead bake
  the token into the URL itself, using the server's built-in `?token=`
  fallback:
  ```
  https://salesforce-product-mcp.vercel.app/api/mcp?token=<MCP_BEARER_TOKEN>
  ```
  This isn't a workaround bolted onto the docs — `extractToken()` in
  `route.ts` accepts the token via either the `Authorization` header or a
  `?token=`/`?key=` query param specifically because claude.ai's connector
  dialog has historically had no bearer-token field for servers without an
  OAuth authorization server.

Under **Connection methods**, leave **Individual sign-in** on and skip
**Managed authorization**. Managed authorization connects your whole
workspace through your identity provider with no per-member opt-in — the
opposite of what you want for a connector that can write to Product2. It
also targets OAuth/SSO connectors; this server doesn't do OAuth, so it
isn't a fit here regardless.

Once connected, run a dry-run call first (omit `confirm`) to confirm the
round trip works before doing a real write.

This connector setup covers `create_product2`/`update_product2` fine, but
**bulk imports (see above) need a shell-capable session**, not this chat
connector — the `curl`-based upload step has no equivalent in a pure
chat interface.

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
  api/
    [transport]/route.ts    # MCP handler: create_product2, update_product2,
                             #   start_bulk_product2_job, get_bulk_product2_job_status
    bulk/[jobId]/data/route.ts  # plain HTTP PUT endpoint for streaming CSV bytes
                                 #   (not an MCP tool) -- one PUT per job, no chunking
lib/
  auth.ts                    # shared bearer-token check, used by both routes above
  salesforce.ts              # Client Credentials auth, token cache, REST helper (sfFetch)
  product2.ts                # Field-name sanitization + single-record create/update
  bulkProduct2.ts             # Bulk API 2.0 client + row/field validation
scripts/
  check-auth.mjs             # proves the bearer gate (with/without token)
tests/
  auth.test.ts               # bearer-token extraction/comparison unit tests
  salesforce.test.ts         # mocked token + REST call smoke test
  product2.test.ts           # field sanitization + mocked create/update smoke test
  bulkProduct2.test.ts        # bulk validation rules + mocked Bulk API client calls
```
