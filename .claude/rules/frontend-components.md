# Frontend Component Library Conventions

## @orm/ui Package

All shared UI components live in `packages/ui/` (`@orm/ui`). **Always import from `@orm/ui`**, not from old `@/components/ui/` paths.

```typescript
// CORRECT:
import { Button, Alert, StatusBadge, FormInput, cn } from '@orm/ui';

// WRONG (old paths — deleted):
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
```

## Storybook

Browse all components with live examples and prop docs:
```bash
pnpm --filter @orm/ui storybook    # http://localhost:6006
```
24 stories with autodocs. Check here FIRST before creating new components.

## Build Order

`@orm/shared` → `@orm/ui` → `@orm/frontend` (ui must build before frontend)

## Component Inventory (@orm/ui exports)

### UI Primitives
Button, Alert, StatusBadge, FormInput, FormLabel, CheckboxField, IconButton, PageHeader, PillPicker, MultiSelect, LoadingPlaceholder, SimplePagination, SectionHeader, Tabs, ToastContainer, DynamicIcon, InlineMessage, ReadOnlyField, FieldOrValueInput

### Common
ConfirmDialog, EmptyState, ErrorBoundary, LoadingSpinner

### Table
AdminTable, DataTable, DataTableColumnHeader, DataTableEmpty, DataTablePagination, DataTableToolbar, ColumnChooser, useDataTable, column-helpers, activeBadgeCell, apiNameCell

### Editor
RichEditor

### Utilities
cn() — conditional class merging

### What stays in @orm/frontend (NOT in @orm/ui)
FeatureGuard, SuperAdminGuard, ImpersonationBanner — depend on auth/tenant stores

## Rules

1. **Import from `@orm/ui`** — never create local copies of shared components
2. **Never use raw `<button>`** — use `<Button>` with variant + size
3. **Never use raw `<input>` / `<select>` / `<textarea>`** in admin forms — use `<FormInput>`
4. **Never use raw `<label>`** — use `<FormLabel>`
5. **Never use inline error `<p>` tags** — use `<Alert variant="error">`
6. **Never use raw checkboxes** — use `<CheckboxField>`
7. **Never create inline status badges** — use `<StatusBadge>`
8. **Never create inline confirmation dialogs** — use `<ConfirmDialog>`
9. **Use semantic color tokens** — never raw Tailwind color scales
10. **New components go in `@orm/ui`** — not in `@orm/frontend`, unless they depend on app-specific stores/hooks

## Recurring correctness rules

These are patterns that repeatedly surface in PR review. They apply to every
new component. The `auditor` agent runs greppable checks for each of these
before approving a PR.

> **Self-audit before you push.** The ones below are easy to miss in a
> large diff. Before committing frontend changes, either (a) run the
> auditor agent on your staged diff, or (b) grep your own diff for the
> patterns in `.claude/agents/auditor.md` → "Frontend Correctness Patterns
> Checklist". `git diff --staged -- 'packages/ui/**' 'packages/frontend/**'`
> through those patterns catches roughly 80% of what Copilot would flag
> in review.

### Accessibility

- **Icon-only buttons require `aria-label`.** `title` alone is not a reliable
  accessible name — it's hover-only and inconsistent across assistive tech.
  Any `<button>` whose visible children are icons (Lucide `<X />`, `<Pencil />`,
  etc.) MUST include `aria-label`, even if a `title` is present. Example:
  `<button title="Close" aria-label="Close editor"><X /></button>`.
- **Inputs with only a placeholder need `aria-label`.** Placeholders disappear
  when the user types and are announced inconsistently. If there's no visible
  `<FormLabel>` attached, add `aria-label={placeholder}`.

### Lifecycle timing

- **Dev-time `console.warn` / `console.error` calls live in `useEffect`,
  not in the render body.** Warnings in render fire on every re-render and
  spam the console. Gate behind `useEffect` keyed on the offending prop
  combination so it fires once per config change.

### Button semantics

