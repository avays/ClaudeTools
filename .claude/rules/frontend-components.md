# Frontend Component Library Conventions

## @orm/ui Package

All shared UI components live in `packages/ui/` (`@orm/ui`). **Always import
from `@orm/ui`**, not from old `@/components/ui/` paths.

```typescript
// CORRECT:
import { Button, Alert, StatusBadge, FormInput, cn } from '@orm/ui';

// WRONG (old paths — deleted):
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
```

## Storybook

24 stories with autodocs. Check here FIRST before creating new components.

```bash
pnpm --filter @orm/ui storybook    # http://localhost:6006
```

## Build Order

`@orm/shared` → `@orm/ui` → `@orm/frontend` (ui must build before frontend)

## Component Inventory (@orm/ui exports)

- **UI Primitives** — Button, Alert, StatusBadge, FormInput, FormLabel,
  CheckboxField, IconButton, PageHeader, PillPicker, MultiSelect,
  LoadingPlaceholder, SimplePagination, SectionHeader, Tabs, ToastContainer,
  DynamicIcon, InlineMessage, ReadOnlyField, FieldOrValueInput
- **Common** — ConfirmDialog, EmptyState, ErrorBoundary, LoadingSpinner
- **Table** — AdminTable, DataTable, DataTableColumnHeader, DataTableEmpty,
  DataTablePagination, DataTableToolbar, ColumnChooser, useDataTable,
  column-helpers, activeBadgeCell, apiNameCell
- **Editor** — RichEditor
- **Utilities** — cn() — conditional class merging
- **What stays in @orm/frontend (NOT in @orm/ui)** — FeatureGuard,
  SuperAdminGuard, ImpersonationBanner — depend on auth/tenant stores

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

Patterns that recur in PR review; they apply to every new component, and the
`auditor` agent runs greppable checks for each.

> **Self-audit before you push.** Run the auditor agent on your staged diff,
> or run `git diff --staged -- 'packages/ui/**' 'packages/frontend/**'`
> through the patterns in `{{PATHS_AGENTS_DIR}}/auditor.md` → "Frontend Correctness
> Patterns Checklist" — ~80% of what Copilot would flag.

### Accessibility

- **Icon-only buttons require `aria-label`** — `title` alone is hover-only and
  unreliable (`<button title="Close" aria-label="Close editor"><X /></button>`)
  — required even when a `title` is present.
