---
globs:
  - "**/*.test.ts"
  - "**/*.spec.ts"
---

# Testing Conventions

## Framework
- Vitest for unit and integration tests
- Test files: `{name}.test.ts` co-located with source

## Test Categories
- **Repository tests**: Use real DB with test tenant (requires Docker services)
- **Service tests**: Can mock repository layer for unit tests
- **Route tests**: Use Fastify's `inject()` for HTTP-level testing
- **Integration tests**: Full stack with running Docker services

## Required Test Coverage
- Happy path for every endpoint
- Validation error cases (missing required, invalid types, constraint violations)
- Not-found cases (invalid IDs)
- Tenant isolation: verify tenant A cannot see tenant B data

## Test Tenant Setup
- Create a test tenant via direct DB insert or API
- Seed metadata (objects, fields) as needed
- Clean up after tests (delete tenant cascades)

## `test/helpers.ts` is a manual mirror, not an auto-mirror

`createTestApp()` in `packages/backend/src/test/helpers.ts` registers routes
**manually**, from its own import list — it does NOT call `app-builder.ts` or
automatically pick up every domain. When a spec adds a new domain or touches
a domain that isn't registered there, the test helper must be edited in the
same commit:

1. Add the route import at the top (`import { xxxRoutes } from '...'`).
2. Add `await app.register(xxxRoutes);` in `createTestApp()`.
3. If the domain owns a tenant-scoped table that has a FK to `users`,
   `profiles`, `roles`, or `tenants`, add the table name to the
   `cleanupTenant()` tables list — **before** the parent table it references
   (Postgres rejects the cascaded delete otherwise).
4. The `cleanupTenant` helper is best-effort and logs warnings, so a missing
   table shows up as noisy stderr + FK errors during test runs, not test
   failures. Don't ignore the noise.

An integration test that runs with no assertion failures but logs cleanup FK
errors means the helper is incomplete for the domain under test.

## Stubbing the deployer in install / upgrade tests

`marketplaceService.install()` (and anything that calls `exportMetadata` +
`diffMetadata` + `deployMetadata`) treats the incoming bundle as the *intended
tenant state* — items in the tenant that are NOT in the bundle are marked for
removal. An empty or minimal test fixture therefore looks like "remove every
tenant object", which is almost never what the test is checking.

Unless a test is explicitly exercising the deploy pipeline, stub it out:

```ts
vi.mock('../deployment/metadata-deployer.js', () => ({
  deployMetadata: vi.fn(async () => {}),
}));
```

If a specific case needs the deploy step to throw (e.g. to verify an
`install()` failure path), use `vi.mocked(deployMetadata).mockRejectedValueOnce(new Error('…'))`
inside the test. Precedent: `marketplace.install-from-registry.test.ts`.

## Root cause over band-aid

**A green test that doesn't exercise the real path is worse than a red one — it hides the defect AND gives false confidence.**

When a test is hard to write or keep passing, that friction is usually a signal: the product has a real defect (accessibility gap, missing contract, race condition, wrong API shape). Chase the signal to its source. Never paper over it.

### Anti-patterns and their root-cause alternatives

**Skipping tests to get green**
- Anti-pattern: `test.skip(` / `.skip(` when the feature is broken or the test is brittle.
- Rule: fix the feature. Skip is only permitted with BOTH (a) a linked GitHub issue naming the missing prerequisite, AND (b) a precise `// TODO(#NNN): ...` comment explaining exactly what must land before the skip can be removed. A skip that hides a regression — i.e. the test was passing before the current branch — is never acceptable.

**Loosening assertions to match buggy output**
- Anti-pattern: changing `expect(x).toBe(400)` to `expect(x).toBeGreaterThanOrEqual(200)` because the code returns the wrong value.
- Rule: fix what produces the wrong value. The assertion documents the contract; weakening it conceals the breach. Precedent: the create-list-view PATCH test's trigger was rewritten to match the actual API contract, not its expectation relaxed.