- **Shared Button components must default to `type="button"`.** The HTML
  default is `type="submit"`, which fires form submission when wrapped in
  any `<form>`. If an editor card, dialog, or any wrapper containing action
  buttons is ever rendered inside a `<form>`, Enter-key or a click submits
  the form unintentionally. Both `AdminEditorCard` footer buttons set
  `type="button"` explicitly — any new shared wrapper must do the same.

### Prop ↔ persisted-state drift

- **localStorage-loaded state that depends on a prop toggle must be
  sanitized when the toggle flips.** Example: `AdminTable`'s `columnVisibility`
  feature persists per-column hidden state. If a page mounts with
  `columnVisibility={false}` but the storage still has `{statusColumn: false}`,
  TanStack applies it and the column stays hidden — with no chooser UI to
  restore it. Solution: only apply persisted state when the feature is
  enabled; otherwise pass `{}`.
- **Prop flags that remove a column from the chooser must strip the
  persisted-hidden entry.** If `alwaysVisible: true` is added to a column
  later, any prior `visibility[colId]=false` in localStorage would keep it
  hidden forever. Sanitize on mount / columns change.
- **Never use index keys (`key={idx}`) on a list whose order the user can
  change.** Combined with any per-row local state (e.g. a textarea that
  holds raw text while the persisted shape is structured), reorder shuffles
  the rows but keeps the original component instances mounted at their
  position — local state stays stale and silently flushes back to the
  swapped-in row on its next change event. Use a stable identity key:
  either a UUID minted when the row is added (parallel `ids` array kept in
  lockstep with the data array), or an id baked into the row itself.
  Greppable proxy: `key=\{idx\}` or `key=\{i\}` on a `.map((..., idx) =>`
  inside any editor whose array supports drag / arrow-button reorder.
  Precedent: `AdminClassifierEditorPage` step reorder — index keys silently
  reverted ArrowUp/ArrowDown swaps for same-kind AI steps on the next
  textarea blur (#746 pass-1 F3).

### Union-typed props — validate the shape

- **If a prop is typed as `false | { ...all-optional-fields }`, a truthy-but-
  empty object is a silent trap.** Example: `search={{}}` on `AdminTable`
  enables the search UI, but with no `keys` and no `accessorFn`, typing
  filters everything out. Require at least one discriminator at runtime
  (`search.accessorFn || (search.keys && search.keys.length > 0)`) and log
  a dev warning on misconfiguration.

### Pagination correctness

- **When a UI exposes a pageSize selector, the data hook MUST accept
  pageSize AND include it in the query key.** Forgetting either produces
  silent state desync: UI says "25 per page", server still returns 20,
  TanStack's pageCount goes wrong.
- **Estimated totals (endpoints that don't return a real `total`) require
  an end-of-list latch.** Without one, Next stays enabled past the end
  and the user loops into empty pages. Track a `knownTotal` once the
  server returns `rows.length < pageSize` OR an empty overshoot, and use
  it for the footer total thereafter (reset on query-key changes).

### Column visibility / empty-row layout

- **When a table has a user-toggleable column chooser, guard against
  "zero visible columns".** Hiding the last column produces `<td colSpan={0}>`
  and breaks the empty-row layout. Refuse the toggle when only one
  toggleable column remains.

### i18n fallbacks

- **Never use `t(key) || 'fallback'` for accessible labels.** i18next
  returns the key string when a translation is missing — which is truthy,
  so the `||` branch never fires and the accessible label ends up as the
  raw key (e.g. `common:nextPage`). Use the `defaultValue` option instead:
  `t('common:nextPage', { defaultValue: 'Next page' })`. Enforced because
  this pattern appeared in every icon-button accessibility fix across #486
  review.

### Destructive mutation re-entrancy

- **Mutation re-entrancy guards MUST use a ref latch, not just
  `mutation.isPending`.** `mutation.isPending` doesn't flip until React
  Query processes the mutate call — a fast double-click on a `ConfirmDialog`
  button can fire `onConfirm` twice before the flip propagates. Pattern:

  ```ts
  const inFlightRef = useRef(false);
  // inside onConfirm / mutate caller:
  if (inFlightRef.current || mutation.isPending) return;
  inFlightRef.current = true;
  mutation.mutate(input, {
    onSettled: () => { inFlightRef.current = false; },
  });
  ```

  Every destructive confirmation (delete, deploy, rollback, etc.) needs
  this. `AdminTable` does it internally for its built-in delete flow;
  hand-written destructive flows must do it themselves.

- **For synchronous "no-mutation" confirms (e.g. mode switches, value
  collapses), the same race exists — even without React Query.** A
  `ConfirmDialog`'s `onConfirm` that calls `setOpen(false)` and a
  side-effecting handler is "synchronous JS" but NOT synchronous from
  React's perspective: `setOpen(false)` queues a state update; the
  dialog stays mounted until the next commit. A fast double-click can
  fire `onConfirm` twice before that commit. Clearing the latch
  synchronously after the handler runs is the trap — the second click
  sees `inFlightRef.current === false`.

  Pattern — keep the latch set across the close→reopen cycle and reset
  on the next dialog-open transition:
  ```ts
  useEffect(() => {
    if (pendingMode) inFlightRef.current = false;  // open => fresh
  }, [pendingMode]);
  // ...
  onConfirm={() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    doSyncSideEffect();
    setPendingMode(null);
    // do NOT clear here — useEffect handles it on the next open.
  }}
  ```

  Same mental model as the async-mutation case above: "synchronous JS"
  is not "synchronous React rendering." The auditor agent's dimension 3
  (runtime / CSS / browser quirks) extends to React-rendering quirks
  for this reason. (The original precedent — the mode-switch
  ConfirmDialog in `<CriteriaBuilder>` from PR #637 — was deleted in
  the #642 redesign, but the rule applies to any synchronous-confirm
  that side-effects + closes via async state. Apply it whenever a
  ConfirmDialog's onConfirm closes the dialog AND fires side-effects.)

### Persisted base must track the latest save

- **When merging live state into a persisted base, update the base after
  each save.** If you take a mount-time snapshot (`const base = persisted.current`)
  and never refresh it, later writes that intentionally skip a disabled
  feature will overwrite the user's in-flight change with the stale base
  value. After `savePersisted(key, next)`, set `persistedRef.current = next`
  so subsequent saves build on the latest state.

### Paginated data-source changes

- **When a pagination panel is reused across different data sources
  (e.g. a drawer panel keyed by a selector above), reset local `page`
  state when the data source changes — not just latch state (`knownTotal`).**
  A stale `page` from a prior selection can land on an out-of-range page
  for the new source and render an empty view until the user navigates
  back. `pageSize` is a user preference and should typically persist
  across source changes; `page` should not.

  ```ts
  useEffect(() => { setPage(0); setKnownTotal(null); }, [sourceId]);
  useEffect(() => { setKnownTotal(null); }, [pageSize]);
  ```

### Pagination footer display correctness

- **Clamp the displayed page number on overshoot.** When `pageIndex`
  exceeds `pageCount - 1` (e.g. during a brief window before the clamp
  effect fires, or when total estimation overestimates), the naive
  `{pageIndex + 1} / {pageCount}` renders impossible labels like "6 / 5".
  Compute `displayedPageNumber = isOvershoot ? pageCount : pageIndex + 1`.
- **Collapse the range label to `noResults` on overshoot.** Otherwise
  `start = pageIndex * pageSize + 1` exceeds `total` and you get
  inverted ranges like "31–25 of 25".

### Storybook stories as reference material

- **Stories are copy-paste starting points — they must model the
  recurring rules.** If a story renders a raw `<button>` to demonstrate
  a slot prop, the button MUST include `aria-label` and `type="button"`.
  If it demos `CheckboxField`, the `onChange` handler must use the boolean
  signature (`(checked) => ...`), not an event signature. Reviewers have
  flagged story violations with the same severity as production-code
  violations; treat them the same way.

### Validate the value you submit

- **Run input validation on the normalized (trimmed, coerced) value, and
  submit the same normalized value.** `if (!input) fail; submit(input.trim())`
  lets whitespace-only inputs pass validation but submit empty, and lets
  values with leading/trailing whitespace pass validation but differ from
  what's sent. Normalize first, then validate, then submit the normalized
  value.

### Backend `pageSize` caps — read before hardcoding

- **Before hardcoding a fetch `pageSize` larger than the hook default,
  read the backend Zod schema's `.max()`.** Integrations-style domains
  cap at 100 (`ListProvidersQuerySchema`, `ListConnectionsQuerySchema`
  in `integrations.routes.ts`). Passing a larger value silently returns
  400 and the page renders empty. When tempted to set a large fetch
  size to work around client-side pagination over a partial list, pick
  one of: (a) confirm the cap permits it, (b) switch to true server-mode
  pagination via `AdminTable` `pagination={{ mode: 'server', ... }}`,
  or (c) use a single-entity hook (`useX(id)`) if that's what the
  caller actually needs.
- Precedent: PR #500 shipped with `pageSize=500` on two paginated
  hooks, causing 400s in tenant-scaled installs. Fixed to 100 and
  the detail page additionally migrated to `useIntegrationProvider(id)`.

### Localized-label search — always `accessorFn`, never `keys`

- **When a record has `label: Record<string, string>`,
  `search={{ keys: ['label'], ... }}` on `AdminTable` stringifies
  to `[object Object]` and matches nothing.** The client filter
  runs `String(row[key])` on each configured key — and
  `String({en: 'Foo'})` is the literal `"[object Object]"`. Use
  `search.accessorFn` that joins the string values explicitly:
  ```ts
  search={{
    accessorFn: (row) =>
      [row.apiName, ...Object.values(row.label ?? {}).filter(
        (v): v is string => typeof v === 'string',
      )].join(' '),
    placeholder: 'Search xs…',
  }}
  ```
- Precedent: PR #500 Channels, IntegrationProviders, and
  AdminProviders (3 of 7 migrated pages) all had this silent bug —
  search box rendered fine but filtered every row to empty.

### Routed editor route shape — one `:id`, `'new'` signals create

- **Never ship both a static `xxx/new` route AND an `xxx/:id` route
  together.** React Router matches static paths first, so
  `useParams<{ id: string }>()` on `/admin/xxx/new` returns
  `id === undefined` — not `'new'`. If the page treats `!id` as an
  error state, create mode is unreachable.
- **Correct pattern:** single `:id` route. `id === 'new'` signals
  create. Matches the flows / layouts / objects editor-page
  convention. Page logic:
  ```tsx
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const { data: record, isLoading } = useRecord(isNew ? undefined : id);
  if (!isNew && isLoading) return <LoadingPlaceholder ... />;
  ```
- Precedent: PR #508 (#505) initially shipped with both
  `groups/new` and `groups/:id` routes; the page's "Invalid URL"
  guard masked the broken create flow during testing.

### Auto-generated `apiName` must start with a letter

- **`labelToApiName`-style helpers must output `^[A-Za-z][A-Za-z0-9_]*$`
  even when the label starts with a digit.** A plain `_digit`
  prefix still fails the backend Zod schema. Use a fixed letter
  prefix scoped to the entity:
  ```ts
  return /^[A-Za-z]/.test(sanitized) ? sanitized : `g_${sanitized}`;
  ```
- Precedent: PR #508 `GroupEditor` used `_${digit}`; every
  digit-starting auto-generated name would have been rejected by
  `CreateGroupSchema`.

### Form-field completeness across create + update

- **If an editor exposes form field X, both the create and update
  mutation payloads must include X.** Silent-save bug if create
  carries it through but update omits it — the UI shows success,
  the DB doesn't change, the next refetch reverts the edit.
  Audit: diff `createMutation.mutate(input)` and
  `updateMutation.mutate({ id, input })` field-by-field.
- Precedent: PR #508 `AdminListViewsPage` — `viewType` and
  `viewConfig` were on create but missing from update.

### Atomic multi-mutation toggles — chain via `onSuccess`

- **When a single UI action requires two dependent mutations
  (e.g., "set new default" requires "clear old default"), chain
  them via `onSuccess`.** Firing in parallel with no backend
  uniqueness enforcement risks inconsistent state.
  ```ts
  const applyNew = () => updateX.mutate(newPayload, {...});
  if (currentDefault) {
    updateX.mutate(clearOldPayload, {
      onSuccess: applyNew,
      onError: handleMutationError,
    });
  } else {
    applyNew();
  }
  ```
- Precedent: PR #508 `AdminListViewsPage.handleSetDefault`.

### Single-entity hooks over list-then-find

- **Prefer `useX(id)` over `useXs().find((x) => x.id === id)` in
  routed detail pages.** The find pattern produces a false-404
  when the record exists but isn't on the first list page, and
  loads N rows to look up 1. When the backend route exists
  (`GET /api/v1/admin/xs/:id`), add the hook.
- Precedent: PR #500 audit flagged `AdminIntegrationProviderDetailPage`
  using `useIntegrationProviders(1, 500).find(id)` — fixed to
  `useIntegrationProvider(apiName)`. PR #508 repeated the pattern
  on `AdminGroupEditorPage` and added `useGroup(id)`.

### Tailwind important modifier — prefix form

- **Use `!pl-9` (prefix), not `pl-9!` (suffix), when overriding a
  base CSS reset.** Tailwind v4 accepts both syntaxes, but this
  repo's convention is the prefix form — see
  `packages/frontend/src/components/layout/GlobalSearch.tsx` and
  `packages/frontend/src/components/admin/IconPicker.tsx`. The
  `tokens.css` reset (`packages/ui/src/styles/tokens.css:69-84`)
  targets every common `input[type="..."]` with attribute-selector
  specificity; Tailwind utilities without the `!` modifier can't
  override it.
- Precedent: PR #500 `AdminTableToolbar` used `pl-9!` in the first
  fix; Copilot round 5 flagged it as non-conventional.

### Mutations missing `onError`

- **Every `.mutate(data, { onSuccess: ... })` must also have an
  `onError`.** Without one, a failed mutation silently drops the user
  on a stuck editor — the happy path doesn't fire, there's no error
  toast, and the UI gives no signal. Pair every `onSuccess` with a
  matching `onError` branch. For structured branching across several
  error codes, use `useApiErrorToast` from
  `packages/frontend/src/hooks/useApiErrorToast.ts`; otherwise inline:

  ```ts
  mutation.mutate(input, {
    onSuccess: (data) => {
      onClose();
      toastSuccess('Saved');
    },
    onError: (err: unknown) => {
      toastError(err instanceof Error ? err.message : 'Save failed');
    },
  });
  ```

- Greppable: a `.mutate(` with `onSuccess` present but no `onError`
  in the same options object. Audit sweep lives in
  `.claude/skills/audit-phase/SKILL.md`.

### Live-edit pruning vs save-time pruning

**Never run normalization / pruning / validation transforms inside a
controlled component's `onChange` callback unless the transform is a true
no-op for in-progress edits.** Transforms that strip "empty" placeholders
will delete the row the user just added, and the next render shows the
component as if nothing happened — Add condition becomes unusable.

The trap pattern (PR #637 round 4):

```tsx
// WRONG — placeholder row vanishes the moment the user clicks "Add"
function pushCriteria(next: Criteria) {
  // pruneEmptyCriteria turns `{$and:[{}]}` (the just-added placeholder)
  // into `null`, parent state becomes null, builder re-renders empty.
  onChange({ triggerCriteria: pruneEmptyCriteria(next) });
}
```

The correct partition: live edits pass through unchanged so the user sees
their in-progress state; pruning / normalization / serialization happens
exactly once at the **persistence boundary** (the save handler that
constructs the API payload). This is the same shape rule as
`.claude/rules/frontend.md` "API paths" and `delete-lifecycle.md` —
boundary code does the boundary work.

```tsx
// RIGHT — live state carries placeholders; save handler cleans them up
function pushCriteria(next: Criteria) {
  onChange({ triggerCriteria: next });  // pass-through
}
// Elsewhere, in the save handler:
function formToPayload(form: Form) {
  return { ...form, triggerCriteria: pruneEmptyCriteria(form.triggerCriteria) };
}
```

Greppable proxy: any consumer of `CriteriaBuilder` (or any controlled
component with a structured value) whose `onChange` callback wraps the
incoming value in a transform should be flagged for review. The transform
is correct ONLY in the save serializer.

**`<CriteriaLogicEditor>` (#662) follows the same rule.** When the user
edits a logic string and presses Save, the component calls `onChange(newTree)`
with the restructured tree — no pruning, no normalization. The parent sees
the live tree with any placeholder leaves intact. Pruning still happens at the
persist boundary (the save handler that constructs the API payload).

### Persist-boundary sweep — find every save site, not just one

**When a file owns multiple sub-components or multiple save handlers, an
import-level sweep is incomplete.** A grep for `isEmptyCriteria` finds
every read that uses the helper, but not every write site that needs the
companion `pruneEmptyCriteria` partner. The two are different in number:
many components have several `handleSave` / `handleSubmit` / `formToPayload`
functions but only one `isEmptyCriteria` import.

Greppable proxy for every persist site that ships criteria-shaped data:

```bash
grep -rnE 'mutate\(\s*\{[^}]*\b(criteria|valueMap|entryCriteria|triggerCriteria|stepCriteria)\b' \
  packages/frontend/src/
```

Walk every match. Verify each is wrapped in `pruneEmptyCriteria` at the
serialization boundary (not at onChange — see "Live-edit pruning" above).
Same rule applies for any other structurally-validated payload field
(payload schemas with recursive structure, JSONB columns, etc.).

The same sweep for backend persist sites:

```bash
grep -rnE '(create|update)\w*\.mutate\(' packages/frontend/src/components/admin/
```

Each `mutate` of a Criteria-bearing payload is a persist boundary. If any
hit lacks a prune, that's a finding. Precedent: PR #637 round 5 — fixed
`LookupFilterSection.handleSave` but missed `ConditionDependencySection.handleSave`
in the same file. The sweep above would have caught both.

### Cross-component effect-and-key consistency

**When you change a derived key (memo, query key, reset signal) that
gates an `useEffect`, you MUST re-walk every branch of the effect body
to confirm it still makes sense under the new key semantics.** A key
upgrade often turns defensive body code into dead complexity that
silently misses transitions the new key was supposed to enable.

PR #637 round 5 example:
- Round 2 upgraded `keyForReset` from a coarse discriminator hash
  (`$and`/`$or`/`$expr`/leaf`) to a structural-aware composition
  (`detectMode + getNestingDepth`).
- The effect body still gated transitions with conservative conditions
  ("only auto-switch INTO expression / INTO nested-from-simple") that
  made sense under the old coarse key but now silently dropped legitimate
  transitions (expression→simple, nested→simple) under the new key.

When auditing a reset-key change, write the (key-change × current-state ×
detected-state) cross-product table for the gated effect and verify each
cell is handled. This is the same pattern as
`.claude/agents/auditor.md` dimension 1 (state × input cross-product) —
applied to derived-key changes.

### Stateful-harness tests for controlled components

**A test that mounts a controlled component with a hard-coded `value` prop
and an `onChange={vi.fn()}` is half a test.** It verifies the component
renders the input correctly, but says nothing about the round-trip: what
the user sees AFTER their interaction's `onChange` flows back through
parent state and re-renders the component.

The live-prune regression in PR #637 round 4 shipped because:

- The CriteriaBuilder test mounted with controlled `value` + spy `onChange`,
  passed.
- The pruneEmptyCriteria pure-function test verified the transform, passed.
- The integration — "consumer prunes in onChange, builder re-renders with
  the pruned value" — was never tested. The placeholder row vanished
  silently.

For every controlled component that takes `value` + `onChange`, write at
least one test using a stateful harness:

```tsx
function StatefulHarness({ initial }: { initial: T | null }) {
  const [v, setV] = useState<T | null>(initial);
  return <ControlledComponent value={v} onChange={setV} {...} />;
}

it('Add condition keeps the new row visible after the onChange round-trip', () => {
  render(<StatefulHarness initial={null} />);
  fireEvent.click(screen.getByRole('button', { name: /Add condition/i }));
  // Assertion on rendered DOM AFTER state has flowed back through.
  expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0);
});
```

The harness uses real React state (no transformation). If a future refactor
moves a transform into a consumer's `onChange`, the round-trip catches it.

A complementary "regression-mimic" test documents the failure mode by
explicitly wiring up the buggy pattern in the harness and asserting the
broken outcome — the test exists to be the canary if anyone reintroduces
the pattern. See `CriteriaBuilder.test.tsx` "regression-mimic" for the
shape.

### Parametrized-fixture loops — destructure only what you use

When iterating a fixture matrix, destructure ONLY the tuple elements
the loop body actually reads. Unused bindings get flagged by CodeQL
(the repo's ESLint config doesn't catch them all):

```ts
// WRONG — `expected` is unused inside the loop body
for (const [label, input, expected] of cases) {
  it(`agrees for: ${label}`, () => {
    expect(serializerA(input)).toEqual(serializerB(input));  // no `expected`
  });
}

// RIGHT — drop the unused binding
for (const [label, input] of cases) { /* ... */ }
```

Same rule for invariant tests over a fixture (idempotence, immutability):
the fixture's `expected` field is unused there, drop it. Greppable
proxy — run after adding any new parametrized loop:

```bash
grep -rnE 'for \(const \[\w+, \w+, \w+\]' packages/frontend/src/
```

Each hit needs eyeballing: if the third element isn't read in the
loop body, change the destructure to `[label, input]`. Precedent: PR
#637 round 5 (e1af3354) added stripping in `criteria-tree-utils.test.ts`;
round 6 (230996a8) reintroduced the same shape in a new file —
CodeQL caught it on push.

### Contract-edge sweep — recursive types at every depth

**When a component consumes a recursive shared type (the `Criteria` type
allows `$expr` / `$and` / `$or` / leaf at every depth), the test fixtures
MUST cover that recursion.** Tests that only ever use the typical
single-level shape will pass while the renderer mis-handles deeper
occurrences — the `$expr`-as-leaf bug from PR #637 round 4 is the
canonical example.

Pattern: declare a fixture matrix as a parametrized test data table, and
loop over it. Each row describes one legal shape from the type's surface,
plus the expected output:

```ts
type SweepCase = [string, Criteria | null, ExpectedOutput];
const cases: SweepCase[] = [
  ['leaf at root', { status: 'Active' }, ...],
  ['$expr at root', { $expr: 'amount > 0' }, ...],
  ['$expr inside $and', { $and: [{ $expr: 'amount > 0' }] }, ...],
  ['$expr inside $or', { $or: [{ $expr: 'amount > 0' }] }, ...],
  ['$expr at depth 2', { $and: [{ $or: [{ $expr: 'amount > 0' }] }] }, ...],
  // ... every legal shape the type permits
];
for (const [label, input, expected] of cases) {
  it(`pruneEmptyCriteria: ${label}`, () => {
    expect(pruneEmptyCriteria(input)).toEqual(expected);
  });
}
```

Plus invariant tests over the same fixture: idempotence (`fn(fn(x)) === fn(x)`),
immutability (`JSON.stringify(input)` unchanged after the call), commutativity
where applicable.

### Internal navigation — `<Link>`, never `<a href="/admin/...">`

- **Internal admin routes use React Router `<Link>` (or `useNavigate`),
  never `<a href="/admin/...">`.** A bare `<a href>` causes a full page
  reload — browser discards SPA state, TanStack Query cache, Zustand
  store, auth-store impersonation context — and re-fetches everything.
  Same rule for any other internal route (`/data/...`, `/settings/...`).

  ```tsx
  // WRONG — full page reload
  <a href={`/admin/users/${user.id}`}>View</a>

  // CORRECT
  import { Link } from 'react-router-dom';
  <Link to={`/admin/users/${user.id}`}>View</Link>
  ```

- External links (`http://...`, `https://...`, `mailto:`) are fine as
  `<a href>`, and should carry `target="_blank" rel="noopener noreferrer"`
  when they point off-domain.
- Precedent: PR #500 `AdminIntegrationProviderDetailPage` shipped with
  three `<a href="/admin/...">` call-sites that lost impersonation
  state on every click.
