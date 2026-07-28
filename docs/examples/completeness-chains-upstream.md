# Completeness chains — worked examples (upstream)

These are the concrete multi-site chains from the repo ClaudeTools was
extracted from. They are kept verbatim, with their original paths and issue
numbers, because the GENERAL rule ("when you add a variant to an enumerated
set, grep every sibling site") is toothless without an example of how far a
chain really reaches — several of these span 8+ files across three packages.

Use them as a shape to recognise in your own codebase, not as paths to follow.
The general rule lives in `workflow.md` → "Completeness traps".


- **Metadata bundle entity type** (adding `agents`/`customPages`-style
  types): `MetadataBundleSchema` (deployment.ts) →
  `PackageManifestSchema.contents` (marketplace.ts) → `exportMetadata`
  (metadata-serializer.ts) → `diffMetadata` (metadata-differ.ts) →
  `deployMetadata` add/update **and the removal switch**
  (metadata-deployer.ts) → `prefixBundleApiNames` +
  `scopeChangesetToNamespace` **and
  `countChangesetByType`/`InstallPreviewChangesSchema`** (marketplace.ts +
  shared; the preview-count pair compiles clean and silently under-counts —
  #823) → `filterBundleToNamespace` + `stripBundleNamespacePrefix`
  (`deployment/bundle-namespace.ts`, #1033; a new type needs a
  filter-ownership rule — flat apiName, grouped-by-child, or denied like
  the four label-keyed types — AND a strip mirror of whatever position
  `prefixBundleApiNames` writes for it; extend the round-trip fixture in
  `bundle-namespace.test.ts` whenever a new bundle entity type lands — the
  CI tripwire for strip/prefix drift) → `PACKAGE_OWNED_ENTITY_TYPES`
  (`@orm/shared`) + `LEDGER_STAMP_MAP` (`deployment/provenance-ledger.ts`,
  #1031; ledger enum + resolver, or explicit `NEVER_OWNED_TYPES` exclusion,
  else P-B (#1032) uninstall under-deletes; the `diffMetadata` drift test
  in `provenance-ledger.test.ts` fails on any `type` outside
  `new Set([...PACKAGE_OWNED_ENTITY_TYPES, 'translation', 'profile',
  'role'])`).
- **New `PlatformError` code** → `ERROR_CODES` registry + (if FE-facing)
  `useApiErrorToast` map (see shared-types.md).
- **New permission** → `PERMISSIONS` registry + call sites (see
  backend-api.md).
- **New registry primitive** → definitions array + count test +
  list/describe endpoints (see registry.md).
- **New round-tripped column on a metadata-deployed table** (a column on
  `object_definitions` or any table `exportMetadata`/`deployMetadata`
  serializes): `core/db.ts` interface (migrations.md "Kysely interface
  sync") → deployer INSERT block **and** UPDATE block in
  `metadata-deployer.ts` (both, preserve-on-absence) → a regression test
  per path (testing.md "Export→deploy→export round-trip pins").
  `exportMetadata`'s `selectAll()` carries the column while the write
  blocks silently drop it — the UPDATE (`modified`) block is the easy miss
  (#1211: icon/displayField/queueEnabled; `embedding_config` dropped on
  both paths). **Before classifying a position as behaviorally testable,
  confirm the deployer actually WRITES it AND the entity survives
  `diffMetadata`** —
  `grep -rn lookup_filter_criteria {{PATHS_SRC_GLOBS}}/domains/deployment/`
  → zero hits (exported + prefixed, dropped on deploy); `state_machines`
  has no `api_name` column so `keyByApiName` drops it first. Either failure
  ⇒ transform/unit-level round-trip only, never a behavioral assertion
  (PR #1230 (#1200): positions #6 `lookupFilterCriteria` / #8
  `stateMachines` mis-flagged across three opus rounds).
- **Value-embedded field-name / apiName references in the namespace-prefix
  path** (`prefixBundleApiNames` / `stripBundleNamespacePrefix` /
  `rewriteCriteriaTree` in `deployment/`, `marketplace.service.ts`) — i.e.
  field/object references living INSIDE value blobs, not an entity's own
  top-level apiName: build the position census by grepping the RUNTIME
  CONSUMER — `fields.get(`,
  `getFieldByApiName`, `evaluateCriteria(`, `where[filter.field]`,
  `layoutFieldSet.has(`, `new Set([...view.columns])` — never a single Zod
  type. A `CriteriaSchema`-scoped census misses plain-string refs
  (`listViews.{columns[], filters[].field, sortBy[].field,
  viewConfig.groupByField/dateField}`,
  `approvalProcesses.steps[].{assignedTo, escalationApprover}.fieldApiName`),
  record-key refs (`columnWidths`, `picklistOverrides`), and `z.unknown()`
  blobs (`fields[].rollupFilterCriteria`). Mirror every prefix rewrite on
  the strip side; pin in `bundle-namespace.test.ts` (PR #1230 (#1200) —
  six consecutive rounds, one missed position each).
- **A feature that DERIVES a value by running the bundle pipeline**
  (`exportMetadata` / `diffMetadata` / `filterBundleToNamespace`) inherits
  every documented data-drop of those transforms — it does NOT see raw
  tenant data. (1) `diffMetadata`'s `keyByApiName` drops entities with no
  apiName-equivalent key — `state_machines` (post-`stripIds`: no
  `api_name` / `name`, `objectId` also deleted) always derives `[]`;
  (2) the DEFAULT `bundleScope: 'namespace'` path runs
  `filterBundleToNamespace`, which zeroes the four label-keyed grouped
  types (`layouts`, `listViews`, `validationRules`, `sharingRules`), the
  `NEVER_OWNED_TYPES` (`profiles`, `roles`, `translations`), and URL-keyed
  `webhooks` — those eight categories derive `[]` for a namespace-scoped
  submission; only `bundleScope: 'full'` populates them. Before a spec
  claims a bundle-derived value is populated for category X, trace X
  through the ACTUAL transform (or test
  `deriveFn(filterBundleToNamespace(fixture, 'ns'))`); document structural
  `[]`-always categories as accepted limitations (PR #1240 (#1203) r2–3).
- **New cron/scheduler-backed BullMQ queue**: `new Queue(...)` in
  `core/jobs/queues.ts` → the exported **`allQueues` array** (absent ⇒
  never closed by `closeQueues()` AND never scanned by
  `scheduledJobsService.listJobs()`, making downstream exclusions inert) →
  registration inside **`setupRepeatableJobs()` as a queue-INSTANCE
  method** (`myQueue.upsertJobScheduler('id', { pattern }, {...})` — there
  is no bare `setupScheduledJobs()` / free `upsertJobScheduler()` helper) →
  `pruneLegacyAndStaleSchedulers(myQueue, 'name')` → the
  **`PLATFORM_QUEUE_NAMES` Set in
  `domains/scheduled-jobs/scheduled-jobs.service.ts`** (cross-tenant
  `data: {}` scheduler queues go here so a per-tenant `listJobs()` call
  doesn't scan them and filter to zero) → the **`CRON_QUEUES` fixture + the
  hardcoded "N cron jobs" count in `core/jobs/queues.test.ts`** (fixture
  iterates without an exclusive count — bump the number by hand, or the new
  scheduler ships un-pinned, its `schedulerId`/`pattern` never asserted,
  with zero CI failure). Precedent: #1058 —
  `allQueues`, `PLATFORM_QUEUE_NAMES`, and the `CRON_QUEUES` pin were each
  a SEPARATE spec-audit round.
- **New `config.ts` env var**: the **`ConfigSchema` Zod field** AND the
  **`loadConfig()` `raw` object mapping** (`x: process.env.X`) — BOTH, in
  the same edit. The `raw` map is the only place `process.env` is read, so
  adding just the schema field leaves `config.x` permanently `undefined` —
  every `if (config.x)` gate silently takes the unconfigured branch, no
  type error, no test failure. Mirror an existing paired field
  (`githubAppId`). Precedent: #1058 — `pricechartingApiToken` drafted
  schema-only.
- **`.default()` on a widely-typed Zod field** makes the field REQUIRED in
  the inferred type — sweep every construction site including test
  fixtures (see shared-types.md).
- **Multi-path state producers and guard-consolidation refactors** — see
  "Sibling sweep (canonical statement)" above.

