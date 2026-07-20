# Integration Adapter Conventions

Applies to any adapter that bridges a domain-level abstraction (container
providers, notification channels, billing providers, etc.) to an
**external HTTP provider** through the Integrations executor
(`packages/backend/src/domains/integrations/integration-executor.ts`).

Codifies the pattern introduced in #395 (container providers). Reading this
before writing an adapter saves several rounds of Copilot feedback — every
bug this file addresses was shipped at least once in the container PR.

## The rule in one sentence

**External adapters are pure shape-normalization shims on top of
`integrationsService.execute()`.** They translate domain calls (`listItems`,
`resolveItem`, etc.) into the executor's typed-operation contract, and
normalize responses. They do NOT do their own HTTP, timeouts, retries,
credential handling, or error mapping.

## Input routing — the single most-broken assumption

The executor routes inputs from `input.body` ONLY when the operation has
a typed `inputSchema.properties[].in` declaration. When a typed schema is
present, `input.queryParams` is **ignored** (see `routeInputs` in the
executor). So an adapter that passes `{ q: '...' }` via `queryParams` on a
typed op will send a request with no query string and the path placeholder
will never substitute.

**Canonical executor helper:**

```ts
async function executeProviderOp(
  tenantId: string,
  connectionApiName: string,
  operationApiName: string,
  input: Record<string, unknown> = {},
): Promise<{ body: unknown }> {
  // EVERY path / query / body / header field goes into `body`. The
  // executor's routeInputs() distributes them per the template's
  // inputSchema.properties[].in declarations. Never split fields across
  // body vs queryParams — queryParams is legacy-only and silently ignored
  // for typed ops.
  const payload = Object.keys(input).length > 0 ? input : undefined;
  return integrationsService.execute(
    tenantId,
    {
      connectionApiName,
      channelType: 'rest',
      operationApiName,
      body: payload,
    },
    '<domain>_provider',
  );
}
```

**Call sites pass ALL fields in one object**, including path-template
placeholders:

```ts
// Operation template: path '/files/{fileId}' with inputSchema { fileId: { in: 'path' }, fields: { in: 'query' } }
await executeProviderOp(tenantId, conn, 'resolveItem', {
  fileId,                                 // substitutes {fileId} in the path
  fields: 'webViewLink,thumbnailLink',    // becomes the ?fields=... query param
});
```

Forgetting the path-placeholder field is a silent 404 in production — the
URL ships with `{fileId}` unsubstituted.

## What adapters MUST NOT do

