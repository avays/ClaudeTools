---
globs:
  - "packages/backend/**"
---

# Backend Conventions

## Language & Module System
- TypeScript strict mode, ESM imports with `.js` extensions
- Named exports only (no default exports)
- Use `import type` for type-only imports

## Domain Module Pattern
Every domain lives in `packages/backend/src/domains/{name}/` with these files:
- `{name}.routes.ts` — Route handlers: parse input, call service, return response. Keep thin.
- `{name}.service.ts` — All business logic lives here. Only layer that orchestrates.
- `{name}.repository.ts` — All DB access via `withTenant(tenantId)`. Never use raw `db` in services.
- `{name}.schema.ts` — Zod schemas for request validation (re-exports from @orm/shared when possible).
- `{name}.events.ts` — Event type definitions and emissions.

Domains that manage primitive types (flow steps, field types, layout components, etc.) also include:
- `{name}/registry.ts` — Singleton registry class (`register`, `get`, `listMetadata`, `_clearForTests`)
- `{name}/definitions/index.ts` — Builtin definition array (`builtin{Name}Definitions`)
- `{name}/registry.test.ts` — Architecture tests enforcing required fields, no duplicates, no `execute` leaks

See `.claude/rules/registry.md` for the full registry pattern.

## Error Handling
- Throw `PlatformError` subclasses: `ValidationError`, `NotFoundError`, `ConflictError`, `PlatformError`
- Never throw raw `Error` — the error handler middleware maps PlatformError to response envelopes
- Import from `../../core/errors.js`
- Upstream data (registry, OAuth, integration, webhook payloads) that fails schema
  validation is 502, not 400. Use `safeParse` + `PlatformError('UPSTREAM_X_INVALID',
  ..., 502)`. See `.claude/rules/backend-api.md` "Upstream Data".

### Error code registry (#537)

Every `PlatformError` code MUST be registered in
`packages/shared/src/constants/error-codes.ts`. Use `ERROR_CODES.YOUR_CODE`
at the call site (preferred) or a bare string literal that exists as a
value in the registry — both are accepted. The architecture test
`error-codes-registry.test.ts` scans every `new PlatformError('CODE', ...)`
site and rejects unregistered literals.

```ts
import { ERROR_CODES } from '@orm/shared';

throw new PlatformError(
  ERROR_CODES.PROFILE_IN_USE,
  `Cannot delete — ${result.userCount} user(s) are assigned.`,
  409,
);
```

Adding a new code: edit `error-codes.ts`, then `pnpm --filter @orm/shared
build`, then use `ERROR_CODES.YOUR_NEW_CODE`. The frontend's
`useApiErrorToast` is typed against the same registry — keys in the toast
map MUST be registered codes (enforced by `error-toast-registry.test.ts`).

