# Testing Discipline

Framework-independent rules about what a test must actually prove. Stack- and
runner-specific hygiene lives in the packs (e.g. `testing-vitest.md` in
`node-ts`).

The rule underneath most of this file: **a green test that doesn't exercise the
real path is worse than a red one — it hides the defect AND gives false
confidence.**

## Required coverage

Per user-facing operation:
- Happy path.
- Validation failures (missing required, wrong type, constraint violation).
- Not-found / absent-resource cases.
- Authorization boundaries: verify a caller scoped to A cannot reach B's data.

## Root cause over band-aid

**A green test that doesn't exercise the real path is worse than a red one — it hides the defect AND gives false confidence.**

Test friction usually signals a real product defect (accessibility gap,
missing contract, race condition, wrong API shape). Chase it to source; never
paper over it.

### Anti-patterns and their root-cause alternatives

**Skipping tests to get green**
- Anti-pattern: `test.skip(` / `.skip(` on a broken feature or a brittle test.
- Rule: fix the feature. A skip requires BOTH (a) a linked {{VOCAB_ISSUE}} naming the missing prerequisite AND (b) a precise `// TODO(#NNN): ...` comment stating what must land before removal. A skip hiding a regression — the test passed before this branch — is never acceptable.

**Loosening assertions to match buggy output**
- Anti-pattern: changing `expect(x).toBe(400)` to `expect(x).toBeGreaterThanOrEqual(200)` because the code returns the wrong value.
- Rule: fix what produces the wrong value; the assertion documents the contract. Precedent: the create-list-view PATCH test's trigger was rewritten to match the API contract, not its expectation relaxed.

**Swallowing errors to keep the test green**
- Anti-pattern: `.catch(() => {})`, empty `catch` blocks, or an API fallback masking a UI failure inside a "via UI" test.
- Rule: surface the error. A legitimate fallback MUST log loudly with a `[UI-PATH-DROPPED]` tag (or equivalent) so the primary path's failure is visible in CI output. Negative precedent: `withUiFallback` (PR #771) masked a real accessibility defect for multiple CI rounds.

**Inflating timeouts to paper over slowness or races**
- Anti-pattern: raising `{ timeout: N }` on a flaky test or a slow locator.
- Rule: find why it's slow or racy. Timeouts that grow across PRs without a root-cause explanation are compounding reliability debt.

**Brittle positional or structural selectors**
- Anti-pattern: `[class*=...]`, `.nth(N)`, `.first()`, `querySelector('div > span:nth-child(2)')` instead of accessible locators.
- Rule: a locator `getByRole`/`getByLabel`/`getByText` cannot resolve is almost always a real accessibility defect — a missing `htmlFor`/`id` association, `aria-label`, or `role`. Fix the markup. `data-testid` is a last resort for elements with no natural accessible identity (canvas, drag-and-drop targets, decorative icons), never a substitute for a missing form-field label. Precedent: PR #771's e2e journey "build #589 via UI" — `<FormLabel>` lacked `htmlFor`/`id`, so `getByLabel` failed and the positional-selector + API-fallback band-aid masked the a11y bug.

**Bypassing the UI with an API call inside a "via UI" test**
- Anti-pattern: a "fill field via UI" step that calls the API directly on failure and continues.
- Rule: the test no longer tests what it claims. Fix the UI interaction so the locator works, or rename it "via API" and drop the "via UI" claim. Honest test scope > false green.