1. **Bespoke timeouts** (`Promise.race` + `setTimeout`). The executor enforces
   per-request timeouts, circuit-breaker fast-fail (503 in ms when a
   connection's breaker is open), and rate-limit handling. A user-space
   timer adds nothing and cannot cancel the underlying call — a slow
   provider keeps consuming resources after the request has returned.
2. **Direct `fetch`** to the provider. You lose audit log, circuit breaker,
   SSRF validation, OAuth refresh, and rate limiting — every one of those
   is a cross-cutting correctness or compliance concern.
3. **Retries / backoff**. Rate-limit retries belong in the executor.
4. **Credential fetching or token refresh**. The executor resolves
   credentials from `integration_tokens` and refreshes OAuth tokens
   proactively via `token-refresh.processor.ts`.
5. **Registering an operation the executor cannot send.** `bodyEncoding`
   supports `json | form | graphql | multipart | binary` (multipart shipped
   in #484/#510 for Drive `attachItem`; binary shipped in #511/#512 for
   SharePoint `attachItem`). The rule now only applies to genuinely
   unsupported encodings — e.g. resumable/chunked multi-request upload
   sessions (Graph's `createUploadSession`), which the executor cannot
   orchestrate in a single request/response cycle. For those, do NOT add
   the op to `defaultOperations` — it will fail at runtime. Ship a typed
   `*_UNSUPPORTED` error from the adapter's handler instead.

## Capability flags (add when the first check needs them)

When adapters in a domain start advertising capability differences (e.g.
an op can't run until a cross-cutting executor feature lands, or a
provider-level setting toggles support), add a `capabilities` object to
the adapter interface so callers / UI can hide unsupported affordances
instead of triggering a runtime error:

```ts
capabilities: {
  supportsBinaryUpload: false,      // false for adapters that don't upload bytes at all (e.g. native's bytes flow through a different route)
  supportsVersions: true,           // false if provider has versioning disabled at the library level
  // add flags per domain — optional until a consumer actually branches on them
},
```

**When to add, when to skip** — for v1 of a new adapter surface, skip
the capabilities map if no UI or service code branches on it (every
provider at that point is either uniformly supported or rejects the op
with a typed `*_UNSUPPORTED` error). Add it as part of the first PR
that introduces a branch. Premature inclusion ships dead fields that
drift out of sync with reality. Container v1 shipped without the field
for this reason; v1.1 (which adds `listVersions` and multipart upload)
is the PR that introduces it.

## Native / local adapters are the exception

An adapter that talks to a local store (MinIO SDK, local filesystem,
in-memory cache) does NOT route through the Integrations executor — it
uses the store's own SDK. Those adapters get their own timeouts from the
SDK and do NOT inherit executor features (circuit breaker, audit log,
rate limit, OAuth).

Document this contrast plainly in the adapter's JSDoc so reviewers don't
expect executor-level behaviors. The native MinIO container adapter is
the reference example.

## Script API reference

`ctx.integration()` from tenant scripts takes a **connection apiName**
(not a provider key):

```ts
// WRONG — 'drive' is a provider apiName, not a connection
ctx.integration('drive').execute(...);

// CORRECT — 'myDriveConnection' is a connection apiName configured in /admin/integrations
ctx.integration('myDriveConnection').execute('listItems', { fileId, fields: '...' });
```

The returned client also exposes `rest.get/post/put/patch/delete(path, opts)`
for ad-hoc calls when a named operation doesn't exist.

## Provider template rules (when adding a new provider)

When adding a provider to `packages/shared/src/constants/integrations.ts`
`PROVIDER_TEMPLATES`:

- **`baseUrl`** goes on the provider, NOT on the channel.
- **Path templates** carry only placeholders (`{fileId}`, `{siteId}/{driveId}`).
  Do NOT inline query strings (`/files?fields=...`) — that breaks input
  routing.
- **Every input** declares `in: 'path' | 'query' | 'body' | 'header'` in
  `inputSchema.properties`. Path placeholders MUST match a property with
  `in: 'path'`. Missing `in` defaults to `'body'`.
- **`outputPath`** extracts the useful array/object from the response
  envelope (`'files'` for Drive, `'value'` for Graph, `'data'` for Stripe).
- Do NOT register ops for operations whose `bodyEncoding` the executor
  doesn't support — the op will fail at runtime. Have the adapter throw
  an explicit `*_UNSUPPORTED` error with code-level rationale.

## Common missteps to avoid

1. **Passing inputs via `queryParams`**. Does not work for typed ops. Put
   everything in `body`.
2. **Forgetting the path-placeholder field in the call-site input**. Silent
   404 — the URL ships with `{fileId}` literal.
3. **Wrapping executor calls in `Promise.race` + timeout**. Duplicates work,
   cannot cancel, masks executor errors.
4. **Assuming every adapter goes through the executor**. Native adapters
   don't — document the exception.
5. **Registering an op the executor genuinely can't send** (resumable/
   chunked multi-request upload sessions — `json | form | graphql |
   multipart | binary` are all supported). Ship a typed `*_UNSUPPORTED`
   error from the adapter and omit the op from the template.
6. **Using provider apiName as the `ctx.integration()` argument**. Takes
   connection apiName.

## Precedents

- Google Drive provider — `packages/backend/src/domains/containers/providers/google-drive-provider.ts`
- SharePoint provider — `.../sharepoint-provider.ts`
- Native MinIO provider (local, NOT through executor) — `.../native-provider.ts`
- Drive/SP template definitions — `packages/shared/src/constants/integrations.ts` (search `apiName: 'google_drive'`)
- Fixes from the container PR: PR #485 rounds 1–3