**Single-vs-wrapper code pattern (#695)** — when a service-layer validator
returns N independent failures (e.g. `validateLookupTargets` from
`_lookup-validator.ts`), the caller in `data.service.ts` throws as
follows. When **exactly one** failure exists, throw `PlatformError(only.code,
only.message, 400, [{field, code, message}])` so the top-level `error.code`
is the specific failure (e.g. `LOOKUP_TARGET_NOT_FOUND`,
`LOOKUP_TARGET_OBJECT_MISMATCH`, `POLYMORPHIC_TARGET_NOT_ALLOWED`,
`LOOKUP_FILTER_MISMATCH`) and `useApiErrorToast` picks it up via the typed
code map. When **two or more** failures exist, throw `PlatformError(ERROR_CODES.
LOOKUP_VALIDATION_FAILED, ..., 400, details[])` where each `details[]` entry
carries its own typed `code`. The frontend iterates `details[].code` for
per-field copy in the multi-field case. `ApiErrorDetail` is widened with an
optional `code?: string` for this reason — every typed-per-field error
should populate it.

### Permissions registry (#537)

Every system permission referenced in `requireSystemPermission(...)` or
`'x-requires-permission': [...]` arrays MUST use `PERMISSIONS.X` from
`@orm/shared`. The architecture test `permissions-registry.test.ts`
rejects bare camelCase string literals.

```ts
import { PERMISSIONS } from '@orm/shared';

preHandler: [requireAuth, requireSystemPermission(PERMISSIONS.MANAGE_USERS)],
// or
schema: { 'x-requires-permission': [PERMISSIONS.MANAGE_USERS] },
```

Adding a new permission: edit
`packages/shared/src/constants/permissions.ts`, rebuild shared, then use
`PERMISSIONS.YOUR_NEW_PERM`.

### Custom Error subclasses — never `readonly`-override a mutable base property

TypeScript checks override compatibility structurally. `Error.cause` (and
similarly `Error.message` / `Error.name`) is declared as a **mutable**
property on `lib.d.ts`'s `Error` interface. A subclass that re-declares it
as `readonly` is not assignable to the mutable base property — this risks
a typecheck failure (or a puzzling structural-typing error) depending on how
the class is consumed downstream.

```ts
// WRONG — readonly override of a mutable base property risks a typecheck failure
export class EmbeddingProviderError extends Error {
  override readonly cause?: unknown;
}

// RIGHT — keep it mutable; document the "never mutated after construction"
// invariant as a comment, not an enforced `readonly`
export class EmbeddingProviderError extends Error {
  /** Set once in the constructor; treated as immutable by convention, not enforced. */
  override cause?: unknown;
}
```

Applies to any custom `Error` subclass in this codebase (`PlatformError` and
its variants, provider-specific error classes like `EmbeddingProviderError`).
Precedent: PR #1156 (issue #1100) round 3 — `EmbeddingProviderError.cause`
shipped `readonly` and was caught by Copilot before merge.

## Provenance columns — set at INSERT, never post-update

Columns that record *how* a row came to exist (`source`, `origin`,
`created_via`, `installed_by`, `imported_from`, …) MUST be passed to
`repository.create()` as a parameter, not patched via a separate
`updateSource()` / `updateOrigin()` call after create. A post-update loses the
provenance on any failure path between create and update — the row gets the
column's DB default (typically `'manual'` or `'unknown'`) and the audit trail
is wrong.

- `repository.create({ ..., source })` — thread the value in.
- `service.doThing(..., source?: 'manual' | 'registry' = 'manual')` — accept
  it as a backend-only parameter with a sensible default, pass through to
  `create()`.
- Never `service.install(...); await repository.updateSource(...)`.

Precedent: `installed_packages.source` threaded through
`marketplaceService.install()` (#299) — PR #488 initially planned a
post-update and had to be reworked because the row survives with `status='failed'`
but `source='manual'` on deploy failure.

## Service module patterns — avoid `this.method()`

Services are exported as object literals (`export const fooService = { ... }`).
When one method on a service calls another, reference the **module-level
binding** (`fooService.method()`), not `this.method()`. Object-literal methods
lose their `this` binding when destructured or passed as a callback, and the
two usages are indistinguishable at the call site — the one that fails is
whichever one gets destructured first.

```ts
// WRONG — breaks if any caller does `const { installFromRegistry } = marketplaceService`
export const marketplaceService = {
  async installFromRegistry(...) {
    return this.install(...);
  },
  async install(...) { /* ... */ },
};

// RIGHT — safe under destructure and callback passing
export const marketplaceService = {
  async installFromRegistry(...) {
    return marketplaceService.install(...);
  },
  async install(...) { /* ... */ },
};
```

## Loop-invariant values in fallback/retry loops

When a `for`/`while` loop iterates a fallback ladder (model attempts,
provider retries, step attempts), any newly-added `const` computed inside
the loop body MUST be checked against the loop variable: if it doesn't
actually depend on the per-iteration value (`modelChoice`, `attempt`,
`i`), hoist it above the loop alongside any sibling values already
hoisted for the same reason. A comment on an existing hoisted sibling
that explains "hoisted because it's a pure function of X/Y, which don't
depend on the loop" is a signal to apply the same reasoning to every new
value you add nearby — don't let it get recomputed on every iteration.

```ts
// WRONG — estimatedTokens is a pure function of systemContent/userContent,
// neither of which depends on modelChoice, but it's declared inside the loop
const systemContent = `...`;
const userContent = `...`;   // ← already hoisted for this exact reason
for (const modelChoice of step.models) {
  const estimatedTokens = Math.ceil((systemContent.length + userContent.length) / 4) + 4096;
  const budgetCheck = await tokenBudget.checkBudget(tenantId, userId, estimatedTokens);
  // ...
}

// RIGHT — hoisted alongside its siblings; only the per-attempt call stays in the loop
const systemContent = `...`;
const userContent = `...`;
const estimatedTokens = Math.ceil((systemContent.length + userContent.length) / 4) + 4096;
for (const modelChoice of step.models) {
  const budgetCheck = await tokenBudget.checkBudget(tenantId, userId, estimatedTokens);
  // ...
}
```

Precedent: `_ai-dispatcher.ts`'s `dispatchAi` — `systemContent`/`userContent`
were already hoisted above the model-fallback loop for exactly this
reason; `estimatedTokens` was added in the same loop body without
applying the same check. Caught in the mandatory self-audit loop, not
shipped. PR #1157 round 1.

## Caching
- L1 (LRU in-memory) + L2 (Redis), tenant-prefixed keys
- Check cache in service layer: `cache.get(tenantId, key)` / `cache.set(tenantId, key, value, ttl)`
- Invalidate on mutations — never leave stale cache
- Default TTL: 60 seconds for metadata

## Redis-based dedupe/coordination and system-wide event payloads (#1011)

**A comment describing a Redis `SET ... NX` (or similar shared-store) flag
must say "deployment-wide" / "cross-process, shared via Redis" — never
"process-wide".** A single Node process is the wrong mental model once the
mechanism is backed by an external store: the flag dedupes across every
process pointed at the same Redis instance, not just within one boot of one
process. Getting this wrong invites a future reader to assume a weaker
guarantee than the code actually provides, or to misjudge blast radius
during an incident.

```ts
// WRONG — describes a Redis NX flag as if it only coordinates one process
// Deduped via a process-wide flag so repeated failures only emit once.
const firstEmit = await redis.set(rotationFlagKey, '1', 'EX', 600, 'NX');

// RIGHT — names the actual coordination scope
// Deduped via a Redis SET NX flag shared across every app-api/app-worker
// process on this deployment, so a rotation event that trips on many
// connections at once still emits exactly once cluster-wide.
const firstEmit = await redis.set(rotationFlagKey, '1', 'EX', 600, 'NX');
```

**System-wide event payloads must not smuggle instance-scoped fields.**
When an event genuinely applies platform-wide (e.g. an `ENCRYPTION_KEY`
rotation affects every tenant, not just the one connection/tenant that
happened to win a Redis NX race to emit it), the payload must not include
incidental per-instance identifiers (`connectionId`, `tenantId`) pulled
from whichever caller tripped the gate first — a future subscriber can
misread the field as "the affected scope" and act on it.

1. Prefer an empty (or minimal, tenant/connection-free) payload for
   genuinely global events.
2. If a per-instance field must stay for debugging, its JSDoc must say
   explicitly that the value is "the first-seen example, not the affected
   scope."
3. **Sweep every sibling field with the same shape in one pass.** Fixing
   `connectionId` and leaving an identically-shaped `tenantId` unaddressed
   is an incomplete fix — same pattern as `.claude/rules/shared-types.md`
   "Tightening one schema? Sweep its siblings." Also check the event
   domain's file-header doc: if it documents a default payload shape (e.g.
   `{ tenantId, ... }`) that a genuinely global event doesn't follow, note
   the exception there too.

Precedent: PR #1161 (issue #1011) — `KEY_ROTATION_DETECTED`'s payload
dropped `connectionId` in one review round but kept the identically-shaped
`tenantId` until a later round; `integrations.events.ts`'s file header
claiming `{ tenantId, ... }` for all events needed a follow-up fix to note
the exception.

## Storing secrets at rest (#738)

Every plaintext-secret column — webhook signing secrets, HMAC keys, MFA
secrets, API client secrets — MUST be encrypted at rest via the canonical
helper:

```ts
import {
  encryptColumnValue,
  decryptColumnValue,
  tryDecryptColumnValue,
  encryptToTriplet,
  decryptFromTriplet,
} from '../../core/crypto/encrypted-column.js';
```

**Single-column TEXT shape (preferred for new work):**
- Service-layer encrypts on write: `encryptColumnValue(input.secret)`.
- Repository-layer decrypts at the read site that exposes the plaintext
  to a downstream consumer (HMAC sign, signature verify, etc.) — NOT in
  the path that returns rows to the API client (the public response
  envelope must strip the secret in `toRow()` / equivalent).
- Read site: decrypt with `decryptColumnValue(row.secret)`. On
  `EncryptedColumnError`, disambiguate via the rotation gate — a rotated
  `ENCRYPTION_KEY` invalidates every ciphertext (system-wide, runbook
  recovers) vs a single corrupt/tampered row (non-transient, inspect the
  row). Do NOT silently return the raw bytes as "plaintext" — that
  corrupts every downstream consumer (garbage HMAC signatures, raw bytes
  as auth config). The canonical shape:

  ```ts
  import { decryptColumnValue, EncryptedColumnError } from '../../core/crypto/encrypted-column.js';
  import { isKeyRotationDetected } from '../../core/crypto/key-rotation-guard.js';
  import { PlatformError } from '../../core/errors.js';
  import { ERROR_CODES } from '@orm/shared';

  async function decryptSecret(row, tenantId) {
    try {
      return decryptColumnValue(row.secret);
    } catch (err) {
      if (!(err instanceof EncryptedColumnError)) throw err;
      if (await isKeyRotationDetected()) {
        logger.error({ tenantId, rowId: row.id }, '[#NNN] decrypt failed AND ENCRYPTION_KEY rotation detected');
        throw new PlatformError(
          ERROR_CODES.ENCRYPTION_KEY_ROTATION_DETECTED,
          'Decrypt failed under rotated ENCRYPTION_KEY. Follow the rotation runbook and re-deploy with ALLOW_ENCRYPTION_KEY_ROTATION_BACKFILL=true to acknowledge.',
          503,
        );
      }
      // Rotation ruled out → corruption / tampering. Surface a distinct
      // typed code (500) — or, for a verify path, return null so the
      // caller fails closed (signature-invalid) rather than 500.
      throw new PlatformError(ERROR_CODES.ENCRYPTED_COLUMN_DECRYPT_FAILED, 'Decrypt failed (corruption or tampering, not rotation).', 500);
    }
  }
  ```

  The canonical read-side example lives in
  `domains/events/webhooks.repository.decryptWebhookSecret`. There is no
  plaintext / legacy-key fallback in greenfield code — secrets are
  encrypted-on-write, so a decrypt failure is always either rotation or
  corruption. (The transitional legacy-decrypt + boot-backfill machinery
  the original #738 plan carried was removed in #738 Sub-phase I; the
  `ALLOW_ENCRYPTION_KEY_ROTATION_BACKFILL` env var name retains its
  historical suffix but now only acknowledges the rotation to the
  boot fingerprint guard.)

**Three-column triplet shape (legacy schemas only):**
- `tenant_secrets`, `integration_tokens`, and any pre-existing schema
  with three separate `encrypted_value` / `iv` / `auth_tag` BYTEA
  columns. Use `encryptToTriplet` / `decryptFromTriplet`.
- Do NOT add new triplet-shaped columns in greenfield work — the
  single-TEXT format is the canonical going-forward shape.

**Key derivation:**
- One source: `config.encryptionKey` (the `ENCRYPTION_KEY` env var).
- **Never** use `config.jwtSecret` as a key-derivation source for
  column encryption. JWT rotation should not invalidate stored
  secrets. Pre-#738 the TOTP path violated this; #738 moved every
  column onto `config.encryptionKey` and Sub-phase I removed the last
  transitional `jwtSecret`-keyed decrypter.

**Migration discipline:**
- Add an `-- encrypted-at-rest: encryptColumnValue (#NNN)` comment to
  the migration that introduces the column (or to a follow-up
  marker migration like `121_encrypt_webhooks_secret.sql` if the column
  pre-dates this rule).
- The arch test
  `packages/backend/src/__tests__/encrypted-secret-columns.test.ts`
  enforces the marker at CI time. Columns added without it (and not on
  the allowlist) fail the build.

## Middleware
- Use `fastify-plugin` (fp) wrapper to avoid scope encapsulation
- Tenant context set by middleware: access via `request.tenantId`

## Logging
- Use `request.log` in route handlers (includes request context)
- Use `logger` from `core/logger.ts` elsewhere (pino)
