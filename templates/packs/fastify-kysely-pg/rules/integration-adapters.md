# Integration Adapter Conventions

Applies to any adapter bridging a domain-level abstraction (container
providers, notification channels, billing providers…) to an **external
HTTP provider** through the Integrations executor
(`packages/backend/src/domains/integrations/integration-executor.ts`).
Pattern introduced in #395; every rule below shipped as a Copilot finding
at least once on the container PR (#485 r1–3).

## The rule in one sentence

**External adapters are pure shape-normalization shims on top of
`integrationsService.execute()`.** They translate domain calls
(`listItems`, `resolveItem`, …) into the executor's typed-operation
contract and normalize responses. They do NOT do their own HTTP, timeouts,
retries, credential handling, or error mapping.

## Input routing — the single most-broken assumption

The executor routes inputs from `input.body` ONLY when the operation has a
typed `inputSchema.properties[].in` declaration; with a typed schema
present, `input.queryParams` is **ignored** (see `routeInputs`). An
adapter passing `{ q: '...' }` via `queryParams` on a typed op sends no
query string and the path placeholder never substitutes.

```ts
async function executeProviderOp(
  tenantId: string,
  connectionApiName: string,
  operationApiName: string,
  input: Record<string, unknown> = {},
): Promise<{ body: unknown }> {
  // EVERY path / query / body / header field goes into `body`; the
  // executor's routeInputs() distributes them per inputSchema.properties[].in.
  // Never split fields across body vs queryParams — queryParams is
  // legacy-only and silently ignored for typed ops.
  const payload = Object.keys(input).length > 0 ? input : undefined;
  return integrationsService.execute(
    tenantId,
    { connectionApiName, channelType: 'rest', operationApiName, body: payload },
    '<domain>_provider',
  );
}
```

Call sites pass ALL fields in one object, **including path-template
placeholders**:

```ts
// Template: path '/files/{fileId}' with inputSchema { fileId: { in: 'path' }, fields: { in: 'query' } }
await executeProviderOp(tenantId, conn, 'resolveItem', {
  fileId,                                 // substitutes {fileId}
  fields: 'webViewLink,thumbnailLink',    // becomes ?fields=...
});
```

Forgetting the path-placeholder field is a silent 404 in production — the
URL ships with `{fileId}` unsubstituted.

## What adapters MUST NOT do

1. **Bespoke timeouts** (`Promise.race` + `setTimeout`) — the executor
   enforces per-request timeouts, circuit-breaker fast-fail (503 in ms
   when a connection's breaker is open), and rate-limit handling; a
   user-space timer cannot cancel the underlying call and masks executor
   errors.
2. **Direct `fetch`** to the provider — loses audit log, circuit breaker,
   SSRF validation, OAuth refresh, and rate limiting.
3. **Retries / backoff** — rate-limit retries belong in the executor.
4. **Credential fetching or token refresh** — the executor resolves
   credentials from `integration_tokens`; `token-refresh.processor.ts`
   refreshes OAuth proactively.
5. **Registering an operation the executor cannot send.** `bodyEncoding`
   supports `json | form | graphql | multipart | binary` (multipart:
   Drive `attachItem`, #484/#510; binary: SharePoint `attachItem`,
   #511/#512). Only genuinely unsupported flows remain — e.g.
   resumable/chunked multi-request upload sessions (Graph's
   `createUploadSession`), which can't fit one request/response cycle. For
   those, do NOT add the op to `defaultOperations`; ship a typed
   `*_UNSUPPORTED` error from the adapter handler instead.
6. **Using a provider apiName as the `ctx.integration()` argument** — it
   takes a **connection** apiName, not a provider key:

   ```ts
   // WRONG — 'drive' is a provider apiName, not a connection
   ctx.integration('drive').execute(...);

   // CORRECT — 'myDriveConnection' is a connection apiName configured in /admin/integrations
   ctx.integration('myDriveConnection').execute('listItems', { fileId, fields: '...' });
   ```

   The returned client also exposes `rest.get/post/put/patch/delete(path,
   opts)` for ad-hoc calls when a named operation doesn't exist.

## Capability flags (add when the first check needs them)

When adapters in a domain start advertising capability differences, add a
`capabilities` object so callers/UI can hide unsupported affordances
instead of hitting a runtime error:

```ts
capabilities: {
  supportsBinaryUpload: false,  // false for adapters that don't upload bytes at all
  supportsVersions: true,       // false if provider has versioning disabled at the library level
  // add flags per domain — optional until a consumer actually branches on them
},
```

Skip the map for v1 of a new adapter surface if no UI or service code
branches on it; add it as part of the first PR that introduces a branch —
premature inclusion ships dead fields that drift (container v1 shipped
without it; v1.1, which added `listVersions` + multipart upload,
introduced it).

## Native / local adapters are the exception

An adapter talking to a local store (MinIO SDK, local filesystem,
in-memory cache) does NOT route through the Integrations executor — it
uses the store's own SDK, gets its timeouts from the SDK, and does NOT
inherit executor features (circuit breaker, audit log, rate limit, OAuth).
Document this contrast plainly in the adapter's JSDoc so reviewers don't
expect executor-level behaviors. The native MinIO container adapter is the
reference example.

## Provider template rules (adding a provider to `PROVIDER_TEMPLATES` in `packages/shared/src/constants/integrations.ts`)

- **`baseUrl`** goes on the provider, NOT the channel.
- **Path templates** carry only placeholders (`{fileId}`,
  `{siteId}/{driveId}`) — never inline query strings
  (`/files?fields=...`); that breaks input routing.
- **Every input** declares `in: 'path' | 'query' | 'body' | 'header'`;
  path placeholders MUST match a property with `in: 'path'`; missing `in`
  defaults to `'body'`.
- **`outputPath`** extracts the useful array/object from the response
  envelope (`'files'` Drive, `'value'` Graph, `'data'` Stripe).
- Do NOT register ops whose `bodyEncoding` the executor doesn't support —
  the adapter throws an explicit `*_UNSUPPORTED` error with code-level
  rationale instead (rule 5 above).

## Precedents

- Google Drive — `packages/backend/src/domains/containers/providers/google-drive-provider.ts`
- SharePoint — `.../sharepoint-provider.ts`
- Native MinIO (local, NOT through executor) — `.../native-provider.ts`
- Template definitions — `packages/shared/src/constants/integrations.ts`
  (search `apiName: 'google_drive'`)
- Container-PR fixes: PR #485 r1–3