**Swallowing errors to keep the test green**
- Anti-pattern: `.catch(() => {})`, empty `catch` blocks, or an API fallback that silently masks a UI failure inside a "via UI" test.
- Rule: surface the error. If a fallback is architecturally legitimate, it MUST log loudly with a `[UI-PATH-DROPPED]` tag (or equivalent) so the primary path's failure is visible in CI output. The `withUiFallback` pattern from PR #771 is the canonical negative example: every failing UI interaction silently fell back to a direct API call, masking a real accessibility defect for multiple CI rounds.

**Inflating timeouts to paper over slowness or races**
- Anti-pattern: increasing `{ timeout: N }` because the test is flaky or the locator takes too long to resolve.
- Rule: find why it's slow or racy. Timeouts that grow across PRs without a root-cause explanation are a reliability debt that compounds.

**Brittle positional or structural selectors**
- Anti-pattern: `[class*=...]`, `.nth(N)`, `.first()`, `querySelector('div > span:nth-child(2)')` as a substitute for accessible locators.
- Rule: if `getByRole`, `getByLabel`, or `getByText` cannot find an element, that is almost always a real accessibility defect in the markup — a missing `htmlFor`/`id` association, a missing `aria-label`, a missing `role`. Fix the markup. The fix helps screen-reader users AND makes the test robust. `data-testid` is a last resort for elements with no natural accessible identity (canvas, drag-and-drop targets, purely decorative icons); it must never substitute for a missing label on a form field. Precedent: PR #771's e2e journey "build #589 via UI" — `<FormLabel>` elements had no `htmlFor`/`id` association, so `getByLabel` couldn't resolve the fields, which led to the brittle positional-selector + API-fallback band-aid that masked the real a11y bug.

**Bypassing the UI with an API call inside a "via UI" test**
- Anti-pattern: a test step named "fill field via UI" that, on any failure, calls the API directly and continues.
- Rule: the test no longer tests what it claims. Either fix the UI interaction so the locator works, or rename the test to "via API" and remove the "via UI" claim. Honest test scope > false green.