**Vacuous "explicit option equals the runtime default" regression tests**
- Anti-pattern: a fix makes an option explicit for defense-in-depth (pinning `{ authTagLength: 16 }` on an AES-GCM cipher call where Node already defaults to 16 bytes) and the test asserts only on output produced WITH it, never on a path where omitting it changes the result.
- Rule: **the canonical heuristic — referenced by the two patterns below and by the idempotency-gate section** — ask **"does this assertion fail if I delete the fix?"** Verify manually that it fails with the fix removed and passes with it restored; if it fails on every code path the test touches, it's load-bearing. If it cannot fail, construct the one path where the fix genuinely diverges from default behavior — for `authTagLength`, a decrypt/verify path accepting a caller-supplied truncated auth tag, not the encrypt path where the runtime backfills the default.
- Precedent: PR #1155 (#1131) r2 — the 16-byte-auth-tag test held under both `createCipheriv(..., { authTagLength: 16 })` and `createCipheriv(...)` (`aes-256-gcm`'s encrypt default is already 16); the real pin went against `decryptFromTriplet` with a truncated-but-valid 8-byte tag — GCM tags are leading-bit truncatable per NIST SP 800-38D and Node accepts whatever `setAuthTag()` gets when the option is absent.

**Vacuous regression assertions from an unverified async-ordering claim**
- Anti-pattern: a spec/PR claims "capture state synchronously before await X, because X is the first awaited call in the guarded function" and the test is written against that claim without counting the actual `await`s in source order — if another `await` runs first, the capture precedes anything observable in BOTH paths and `expect(capturedCount).toBe(0)` passes either way.
- Rule: before writing (or approving, in an audit) an assertion about *when* a side effect happened relative to an `await`, list every `await`/`.then()` in the guarded function in source order, identify which one the capture point actually precedes, then apply the delete-the-fix heuristic to that real ordering. Precedent: PR #1164 (#1160) r2 — the spec claimed `runMigrations()` was `main()`'s first await; `worker.ts`'s is `redis.connect()`, making the `runMigrations` half vacuous either way.

**Vacuous ordering / determinism assertions over a single-element fixture**
- Anti-pattern: a `.sort()` (or any dedupe / normalization / ordering transform) fix tested via `expect(values).toEqual([...values].sort())` over a fixture whose every category has ≤1 element — each array trivially equals its own sort, so deleting the `.sort()` fails no test. (`exportMetadata` / any DB read gives no guaranteed row order.)
- Rule: an ordering/determinism invariant test MUST drive at least one fixture input that is BOTH multi-element AND already out-of-order (e.g. `objects: [{ apiName: 'Contact' }, { apiName: 'Account' }]`) and assert the exact sorted output (`toEqual(['Account', 'Contact'])`), so removing the sort flips the assertion. A pre-sorted, single-element, or DB-gated fixture pins nothing. Precedent: PR #1240 (#1203) r1 — `deriveManifestContents`'s `.slice().sort()`, unpinned by `manifest-contents-completeness.test.ts`'s one-entry-per-category fixture.

### Heuristic to apply before accepting any test workaround

Ask: "What would break in a real browser for a real user if I shipped this
as-is?" "Nothing — the test was just fragile" ⇒ a targeted test fix is fine.
"A screen reader can't fill this field" / "the label is missing" / "this
request always 400s" ⇒ that's the real bug; fix it before touching the test.

## Idempotency / dedup gates — test the race, not just the happy path (#1011)

When production code adds a dedupe/idempotency gate — a Redis `SET ... NX`
guarding a one-time emit, a `claimJobOnce` guard, a
`WHERE status='pending' AND escalated_at IS NULL` conditional UPDATE — the
test suite MUST include a case with **two or more candidates that would
otherwise both trip the gate**, asserting the guarded side effect fires
exactly once (`toHaveBeenCalledTimes(1)`). A single-candidate test passes with
or without the gate (delete-the-fix heuristic above), so a later refactor
deleting it regresses silently.

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
branch, check whether the fixture array driving it has only one item — if so,
add a second, otherwise-triggering item and assert the call count. Precedent:
PR #1161 (#1011) — the `KEY_ROTATION_DETECTED` emit test drove a single token.

## Extract pure logic into an exported helper instead of re-implementing it in a test harness

A test that re-implements component-internal derivation logic as a local copy
(`simulatePruneConversationUiState`, `makeRateLimitHarness`, …) proves only
that the COPY behaves as expected; a later edit to the real logic the copy
doesn't mirror ships silently, CI green. Same class as "Root cause over
band-aid" above (see `{{PATHS_RULES_DIR}}/frontend-components.md` "Stateful-harness
tests for controlled components" for the `value`/`onChange` variant).