- **Inputs with no visible `<FormLabel>` — placeholder-only OR label-less —
  need `aria-label`** (`aria-label={placeholder}` for the placeholder case;
  placeholders vanish on type and are announced inconsistently). **Applies to
  `<FormInput>` exactly as to raw `<input>`** — it does NOT synthesize a label
  from `placeholder`. Sweep every OTHER input in the same file (`workflow.md`
  "Sibling sweep (canonical statement)"): the sibling you didn't get flagged
  for is often worse than the one you did (a search box labeled only via
  placeholder vs. a rename box with no label at all). Precedent: PR #1209
  Copilot r1 (#1197) — the flagged search `FormInput` was placeholder-only
  while the same-file rename `FormInput` had no accessible name whatsoever.
- **A group of related radios/checkboxes needs `<fieldset>`+`<legend>` (or
  `role="radiogroup"` + `aria-label`), not a bare `<FormLabel>` heading above
  them** — a standalone label has no programmatic association, so each radio is
  announced alone, without the group name or its mutual exclusivity.
  ```tsx
  // WRONG — visually a heading, but not announced as a group
  <FormLabel>Bundle Scope</FormLabel>
  <RadioField ... /><RadioField ... />

  // CORRECT
  <fieldset>
    <legend>Bundle Scope</legend>
    <RadioField ... /><RadioField ... />
  </fieldset>
  ```
  (`PackageSubmitEditor` — PR #1195 code-audit opus r1, #1033.)
- **A state conveyed only by color or shape (a status dot, a `<Pin>` glyph)
  needs an `sr-only` text label** — mark the visual `aria-hidden="true"`, add
  `<span className="sr-only">{t('ns:key', { defaultValue: 'Unsaved changes' })}</span>`
  (register the key per "i18n fallbacks"), and sweep every surface the
  indicator renders on — list row AND overflow-menu twin, table cell AND card
  (`TabOverflowMenu`/`TabItem` — PR #1218 code-audit opus r1, #1212).

### Lifecycle timing

- **Dev-time `console.warn` / `console.error` calls live in `useEffect`, not
  in the render body** (they would fire on every re-render) — key the
  `useEffect` on the offending prop combination.

### Button semantics

- **Shared Button components must default to `type="button"`** — the HTML
  default `type="submit"` submits any enclosing `<form>` on click or Enter.
  Both `AdminEditorCard` footer buttons set it explicitly; new shared wrappers
  must too.

### Prop ↔ persisted-state drift

- **localStorage-loaded state that depends on a prop toggle must be sanitized
  when the toggle flips** — `AdminTable` with `columnVisibility={false}` but
  `{statusColumn: false}` in storage hides the column with no chooser UI to
  restore it. Apply persisted state only when the feature is enabled, else `{}`.
- **Prop flags that remove a column from the chooser must strip the
  persisted-hidden entry** — a later `alwaysVisible: true` leaves a prior
  `visibility[colId]=false` hiding it forever. Sanitize on mount / columns
  change.
- **Never use index keys (`key={idx}`) on a list whose order the user can
  change** — reorder shuffles rows but keeps the original instances at their
  position, so per-row local state silently flushes into the swapped-in row.
  Use a stable identity key (a UUID minted when the row is added, in a
  parallel `ids` array; or an id in the row). Greppable proxy: `key=\{idx\}`
  or `key=\{i\}` on a `.map((..., idx) =>` in any editor whose array supports
  drag / arrow-button reorder. (`AdminClassifierEditorPage` — #746 pass-1 F3.)

### Union-typed props — validate the shape

- **If a prop is typed as `false | { ...all-optional-fields }`, a truthy-but-
  empty object is a silent trap** — `search={{}}` on `AdminTable` enables the
  search UI but filters every row out. Require a discriminator at runtime
  (`search.accessorFn || (search.keys && search.keys.length > 0)`) + a dev
  warning on misconfiguration.

### Pagination correctness

- **When a UI exposes a pageSize selector, the data hook MUST accept pageSize
  AND include it in the query key** — missing either desyncs silently: UI says
  "25 per page", the server still returns 20, and TanStack's `pageCount` goes
  wrong.
- **Estimated totals (endpoints that don't return a real `total`) require
  an end-of-list latch.** Without one, Next stays enabled past the end. Track a
  `knownTotal` once the server returns `rows.length < pageSize` OR an empty
  overshoot, and use it for the footer total thereafter (reset on query-key
  changes).

### Column visibility / empty-row layout

- **When a table has a user-toggleable column chooser, guard against "zero
  visible columns"** — the last one hidden produces `<td colSpan={0}>` and
  breaks the empty-row layout. Refuse the toggle when only one toggleable
  column remains.

### i18n fallbacks

- **Never use `t(key) || 'fallback'` for accessible labels** — a missing
  translation returns the truthy key string, so the label renders as
  `common:nextPage`. Use
  `t('common:nextPage', { defaultValue: 'Next page' })` (#486).
- **Localize the WHOLE file in one pass, never just the string a reviewer
  named** — triggers are a presentational file moved/reused into a newly
  localized parent, and `useTranslation()` added to a page for the FIRST time
  to fix one narrow gap; either way the un-swept siblings ship a mixed-language
  surface. Grep the file's JSX for every string literal and localize them in
  the same commit. (`planView.tsx`, extracted from the unlocalized
  `PlanProgressPanel.tsx` into the localized `ConversationPlansSection.tsx` —
  PR #1196 r8–10, #1186; `ReportsPage.tsx` — PR #1205 code-audit r1–2, #1198.)
- **Every new `t('ns:key', { defaultValue: ... })` call site needs a matching
  entry in `packages/shared/src/constants/default-translations.ts`
  `DEFAULT_TRANSLATIONS`** — the key AND, for a new namespace, the namespace
  object. That constant is what `i18nService.seedAll()` writes to each tenant
  DB and what `AdminTranslationsPage` lists for translators, so an inline-only
  `defaultValue` is invisible to both; `i18n-defaultvalue.test.ts` checks only
  that a `defaultValue` is *present*, NOT that the key is registered, so the
  gap ships green and only a non-English tenant sees it. Keep
  namespace-specific strings out of `common:`. Greppable proxy — every `t()`
  namespace in source with no top-level key in the registry:
  ```bash
  comm -23 \
    <(find packages/frontend/src packages/ui/src \( -name "*.ts" -o -name "*.tsx" \) \
        -not -path "*__tests__*" -not -name "*.test.*" -not -name "*.stories.*" -print0 \
        | xargs -0 grep -hoE "\bt\('[a-z]+:[a-zA-Z][a-zA-Z0-9_]*'" \
        | sed -E "s/\bt\('([a-z]+):.*/\1/" | sort -u) \
    <(grep -E "^  [a-z]+: \{" packages/shared/src/constants/default-translations.ts \
        | sed -E "s/^  ([a-z]+): \{/\1/" | sort -u)
  ```
  Namespaces only — a missing *key* inside a registered namespace needs an
  eyeball diff against that namespace's block in `default-translations.ts`
  (PR #1205 code-audit r2/r3/r6, #1198 — three rounds, three misses; r3 and r6
  were each seeded by the previous round's own fix, so register the keys your
  fix adds, in that same commit).

### Destructive mutation re-entrancy

`frontend.md` "ConfirmDialog — re-entrancy guard" is canonical; the snippet is
duplicated here because a `packages/ui/**`-only PR (`ConfirmDialog` /
`AdminTable`'s home) never loads `frontend.md`.

- **Mutation re-entrancy guards MUST use a ref latch, not just
  `mutation.isPending`** — `isPending` doesn't flip until React Query processes
  the mutate call, so a fast double-click fires `onConfirm` twice first. Check
  for the latch on EVERY new destructive-mutation guard, not only when a
  reviewer names it (`ReportsPage` — PR #1205 code-audit r4–5, #1198).

  ```ts
  const inFlightRef = useRef(false);
  // inside onConfirm / mutate caller:
  if (inFlightRef.current || mutation.isPending) return;
  inFlightRef.current = true;
  mutation.mutate(input, {
    onSettled: () => { inFlightRef.current = false; },
  });
  ```

  Every destructive confirmation (delete, deploy, rollback) needs this;
  `AdminTable` does it internally for its built-in delete flow, hand-written
  flows must do it themselves.

- **For synchronous "no-mutation" confirms (mode switches, value collapses)
  the same race exists — even without React Query**: `setOpen(false)` only
  queues a state update, so the dialog stays mounted until the next commit,
  and clearing the latch synchronously after the handler is the trap (the
  second click sees `inFlightRef.current === false`). Keep it set across the
  close→reopen cycle and reset on the next open transition:
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
  Apply this whenever a ConfirmDialog's onConfirm both closes the dialog AND
  fires side-effects: "synchronous JS" is not "synchronous React rendering"
  (auditor dimension 3 covers React-rendering quirks). (Original
  `<CriteriaBuilder>` precedent, PR #637, deleted in the #642 redesign.)

- **The guard applies to every non-idempotent mutation handler in a component,
  not only the ones that read as "destructive"** — a create (`addStep`)
  duplicates a row on double-fire, a reorder from stale state advances one step
  instead of two. Audit ALL handlers (add, remove, reorder, reactivate, edit)
  in one pass — `workflow.md` "Sibling sweep (canonical statement)".
  (`ConversationPlansSection`, three rounds — PR #1196, #1186.)

- **Never mutate a closure variable inside a `setState` updater function and
  then read it synchronously right after the `setState` call** — the updater
  is NOT guaranteed to run synchronously at dispatch (React's eager-bailout
  optimization is skipped whenever another update to the SAME state is already
  pending, e.g. a second timer in the same tick), so the read can observe a
  stale value; invisible to any test that never queues two updates in one tick.

  ```ts
  // WRONG — shouldShowToast is set inside the updater and read right
  // after; correct only when React happens to run the updater eagerly
  let shouldShowToast = false;
  setWaitingMap((m) => {
    shouldShowToast = someCondition(m);
    return next(m);
  });
  if (shouldShowToast) toast.info('...');

  // RIGHT — compute the gate from values that don't depend on the map
  // BEFORE calling setState; the updater only transforms state
  const shouldShowToast = someCondition(); // reads refs/closures, not `m`
  setWaitingMap((m) => next(m));
  if (shouldShowToast) toast.info('...');
  ```

  If the gate genuinely depends on the PREVIOUS state (the `m` the updater
  receives) it can't be hoisted — fire the side-effect from a `useEffect`
  keyed on the resulting state instead. (`ChatPanel.tsx` cooldown timer —
  PR #1175 code-audit opus r2, #1165.)

### Shared/fallback-bucket state — attribute cleanup by owner, not by bucket membership

When per-owner scoped state (per-tab, per-conversation, per-row) keeps a shared
fallback bucket for "no owner yet" entries (a `null`/`''` key), a cleanup for
ONE owner (tab close, row delete, unmount) must NOT blanket-clear the bucket —
other still-live owners can have pending entries in it.

```ts
// WRONG — closing ANY tab drops every conversationId:null pendingOutbound
// entry, including ones that belong to a DIFFERENT, still-open fresh tab
// that also hasn't been assigned a conversationId yet
pendingOutbound: Object.fromEntries(
  Object.entries(s.pendingOutbound).filter(([, e]) => e.conversationId !== null),
),

// RIGHT — attribute the shared-bucket entry to its actual owner (an
// explicit `tabId` field written at creation time) and only drop the
// entries owned by the tab that's actually closing
pendingOutbound: Object.fromEntries(
  Object.entries(s.pendingOutbound).filter(
    ([, e]) => !(e.conversationId === null && e.tabId === closingTabId),
  ),
),
```

Add the owner-id field (`tabId`, `rowId`) at creation time rather than
assuming "only one owner uses the shared key right now" — that breaks with two
owners mid-flight, which a single-owner test never exercises. (`chatStore.ts`
`closeTab()`, fixed with `PendingOutboundMessage.tabId` — PR #1175 code-audit
sonnet r1, #1165.)

### Persisted base must track the latest save

- **When merging live state into a persisted base, update the base after each
  save** — a never-refreshed mount-time snapshot (`const base =
  persisted.current`) lets a later write overwrite the user's in-flight change.
  After `savePersisted(key, next)`, set `persistedRef.current = next`.

### Paginated data-source changes

- **When a pagination panel is reused across data sources (a drawer panel
  keyed by a selector above), reset local `page` state when the source changes
  — not just latch state (`knownTotal`)** — a stale `page` lands out-of-range
  and renders empty until the user navigates back. `pageSize` is a user
  preference and should typically persist across source changes; `page` should
  not.

  ```ts
  useEffect(() => { setPage(0); setKnownTotal(null); }, [sourceId]);
  useEffect(() => { setKnownTotal(null); }, [pageSize]);
  ```

### Pagination footer display correctness

- **Clamp the displayed page number on overshoot** (`pageIndex` past
  `pageCount - 1` renders "6 / 5") —
  `displayedPageNumber = isOvershoot ? pageCount : pageIndex + 1`.
- **Collapse the range label to `noResults` on overshoot** — else
  `start = pageIndex * pageSize + 1` exceeds `total` ("31–25 of 25").

### Storybook stories as reference material

- **Stories are copy-paste starting points — they must model the recurring
  rules.** A story's raw `<button>` MUST carry `aria-label` and
  `type="button"`; a `CheckboxField` demo MUST use the boolean `onChange`
  signature (`(checked) => ...`). Reviewers flag story violations at production
  severity.

### Validate the value you submit

- **Run input validation on the normalized (trimmed, coerced) value, and
  submit that same value** — `if (!input) fail; submit(input.trim())` lets
  whitespace-only input pass validation and submit empty.
- **A text `<FormInput>` bound to a backend field with a Zod `.max(N)` MUST
  carry `maxLength={N}`** — otherwise the cap surfaces only on save via an
  error toast, or (for a search query param) a silent 400 rendering an empty
  list. Mirror the schema: `UpdateConversationSchema.title.max(200)` and
  `PaginationQuerySchema` search `.max(200)` → `maxLength={200}`. Fixing the
  trim OR the `maxLength` on one input means walking EVERY other input in the
  file (`workflow.md` "Sibling sweep (canonical statement)") — PR #1209
  Copilot r4 (#1197).

### Async ownership guards — clear the flag on the failure path, not just success

- **A ref/flag claiming ownership of a shared UI resource (scroll position,
  focus, a "this effect owns the next layout pass" latch) before an async
  operation MUST be cleared on that operation's FAILURE path too** — a stuck
  flag suppresses every downstream "does someone else own this?" check for the
  component's life, silently breaking initial-anchor, re-pin and resize.
- **With TanStack Query's `fetchNextPage()` this needs BOTH a result check and
  a `.catch`** — it typically RESOLVES with `{ isError: true }` rather than
  rejecting, so a bare `.catch` alone misses the common failure mode. Check
  `result.isError` (clears on server error) AND keep a `.catch` (clears on
  cancellation-style rejection):
  ```ts
  const handleLoadEarlier = () => {
    prependScrollOwnerRef.current = true;           // claim ownership
    fetchNextPage()
      .then((result) => { if (result.isError) prependScrollOwnerRef.current = false; })
      .catch(() => { prependScrollOwnerRef.current = false; });
  };
  ```
- Add a load-bearing regression test that fails when the clear is removed
  (guard released and re-pin effect fires after a simulated fetch failure).
  (`handleLoadEarlier`/`prependScrollHeightRef` — PR #1209 Copilot r5, #1197.)

### Backend `pageSize` caps — read before hardcoding

- **Before hardcoding a fetch `pageSize` larger than the hook default, read
  the backend Zod schema's `.max()`** — integrations-style domains cap at 100
  (`ListProvidersQuerySchema`, `ListConnectionsQuerySchema` in
  `integrations.routes.ts`) and a larger value silently 400s with an empty
  page. Instead: (a) confirm the cap permits it, (b) switch to server-mode
  pagination via `AdminTable` `pagination={{ mode: 'server', ... }}`, or (c)
  use a single-entity hook (`useX(id)`). (`pageSize=500` — PR #500.)

### Localized-label search — always `accessorFn`, never `keys`

- **When a record has `label: Record<string, string>`,
  `search={{ keys: ['label'], ... }}` on `AdminTable` stringifies to
  `[object Object]` and matches nothing** (the client filter runs
  `String(row[key])`). Join the string values explicitly:
  ```ts
  search={{
    accessorFn: (row) =>
      [row.apiName, ...Object.values(row.label ?? {}).filter(
        (v): v is string => typeof v === 'string',
      )].join(' '),
    placeholder: 'Search xs…',
  }}
  ```
  (Channels, IntegrationProviders, AdminProviders — PR #500.)

### Routed editor route shape — one `:id`, `'new'` signals create

- **Never ship both a static `xxx/new` route AND an `xxx/:id` route
  together** — React Router matches static paths first, so
  `useParams<{ id: string }>()` on `/admin/xxx/new` returns `id === undefined`,
  not `'new'`, making create unreachable on any page that treats `!id` as an
  error.
- **Correct pattern:** a single `:id` route where `id === 'new'` signals
  create, matching the flows / layouts / objects convention:
  ```tsx
  const { id } = useParams<{ id: string }>();
  const isNew = !id || id === 'new';
  const { data: record, isLoading } = useRecord(isNew ? undefined : id);
  if (!isNew && isLoading) return <LoadingPlaceholder ... />;
  ```
  (`groups/new` + `groups/:id`, masked by an "Invalid URL" guard — PR #508,
  #505.)

### Auto-generated `apiName` must start with a letter

- **`labelToApiName`-style helpers must output `^[A-Za-z][A-Za-z0-9_]*$` even
  when the label starts with a digit** — a `_digit` prefix still fails the
  backend Zod schema. Use a fixed entity-scoped letter prefix:
  ```ts
  return /^[A-Za-z]/.test(sanitized) ? sanitized : `g_${sanitized}`;
  ```
  (`GroupEditor` used `_${digit}`; `CreateGroupSchema` rejects it — PR #508.)

### Form-field completeness across create + update

- **If an editor exposes form field X, both the create and update mutation
  payloads must include X** — else a silent-save bug (UI shows success, the
  next refetch reverts the edit). Diff `createMutation.mutate(input)` against
  `updateMutation.mutate({ id, input })` field-by-field.
  (`AdminListViewsPage` `viewType`/`viewConfig` — PR #508.)

### Atomic multi-mutation toggles — chain via `onSuccess`

- **When a single UI action requires two dependent mutations (e.g. "set new
  default" requires "clear old default"), chain them via `onSuccess`** —
  parallel firing with no backend uniqueness enforcement risks inconsistency.
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
  (`AdminListViewsPage.handleSetDefault` — PR #508.)

### Single-entity hooks over list-then-find

- **Prefer `useX(id)` over `useXs().find((x) => x.id === id)` in routed detail
  pages** — find false-404s when the record isn't on the first list page, and
  loads N rows to look up 1. When `GET /api/v1/admin/xs/:id` exists, add the
  hook. (PR #500 audit flagged `AdminIntegrationProviderDetailPage` using
  `useIntegrationProviders(1, 500).find(id)` → `useIntegrationProvider(apiName)`;
  PR #508 repeated it on `AdminGroupEditorPage` → `useGroup(id)`.)

### Expensive preview/aggregate endpoints stay gated behind explicit user action

- **A multi-query preview or aggregate endpoint (built to run inside a confirm
  dialog, e.g. "N rows will be affected") must not be called eagerly on page
  mount just to gate a button's visibility** — a `useXPreview(id)` hook is for
  the rare case (dialog opened, `enabled: open`).
- **Prefer a cheap signal that's already loaded** — if the page's own
  `useX(id)` response carries a count/flag (`userCount`, `recordCount`, or a
  lightweight `objectCount` worth adding to that response), gate on that and
  reserve the preview fetch for when the dialog opens.
  (`{{PATHS_SPECS_DIR}}/tenant-purge-delete-cascade.md` (#1162) spec-audit r3 — an eager
  purge preview meant ~114 sequential COUNTs per `TenantDetailPage` mount.)

### Tailwind important modifier — prefix form

- **Use `!pl-9` (prefix), not `pl-9!` (suffix), when overriding a base CSS
  reset** — Tailwind v4 accepts both; this repo's convention is the prefix form
  (`packages/frontend/src/components/layout/GlobalSearch.tsx`,
  `packages/frontend/src/components/admin/IconPicker.tsx`). The `tokens.css`
  reset (`packages/ui/src/styles/tokens.css:69-84`) targets every common
  `input[type="..."]` at attribute-selector specificity, which utilities
  without `!` can't override. (`AdminTableToolbar` — PR #500 Copilot r5.)

### Mutations missing `onError`

- **Every `.mutate(data, { onSuccess: ... })` must also have an `onError`** —
  without one a failed mutation strands the user on a stuck editor, no toast,
  no signal. For branching across several error codes use `useApiErrorToast`
  (`packages/frontend/src/hooks/useApiErrorToast.ts`); otherwise inline:

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

- Greppable: a `.mutate(` with `onSuccess` present but no `onError` in the
  same options object. Audit sweep lives in
  `{{PATHS_SKILLS_DIR}}/audit-phase/SKILL.md`.

### Live-edit pruning vs save-time pruning

**Never run normalization / pruning / validation transforms inside a
controlled component's `onChange` callback unless the transform is a true
no-op for in-progress edits** — transforms stripping "empty" placeholders
delete the row the user just added, and the next render looks like nothing
happened. The trap pattern (PR #637 r4):

```tsx
// WRONG — placeholder row vanishes the moment the user clicks "Add"
function pushCriteria(next: Criteria) {
  // pruneEmptyCriteria turns `{$and:[{}]}` (the just-added placeholder)
  // into `null`, parent state becomes null, builder re-renders empty.
  onChange({ triggerCriteria: pruneEmptyCriteria(next) });
}
```

Live edits pass through unchanged; pruning / normalization / serialization
happens exactly once at the **persistence boundary** — same shape rule as
`{{PATHS_RULES_DIR}}/frontend.md` "API paths" and `delete-lifecycle.md`: boundary
code does the boundary work.

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
component with a structured value) whose `onChange` wraps the incoming value in
a transform is a finding — the transform belongs ONLY in the save serializer.
**`<CriteriaLogicEditor>` (#662) follows the same rule:** on Save it calls
`onChange(newTree)` with the restructured tree, no pruning.

### Persist-boundary sweep — find every save site, not just one

**When a file owns multiple sub-components or multiple save handlers, an
import-level sweep is incomplete** — a grep for `isEmptyCriteria` finds every
read, not every write site needing the companion `pruneEmptyCriteria`. Proxies:

```bash
grep -rnE 'mutate\(\s*\{[^}]*\b(criteria|valueMap|entryCriteria|triggerCriteria|stepCriteria)\b' \
  packages/frontend/src/
```

```bash
grep -rnE '(create|update)\w*\.mutate\(' packages/frontend/src/components/admin/
```

Walk every match: each `mutate` of a Criteria-bearing payload is a persist
boundary, and any hit lacking a prune at the serialization boundary (not at
onChange) is a finding. Same for any structurally-validated payload field
(recursive payload schemas, JSONB columns). (PR #637 r5 fixed
`LookupFilterSection.handleSave`, missed `ConditionDependencySection.handleSave`
in the same file.)

### Cross-component effect-and-key consistency

**When you change a derived key (memo, query key, reset signal) that gates a
`useEffect`, you MUST re-walk every branch of the effect body to confirm it
still makes sense under the new key semantics** — a key upgrade often leaves
defensive body code that silently misses the very transitions the new key was
meant to enable. Write the (key-change × current-state × detected-state)
cross-product table and verify each cell — `{{PATHS_AGENTS_DIR}}/auditor.md`
dimension 1. (`keyForReset` upgraded to `detectMode + getNestingDepth` while
the body's conservative gates still dropped expression→simple and
nested→simple — PR #637 r5.)

**The same re-walk applies when you BROADEN a dep array on a side-effecting
effect — especially one that moves focus**: it now fires in states it never
ran for, so every element that can hold focus (or scroll/selection) under the
NEW trigger must be re-walked, not just the case the new dep was added for —
fixing the case you noticed can regress a sibling case the broadened trigger
now also reaches (`workflow.md` "Sibling sweep (canonical statement)").
Enumerate every such element in the effect's scope, confirm behavior in each,
and add a stateful-harness regression test (below) for the sibling case,
verified load-bearing. (PR
#1180, #1168 — a `role="listbox"` effect gained `conversations.length` for a
same-index row delete; the dep also grows on "Load more", yanking focus off
that button. Fixed by guarding the restore on `document.activeElement` — skip
when focus sits on a non-row listbox child, `role !== 'option'` and not
`<body>`.)

### Stateful-harness tests for controlled components

**A test that mounts a controlled component with a hard-coded `value` prop and
an `onChange={vi.fn()}` is half a test** — it says nothing about the
round-trip: what the user sees AFTER `onChange` flows back through parent
state and re-renders. (The live-prune regression, PR #637 r4, shipped there:
controlled-value test green, `pruneEmptyCriteria` unit test green, integration
untested.) Every controlled `value` + `onChange` component needs at least one
real-React-state harness test:

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

A complementary "regression-mimic" test wires the buggy pattern into the
harness and asserts the broken outcome — the canary if anyone reintroduces it
(`CriteriaBuilder.test.tsx` "regression-mimic").

### Parametrized-fixture loops — destructure only what you use

When iterating a fixture matrix, destructure ONLY the tuple elements the loop
body reads — unused bindings get flagged by CodeQL (ESLint doesn't catch them
all). Same for invariant tests over a fixture (idempotence, immutability):
the `expected` field is unused there, drop it.

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

Greppable proxy — run after adding any new parametrized loop:

```bash
grep -rnE 'for \(const \[\w+, \w+, \w+\]' packages/frontend/src/
```

If the third element isn't read in the loop body, change the destructure to
`[label, input]`. (PR #637 r5 (e1af3354) added stripping in
`criteria-tree-utils.test.ts`; r6 (230996a8) reintroduced it in a new file.)

### Contract-edge sweep — recursive types at every depth

**When a component consumes a recursive shared type (the `Criteria` type
allows `$expr` / `$and` / `$or` / leaf at every depth), the test fixtures MUST
cover that recursion** — single-level fixtures pass while the renderer
mis-handles deeper occurrences (the `$expr`-as-leaf bug, PR #637 r4). Declare
a parametrized data table, one row per legal shape:

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
immutability (`JSON.stringify(input)` unchanged after the call), and
commutativity where applicable.

### Internal navigation — `<Link>`, never `<a href="/admin/...">`

- **Internal admin routes use React Router `<Link>` (or `useNavigate`), never
  `<a href="/admin/...">`** — a bare `<a href>` full-page-reloads, discarding
  SPA state, TanStack Query cache, Zustand store and auth-store impersonation
  context. Same for any internal route (`/data/...`, `/settings/...`).

  ```tsx
  // WRONG — full page reload
  <a href={`/admin/users/${user.id}`}>View</a>

  // CORRECT
  import { Link } from 'react-router-dom';
  <Link to={`/admin/users/${user.id}`}>View</Link>
  ```

- External links (`http://...`, `https://...`, `mailto:`) are fine as
  `<a href>`, and should carry `target="_blank" rel="noopener noreferrer"`
  when off-domain. (`AdminIntegrationProviderDetailPage` lost impersonation
  state on three such call-sites — PR #500.)

### Overlapping absolutely-positioned interactive elements — sweep the full state cross-product (#1166)

When a component adds a new absolutely-positioned interactive element (drag
handle, resize grip, floating badge) over other interactive children,
enumerate every pair that can occupy the same visual space across every
reachable *combination* of the component's independent boolean/enum props
(dock position, panel mode, sub-panel toggles) and verify each pair's hit
areas are geometrically disjoint (or correctly z-stacked) in every one —
fixing the ONE pair you noticed is not enough. CSS stacking rules apply
per-pair: a fix for pair A doesn't make pair B safe, a conditional gate for
pair A can leave a stale un-narrowed offset on pair B, and pair C (two NEW
handles added in the same change) stays unexamined.

Checklist before shipping a new overlapping absolute-positioned element:
1. List every interactive sibling within the same containing block.
2. For each pair, compute the hit-area rectangles (x/y ranges) under every
   reachable prop-combination, not just the default one.
3. Any two rectangles that intersect under a reachable combination need
   either a disjoint-geometry fix (narrow one rect's range) or an explicit
   z-order justification — plus a regression test asserting the non-overlap
   for that specific combination.
4. When a later fix narrows one element's geometry conditionally, re-walk
   every OTHER sibling that shares the same conditional trigger — a stale,
   un-narrowed offset on a sibling is the same bug recurring, not a
   separate one.

Precedent: `{{PATHS_SPECS_DIR}}/chat-panel-drag-resize.md` (#1166, PR #1176) — four
separate spec-audit rounds surfaced the SAME defect class on one spec: the
floating move-grip covering the header's "Back to chat" button when
`showHistory` is true (r2); the width-resize handle's `top-12` offset left
stale after the grip was gated on `!showHistory` (r3); and the width-resize
handle overlapping the height-resize handle at the floating panel's
bottom-left corner — introduced by the SAME sub-phase that fixed the first
two, and never swept (r4).

### Focus handoff when the focused element unmounts — roving-focus menus/panels (#1212)

When a component removes the DOM node holding focus — a `role="menu"` panel
closing, a list row deleted, a container collapsing — the browser drops focus
to `<body>`, destroying a keyboard-only user's place on the page. Any
close/delete/collapse path in a roving-focus (`tabIndex={-1}` items) menu,
dropdown or panel MUST explicitly hand focus back to a surviving focusable
element (the trigger, the nearest surviving sibling row, or the parent
list/tablist). Walk EVERY way the focused node can disappear and confirm each
lands focus somewhere real. The sub-rules:

1. **Enumerate every teardown path, not just the one you built the feature
   for.** Focus can leave via: Escape, Tab out, item activation (Enter/click),
   per-item delete (Delete/Backspace or a close-X), click-outside, AND a
   *prop-driven unmount* where the parent stops rendering the component
   because its data emptied (e.g. a ResizeObserver widen collapses the
   overflow set to 0). The last one has no event handler at all — it needs a
   cleanup `useEffect` (or a parent-side rescue armed on the empty transition)
   that hands focus off when the component unmounts while focus was inside it.
   Fixing only the delete path and missing the resize-unmount path (or vice
   versa) leaves the same focus-to-`<body>` bug reachable another way.

2. **A focus-snapshot ref armed before an async/store update must be cleared
   on EVERY close path, and must not assume the update it predicted actually
   happened.** A `pendingRefocusRef` set before calling `onCloseTab` (to
   refocus a surviving row once the re-render lands) becomes a stale-index
   time-bomb if: the close is aborted (a dirty-tab confirm the user cancels —
   the store never changes, the length-keyed effect never fires, the ref stays
   armed and fires on the NEXT unrelated length change); the menu closes via a
   different path (click-outside / Escape / Tab) before the effect runs; or the
   delete collapses the list by MORE than one item (deleting one row can make
   the rest fit and empty the overflow entirely). Store the *expected*
   post-change length alongside the index and only act when reality matches
   (`if (len === expectedLen) refocus(); else clear()`), OR fire an
   `onEmptied()` handoff on every confirmed close and let a parent effect gated
   on `length === 0` own the empty case — never predict "this removes exactly
   one, so length-1===0 means empty."

3. **A boolean "did it happen" return that gates focus handoff must reflect the
   actual mutation, not merely reaching the end of the handler.** A
   `handleClose` that returns `true` even when the underlying `closeTab` was a
   no-op (tab pinned, id not found, dirty-confirm cancelled) makes the menu arm
   refocus / call `onEmptied` when nothing changed. Return `false` (or the real
   outcome) on every no-op branch so downstream focus logic doesn't act on a
   phantom change.

4. **Guard roving-focus index arithmetic against the empty-list transition.**
   ArrowUp/ArrowDown `% count` and `itemRefs.current[count - 1]` (End/Home) blow
   up (`% 0`, index `-1`) if the menu is briefly still mounted with
   `count === 0` before the auto-close effect runs. Early-return the key handler
   when `count === 0`.

Pattern shape to copy: `packages/frontend/src/components/ai/ModeSelector.tsx`
(`ModeDropdown`) — one `onKeyDown` on the `role="menu"` container handling
Arrow/Home/End/Escape via bubbling, plus `close(returnFocus: boolean)` called
with `true` from BOTH Escape and every item activation so focus always returns
to the trigger. The class recurred across ~8 rounds of PR #1218 (#1212) —
spec-audit sonnet r2–3, spec-audit opus r1–2, code-audit opus r5
(keyboard-Delete AND mouse close-X collapse-to-empty), and Copilot r1 and r3
(stale `pendingRefocusRef` on click-outside; resize-driven unmount) — each a
different teardown path reaching the same drop-to-`<body>` failure.