**Vacuous "explicit option equals the runtime default" regression tests**
- Anti-pattern: a fix makes an option explicit for defense-in-depth/clarity
  (e.g. pinning `{ authTagLength: 16 }` on an AES-GCM cipher call when
  Node's own default for that algorithm is already 16 bytes), and the
  regression test asserts on output produced with the option present —
  without ever exercising a code path where *omitting* the option would
  produce a *different*, observably-wrong result. The test passes whether
  or not the option is actually wired through; a future refactor that
  silently drops it ships unnoticed.
- Rule: before trusting a new regression test for an "explicit == default"
  style fix, ask "does this assertion fail if I delete the option I just
  added?" If yes on every code path the test touches, it's load-bearing.
  If the answer is "no, Node already defaults to that", find (or
  construct) the one path where the option genuinely diverges from
  default behavior — e.g. a decrypt/verify path that accepts a
  caller-supplied value the option constrains (a truncated auth tag),
  rather than only the encrypt/produce path where the runtime's own
  default silently backfills it. Manually verify the new assertion fails
  with the option removed, then passes with it restored, before counting
  the test as a real regression pin.
- Precedent: PR #1155 (#1131) round 2 — the first "pins a 16-byte auth tag
  length" test held under both `createCipheriv(..., { authTagLength: 16 })`
  and `createCipheriv(...)` (no option) because Node's `aes-256-gcm`
  default is already 16 bytes on the encrypt side; kept as a renamed
  baseline shape check, and the actual regression pin was added against
  `decryptFromTriplet` with a truncated (but cryptographically valid)
  8-byte auth tag — the one shape where `authTagLength` is genuinely
  load-bearing, since GCM tags are leading-bit truncatable per NIST
  SP 800-38D and Node accepts whatever length `setAuthTag()` is handed
  when the option is absent.

### Heuristic to apply before accepting any test workaround

Ask: "What would break in a real browser for a real user if I shipped the product as-is?" If the answer is "nothing — the test was just fragile", a targeted fix to the test is fine. If the answer is "a screen reader can't fill this field" or "the label is missing" or "this request always 400s", that's the real bug — fix it before touching the test.

Test brittleness is frequently a symptom of a product defect. Trace it to source.

## BullMQ jobId / dedupeKey colon-safety (#1075)

BullMQ 5.x **hard-throws** ("Custom Id cannot contain :") on any custom
`jobId` that contains `:` but does not split into **exactly 3** colon-parts
(bullmq@5.70.1 `classes/job.js:1036-1038`). Poller `dedupeKey` values become
jobIds via `core/jobs/poller-dispatch.ts`, so they follow the same rule. This
has silently or hard-broken production enqueues repeatedly (#949, #1037,
#1048, #1074) — each found by hand.

**Convention:** build every jobId / dedupeKey from an **exported `*JobId()`
helper** that uses `-` separators (colon-free by construction), and never
inline a multi-segment colon template. Precedents: `calendarSyncJobId`,
`migrationSyncJobId` / `migrationScanJobId` / `migrationLoadJobId`,
`extractReferencesJobId`. The single source of truth for the rule itself is
`packages/backend/src/core/jobs/job-id.ts`
(`violatesBullMqCustomIdRule` / `isValidBullMqCustomId` /
`assertValidBullJobId`) — import it in helper unit tests rather than
re-inlining `id.split(':').length !== 3`.

**Enforcement:** the architecture test
`packages/backend/src/__tests__/bullmq-jobid-colon-safety.test.ts` statically
scans production source for `jobId:` / `dedupeKey:` literals, `const jobId =`
bindings, and `*JobId()` helper return bodies, treating every `${...}` as a
colon-free token, and fails CI on any that isn't 0-colon or exactly-3-part.
The only sanctioned escape hatch is a justified `{ file, normalized, reason }` entry
in the sibling `bullmq-jobid-colon-safety.allowlist.ts` — for the rare site
where an interpolated variable is itself a colon-composite (making the
runtime id genuinely 3-part) that the static scan can't see through.
`bullmq-jobid-helpers.test.ts` additionally executes every helper and asserts
it stays colon-safe.

## Idempotency / dedup gates — test the race, not just the happy path (#1011)

When production code adds a dedupe/idempotency gate — a Redis `SET ... NX`
guarding a one-time emit, a `claimJobOnce` idempotency guard, a
`WHERE status='pending' AND escalated_at IS NULL` conditional UPDATE — the
test suite MUST include a case with **two or more candidates that would
otherwise both trip the gate**, asserting the guarded side effect fires
exactly once (`toHaveBeenCalledTimes(1)`). A test that only exercises a
single candidate passes identically whether the gate exists or not, so
deleting the gate in a later refactor regresses silently with zero test
failures.

```ts
// WEAK — passes whether or not the `if (firstEmit)` gate is present
it('emits KEY_ROTATION_DETECTED when a token decrypt fails after rotation', async () => {
  await processExpiringTokens([oneExpiringToken]);
  expect(emitSpy).toHaveBeenCalledWith(INTEGRATION_EVENTS.KEY_ROTATION_DETECTED, expect.anything());
});

// CORRECT — proves the dedupe gate actually dedupes
it('emits KEY_ROTATION_DETECTED exactly once across two tokens that both trip rotation', async () => {
  vi.mocked(redis.set).mockResolvedValueOnce('OK').mockResolvedValueOnce(null); // NX: first wins, second loses
  await processExpiringTokens([tokenA, tokenB]);
  expect(emitSpy).toHaveBeenCalledTimes(1);
});
```

Greppable proxy: for any new test near a `firstEmit` / `claimed` / NX-gated
branch, check whether the fixture array driving it has only one item —
if so, add a second, otherwise-triggering item and assert the call count.

Precedent: PR #1161 (issue #1011) — the `KEY_ROTATION_DETECTED` NX-gated
emit test only exercised a single expiring token, so the `if (firstEmit)`
dedupe gate could be deleted without any test failing.

## BullMQ deterministic-jobId recovery gap on permanent-failure retries (#1100)

A deterministic per-item `jobId` (the `*JobId()` helper pattern above) is
only safe for *retry-avoidance* — it is NOT automatically safe for
*recovery*. BullMQ's `add()` no-ops against an existing jobId, **including a
FAILED one**. So once a job with a deterministic id fails permanently (e.g.
a misconfigured upstream credential returns 403/`model_not_found`),
re-running the same enqueue path on a later boot/tick does **not** re-run
that job even after the underlying config is fixed — it silently stays
stuck. `removeOnFail: { count: N }` retention makes this worse: the failed
job just sits there blocking recovery for that key indefinitely.

**Rule:** any enqueue path that (a) uses a deterministic per-item jobId AND
(b) can hit a permanent/non-retryable failure MUST clear the queue's
retained failed jobs once the failure condition is confirmed resolved.
Gate the cleanup behind whatever health/canary check proves the condition
cleared (don't clean speculatively on every boot), and make it best-effort
— log-and-swallow cleanup errors, never let cleanup block the enqueue loop
that follows:

```ts
// After a canary probe confirms the provider is healthy again, and BEFORE
// the enqueue loop runs:
await toolEmbeddingQueue.clean(0, 1000, 'failed').catch((err) => {
  logger.warn({ err }, 'best-effort failed-job cleanup errored, continuing enqueue');
});
```

Greppable proxy: any `*JobId()` helper (or inline deterministic-id template)
paired with a permanent/non-retryable failure branch (`UnrecoverableError`,
a typed `*_PERMANENT_CONFIG_ERROR`, etc.) and NO adjacent `.clean(...,
'failed')` call nearby is a candidate for this gap.

Precedent: PR #1156 (issue #1100) round 1 — `syncToolEmbeddings()`'s
canary added non-retryable handling for a permanently misconfigured
embedding provider but didn't clear `toolEmbeddingQueue`'s failed jobs, so a
tool that failed while the provider config was broken stayed stuck even
after the config was fixed.

## Vitest hygiene: capture-once assertions, mock new logging paths, restore spies (#1100)

Three small vitest anti-patterns recurred across the same PR's review
rounds — cheap to check, worth a standing sweep on any new test that
exercises an error/logging path:

1. **Assert error shape once, not via two separate invocations.** A test
   that calls the function under test twice — once via
   `expect(fn()).rejects.toThrow(...)`, again inside a `try/catch` to check
   `.cause`/`.code`/other properties — duplicates work, and if the function
   has any side effect (a log line, a metric increment, a DB write), the
   second call double-fires it. Capture the rejection once and assert every
   property on the same captured object:
   ```ts
   // WRONG — invokes fn() twice
   await expect(fn()).rejects.toThrow(SomeError);
   try { await fn(); } catch (err) { expect((err as SomeError).cause).toBe(...); }

   // RIGHT — one invocation, multiple assertions on the same object
   const err = await fn().catch((e) => e);
   expect(err).toBeInstanceOf(SomeError);
   expect((err as SomeError).cause).toBe(...);
   ```
2. **Mock `logger` before importing a module whose new code path logs.**
   When a change adds a `logger.warn`/`logger.error` call on a branch a new
   test exercises, and the module under test imports the real
   `core/logger.js` at module load time, the test emits real log output
   unless the logger module is mocked (`vi.mock('../../core/logger.js',
   ...)`) — noisy at best, flaky at worst as more tests hit the same
   branch. Follow the mock pattern already used elsewhere in the suite
   (e.g. `integration-executor.test.ts`).
3. **Restore `vi.spyOn` spies with `afterEach(() => vi.restoreAllMocks())`.**
   Unlike `vi.clearAllMocks()`, a `vi.spyOn(obj, 'method')` spy stays
   attached to the real object across tests in the same file/suite unless
   explicitly restored — it can leak spy behavior into unrelated later
   tests. Any `describe` block that adds spies via `vi.spyOn` needs a
   restore, either its own nested `afterEach` or the file's top-level one.

Precedent: PR #1156 (issue #1100) rounds 1 and 4 — all three patterns
appeared in the same review cycle across `data.service.test.ts`,
`openai-embedding.test.ts`, and `embedding-sync.test.ts`.

## Running
- `pnpm --filter @orm/backend test` (when configured)
- Docker services must be running: `docker compose up -d postgres redis minio`
