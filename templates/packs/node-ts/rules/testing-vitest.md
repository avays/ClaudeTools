# Testing — Node / TypeScript / Vitest

Runner- and library-specific hygiene. The framework-independent discipline
(what a test must prove, vacuous-assertion classes, the delete-the-fix
heuristic) is in core's `testing-discipline.md` — read that first.

## Framework

- Vitest for unit and integration tests.
- Test files `{name}.test.ts`, co-located with source.

## BullMQ jobId / dedupeKey colon-safety (#1075)

BullMQ 5.x **hard-throws** ("Custom Id cannot contain :") on any custom
`jobId` containing `:` that does not split into **exactly 3** colon-parts
(bullmq@5.70.1 `classes/job.js:1036-1038`). Poller `dedupeKey` values become
jobIds via `core/jobs/poller-dispatch.ts` and follow the same rule — this has
silently or hard-broken production enqueues repeatedly (#949, #1037, #1048,
#1074).

**Convention:** build every jobId / dedupeKey from an **exported `*JobId()`
helper** using `-` separators (colon-free by construction); never inline a
multi-segment colon template. Precedents: `calendarSyncJobId`,
`migrationSyncJobId` / `migrationScanJobId` / `migrationLoadJobId`,
`extractReferencesJobId`. Single source of truth for the rule:
`{{PATHS_SRC_GLOBS}}/core/jobs/job-id.ts` (`violatesBullMqCustomIdRule` /
`isValidBullMqCustomId` / `assertValidBullJobId`) — import it in helper unit
tests rather than re-inlining `id.split(':').length !== 3`.

**Enforcement:** `{{PATHS_SRC_GLOBS}}/__tests__/bullmq-jobid-colon-safety.test.ts`
scans production source for `jobId:` / `dedupeKey:` literals, `const jobId =`
bindings, and `*JobId()` return bodies (every `${...}` treated as a colon-free
token), failing CI on anything not 0-colon or exactly-3-part. Only sanctioned
escape hatch: a justified `{ file, normalized, reason }` entry in the sibling
`bullmq-jobid-colon-safety.allowlist.ts`, for the rare site where an
interpolated variable is itself a colon-composite (runtime id genuinely
3-part) the scan can't see through. `bullmq-jobid-helpers.test.ts` also
executes every helper and asserts it stays colon-safe.

**Adding a new `*JobId()` helper is an incomplete-chain trigger — update
`bullmq-jobid-helpers.test.ts` in the SAME commit or CI fails.** It
auto-discovers every exported `*JobId` symbol and asserts SYMMETRIC equality
against its own `COVERED_BUILDERS` set (`expect([...found].sort()).toEqual(
[...COVERED_BUILDERS].sort())`) plus a `producedIds` entry exercising each one,
so a helper the discovery finds but those don't list fails immediately. When
you add `xxxJobId()` to `core/jobs/job-id.ts` (or any file), add `'xxxJobId'`
to `COVERED_BUILDERS` and a colon-free `producedIds` entry in the same commit.
Precedent: PR #1229 (#1215) r1 — `ebayDeletionPurgeJobId` landed in
`job-id.ts` with the helper test un-updated, a guaranteed CI failure.

## BullMQ deterministic-jobId recovery gap on permanent-failure retries (#1100)

A deterministic per-item `jobId` (the `*JobId()` pattern above) is safe for
*retry-avoidance*, NOT automatically for *recovery*: BullMQ's `add()` no-ops
against an existing jobId, **including a FAILED one**. Once such a job fails
permanently (e.g. a misconfigured credential returning 403/`model_not_found`),
the same enqueue path on a later boot/tick does **not** re-run it even after
the config is fixed, and `removeOnFail: { count: N }` retention leaves it
blocking that key indefinitely.

**Rule:** any enqueue path that (a) uses a deterministic per-item jobId AND
(b) can hit a permanent/non-retryable failure MUST clear the queue's retained
failed jobs once the failure condition is confirmed resolved. Gate the cleanup
behind the health/canary check that proves it cleared (never speculatively on
every boot) and make it best-effort — log-and-swallow cleanup errors, never
let cleanup block the enqueue loop that follows:

```ts
// After a canary probe confirms the provider is healthy again, and BEFORE
// the enqueue loop runs:
await toolEmbeddingQueue.clean(0, 1000, 'failed').catch((err) => {
  logger.warn({ err }, 'best-effort failed-job cleanup errored, continuing enqueue');
});
```

Greppable proxy: any `*JobId()` helper (or inline deterministic-id template)
paired with a permanent/non-retryable failure branch (`UnrecoverableError`, a
typed `*_PERMANENT_CONFIG_ERROR`, etc.) and NO adjacent
`.clean(..., 'failed')` call nearby. Precedent: PR #1156 (#1100) r1 —
`syncToolEmbeddings()`'s canary added non-retryable handling but didn't clear
`toolEmbeddingQueue`'s failed jobs.

## Vitest hygiene: capture-once assertions, mock new logging paths, restore spies (#1100)

Three anti-patterns from one review cycle — sweep any new test exercising an
error/logging path:

1. **Assert error shape once, not via two separate invocations.** Calling the
   function twice — `expect(fn()).rejects.toThrow(...)`, then again in a
   `try/catch` to check `.cause`/`.code` — duplicates work and double-fires
   any side effect (log line, metric, DB write). Capture the rejection once:
   ```ts
   // WRONG — invokes fn() twice
   await expect(fn()).rejects.toThrow(SomeError);
   try { await fn(); } catch (err) { expect((err as SomeError).cause).toBe(...); }

   // RIGHT — one invocation, multiple assertions on the same object
   const err = await fn().catch((e) => e);
   expect(err).toBeInstanceOf(SomeError);
   expect((err as SomeError).cause).toBe(...);
   ```
2. **Mock `logger` before importing a module whose new code path logs.** A
   module importing the real `core/logger.js` at load time emits real log
   output on the new branch unless mocked
   (`vi.mock('../../core/logger.js', ...)`). Follow the existing pattern (e.g.
   `integration-executor.test.ts`).
3. **Restore `vi.spyOn` spies with `afterEach(() => vi.restoreAllMocks())`.**
   Unlike `vi.clearAllMocks()`, a `vi.spyOn(obj, 'method')` spy stays attached
   to the real object across tests in the same file/suite unless restored, and
   leaks behavior into unrelated later tests. Any `describe` adding spies
   needs a restore — its own nested `afterEach` or the file's top-level one.
4. **Restore an env var by `delete`-ing it, never by reassigning a captured
   value that may be `undefined`.** `process.env.X = captured` where `captured`
   is `undefined` (the var was unset) does NOT delete the key — Node coerces
   the assignment to the literal STRING `'undefined'`, which is truthy, so any
   `if (process.env.X)` gate reads as configured. Convention: unconditional
   `afterEach(() => { delete process.env.X; })` (see `embedding-sync.test.ts`),
   never a save/restore that reassigns. Greppable proxy: an
   `afterEach`/`afterAll` assigning `process.env.X = <capturedVar>` rather than
   `delete process.env.X`. Precedent: PR #1241 (#1059) —
   `catalog-embedding-sweep.worker.test.ts`'s `OPENAI_API_KEY` save/restore
   left the var as the truthy string `'undefined'`.

Precedent: PR #1156 (#1100) r1, r4 — across `data.service.test.ts`,
`openai-embedding.test.ts`, and `embedding-sync.test.ts`.

## jsdom has no Pointer Capture API — mock capture methods, don't dispatch a real pointerdown through a host element (#1166)

jsdom (this repo's pinned 29.x) implements no Pointer Capture API at all —
`Element.prototype.setPointerCapture` / `releasePointerCapture` /
`hasPointerCapture` don't exist — so a handler that unconditionally calls
`e.currentTarget.setPointerCapture(e.pointerId)` throws a TypeError the
instant a test constructs a real `pointerdown` and dispatches it through a
rendered host element, before any assertion runs.

**Pattern:** invoke the handler directly with a hand-built synthetic event
object whose `setPointerCapture` / `releasePointerCapture` /
`hasPointerCapture` are `vi.fn()` mocks, then dispatch only the FOLLOW-UP
`pointermove` / `pointerup` as real events on `document` — those ARE consumed
via `document.addEventListener` and never touch the capture API. Never write
(or approve, in a spec) a test plan phrased as "construct pointerdown on a
host element and dispatch PointerEvents on document" — it throws on the first
line. Reference precedent:
`{{PATHS_SRC_GLOBS}}/hooks/usePanelWidth.test.tsx`'s `buildPointerDownEvent`
helper. Negative precedent: `{{PATHS_SPECS_DIR}}/chat-panel-drag-resize.md` (#1166,
PR #1176) r1 — the spec's stated test strategy would have thrown as written.

## A partial library mock goes stale when `main` starts using more of that surface — re-run the suite after merging main, and mock the FULL surface

A mock covering only the subset of a shared library its own code uses
(classically `vi.mock('react-i18next', () => ({ useTranslation: () =>
({ t: (k) => k }) }))` — a `t` stub with no `i18n` object) is hostage to what
OTHER code on the page starts consuming.

- **After merging/rebasing `main`, re-run the affected test suite** — a green
  run BEFORE the merge does not survive it. Instance of the general
  merge-fallout sweep: `main` can move contracts your tests silently depend on.
- **When a library mock breaks after such a merge, mock the FULL surface the
  page now uses, not just the subset your original code used.** A
  `react-i18next` mock returning `t` must also return an `i18n` object with at
  least `{ language: 'en' }` (plus `changeLanguage` etc. if consumed) once
  anything threads the locale — mock the real hook's shape completely rather
  than patching in one missing field per failure.
- **This applies proactively to every NEWLY-authored `react-i18next` mock, not
  only to one that breaks after a merge.** In a fresh test file
  `useTranslation` MUST return `{ t, i18n: { language: 'en' } }`, never a bare
  `{ t }`, even if the component doesn't read `i18n.language` today — Copilot
  flags the bare-`t` shape at authoring time regardless.
- Greppable proxy: any `vi.mock('react-i18next'` / `vi.mock('i18next'` whose
  factory returns a `useTranslation` stub with no `i18n` key.

Precedents: PR #1209 (#1197) — merging `origin/main` (carrying #1199's
locale-threading) broke 16 Conversations-page tests whose mock returned only
`t`. PR #1216 (#1210) Copilot r1 — `AICommandBar.test.tsx` and
`ImpersonationBanner.test.tsx` shipped bare-`t` mocks on brand-new files.