**Fix:** extract the derivation into a small pure function, export it from the
component's module (or a co-located helper file), and have BOTH the component
callback and the test import the same function.

```ts
// WRONG — test re-implements the component's internal logic
function simulatePruneConversationUiState(convId: string, state: State) { /* copy */ }
it('prunes the waiting map on tab close', () => {
  const result = simulatePruneConversationUiState('conv1', state);
  expect(result.waitingMap.conv1).toBeUndefined();
});

// RIGHT — extract the single-map primitive once, import from both the
// component and the test (the component composes it per-map; the test
// drives the SAME primitive instead of a parallel per-map copy)
// chatPanelActivity.ts:
export function deleteMapKey<T>(map: Record<string, T>, key: string): Record<string, T> { /* real logic */ }
// ChatPanel.tsx:
const pruneConversationUiState = useCallback((convId: string) => {
  setWaitingMap((m) => deleteMapKey(m, convId));
  setIsStuckMap((m) => deleteMapKey(m, convId));
  // ...every other per-conversation map, same primitive
}, []);
// ChatPanel.test.tsx:
import { deleteMapKey } from './chatPanelActivity.js';
it('prunes the waiting map on tab close', () => {
  expect(deleteMapKey({ conv1: true }, 'conv1')).toEqual({});
});
```

Precedent: PR #1175 (#1165) r1–3 — `ChatPanel.test.tsx`'s harness-copy tests
were replaced by extracting `startRateLimitCooldown`/`endRateLimitCooldown`
and `deleteMapKey` into `chatPanelActivity.ts`.

## Source-scanning tripwire tests must strip comments (or scope to the exact token) before asserting a string's ABSENCE

An arch/tripwire test that reads a source file as text and asserts a token
does NOT appear — a naive `source.includes('token')` /
`expect(source).not.toMatch(/token/)` — trips on a mandated explanatory
COMMENT mentioning that token as prose, self-defeating whenever the change
adding the tripwire also documents what it guards (e.g. a comment above a
`<header>` explaining that layout containment makes it a containing block for
`fixed` descendants fails a test asserting `fixed` is absent from its
className).

**Rule:** before scanning source for a token's absence, either
1. **strip comments first** via a `stripComments()` helper — mirror the one in
   `{{PATHS_SRC_GLOBS}}/__tests__/i18n-defaultvalue.test.ts`; or
2. **scope the match to the exact attribute/value**, not the whole file —
   e.g. capture the `className` via `/<header[^>]*className="([^"]*)"/` and
   test `\bfixed\b` against the captured group only.

The same care applies to the BullMQ jobId scanner and the registry-quality
scanner above — every static source scan treats prose it can't parse as a
false match unless comments are stripped or the match is attribute-scoped.
Precedent: `{{PATHS_SPECS_DIR}}/header-ask-ai-query.md` (#1219, PR #1221) r1.


## Multi-tenant integration setup — clean up earlier tenants if a later `createTestTenant` throws (#1201)

A test provisioning two or more tenants before its `try/finally` leaks the
already-created ones if a later `createTestTenant(app)` throws — the throw
escapes before the `finally` is entered, orphaning rows and making later
integration tests flaky. Provision each subsequent tenant inside a `try/catch`
that cleans up the ones already created before rethrowing, or hoist all
creations into a single `try` whose `finally` cleans up whichever handles are
non-null.

```ts
const tenantA = await createTestTenant(app);
let tenantB: TestTenant;
try {
  tenantB = await createTestTenant(app);   // if this throws, tenantA leaks
} catch (err) {
  await cleanupTenant(tenantA);
  throw err;
}
try { /* ... */ } finally {
  await cleanupTenant(tenantB);
  await cleanupTenant(tenantA);
}
```

Precedent: PR #1211 (#1201) Copilot r1 — `metadata-deployer.objects.test.ts`
created a second tenant outside the try/finally guarding the first.

