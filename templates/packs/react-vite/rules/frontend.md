---
globs:
  - "packages/frontend/**"
---

# Frontend Conventions

## Stack

- React 19 + Vite 6 + TypeScript (strict); Tailwind CSS v4 with CSS
  custom property design tokens
- TanStack Query for server state, Zustand for client state
- Consumes `@orm/shared` for types and validation schemas

## Style Guide

- **All visual styling MUST follow [STYLE_GUIDE.md](../../{{PATHS_CONTEXT_DIR}}/STYLE_GUIDE.md)**
- Semantic color tokens (`bg-brand`, `text-text-primary`,
  `bg-status-error-subtle`) — never raw Tailwind color scales
- `<Button>` from `components/ui/Button.tsx` — never inline button styles
- Border radius: `rounded-lg` controls, `rounded-xl` cards/modals; Inter
  (sans) + JetBrains Mono (mono) via `@theme` in `index.css`
- Borders provide structure, not shadows — only `shadow-lg` on dropdowns,
  `shadow-xl` on modals

## Patterns

- All API calls through the typed HTTP client (`lib/api.ts`); it handles
  auth tokens and the `X-Tenant-ID` header automatically
- Form validation uses the same Zod schemas as the backend
- Named exports only (no default exports); `import type` for type-only
  imports

## API paths — NEVER include `/api/v1`

`ApiClient.baseUrl` defaults to `API_BASE_URL` = `/api/v1` (see
`packages/frontend/src/lib/config.ts`). Every `api.get / api.post /
api.patch / api.del / api.getWithMeta` call MUST use a path that starts
AFTER the `/api/v1` prefix — otherwise the request ships as
`/api/v1/api/v1/...` and 404s on every default setup.

```typescript
// WRONG — double-prefix, 404 in production
api.get('/api/v1/records/.../containers/summary');

// CORRECT
api.get('/records/.../containers/summary');
```

Every other hook in this repo (see `useApproval*`, `useIntegrations`,
`useAdmin`, etc.) uses relative paths. A hook file using `/api/v1/...`
absolute paths is a review-stopper (PR #485 r3 — four call sites in one
hook). Grep your own changes:

```bash
grep -rn "/api/v1/" packages/frontend/src/hooks/ packages/frontend/src/components/
# any match in a newly-written file is a bug
```

## Component Conventions

- `cn()` from `lib/utils.ts` for conditional class merging; Lucide React
  icons (`h-4 w-4` inline, `h-5 w-5` navigation);
  `@fontsource-variable/inter` + `@fontsource/jetbrains-mono` (self-hosted)
- Native `<dialog>` for record-level modals only (RecordModal, CloneDialog,
  ChangeOwnerDialog, ConfirmDialog, InstallPreviewDialog —
  preview/confirm flow, not an editor)
- **React event types are type-only imports, not the bare `React.X` global
  namespace (#1166).** `import type { KeyboardEvent as ReactKeyboardEvent }
  from 'react';` (mirroring the existing `PointerEvent as
  ReactPointerEvent` pattern for pointer handlers), never
  `React.KeyboardEvent<...>` — the bare global form typechecks today only
  because `@types/react` still declares a UMD `React` namespace. When you
  fix a source file, sweep its matching test file — a hook's `.test.ts`
  casting synthetic events the same way needs the identical import change.
  Precedent: `useDragPanel.ts`/`useResizePanel.ts` (PR #1176, #1166) fixed
  r1; `useDragPanel.test.ts`'s five identical casts weren't swept until r2.
- **`useEffect` unmount cleanups run in forward (declaration) order, NOT
  reverse.** For two sibling `useEffect`s in the same function component,
  the FIRST-declared effect's cleanup fires before the SECOND-declared's
  on unmount. React's docs don't specify the intra-component order and
  reviewers regularly assert the reverse, so this repo CI-pins its own
  React version's observed behavior in
  `packages/frontend/src/__tests__/useeffect-cleanup-order.test.tsx` —
  cite that test instead of re-litigating (if a React upgrade flips it,
  update this bullet in the same PR). Never justify declaration order by
  claiming reverse-order cleanups; and regardless of direction, correctness
  must NEVER depend on sibling-cleanup ordering — make any dependency
  explicit (a parameter, a render-assigned ref both effects read).
  Precedents: `{{PATHS_SPECS_DIR}}/chat-send-audit-fixes.md` spec-audit r2
  (PR #1181, #1167 — a spec's reverse-order rationale was factually wrong;
  correctness carried by an explicit `excludeId` param) and Copilot r3 (a
  reviewer asserted reverse order against this rule; the probe re-proved
  forward, but `useAIChat`'s rebind-vs-unmount discriminator was still
  rewritten order-independent — captured `subscribedIdsKey` vs the
  render-assigned `latestSubscribedIdsRef` — because the
  registry-membership check it replaced genuinely leaned on cleanup order).
- **Lazy-init a `useRef` whose initial value is expensive or
  non-idempotent** (`crypto.randomUUID()`, `Date.now()`) — naive
  `useRef(crypto.randomUUID())` evaluates the call on EVERY render (React
  keeps only the first result), wasted work on any component that
  re-renders often. Use `const ref = useRef<string>(''); if (!ref.current)
  ref.current = crypto.randomUUID();` in the render body, or `useId()`
  when a stable per-instance id is all that's needed. Precedent:
  `useConversationSubscription` (PR #1181, #1167).

## Admin Page Pattern (IMPORTANT)

Admin list pages MUST conform to this contract — architectural tests in
`packages/frontend/src/__tests__/admin-architecture.test.ts` enforce it; a
violation fails CI.

> **⚠️ Pattern 2 (inline editor card) is DEPRECATED and being removed
> (#832).** Do NOT add a new inline editor card / inline create-edit form
> below a list table. All admin create/edit MUST use a **routed editor
> page** (Pattern 1). Rule 7 of the architecture test fails CI for any
> list page rendering an inline editor outside the shrinking
> `INLINE_EDITOR_ALLOWLIST` migration snapshot. The Pattern-2 prose below
> is retained only until the in-flight migration completes, then removed.

- **Pattern 1 — Routed editor page** (the only sanctioned pattern): row
  click + "New" button both `navigate()` to a dedicated URL. The editor
  page reads params (`isNew = id === 'new'`), breadcrumbs back to the
  list, and navigates on save/cancel. Structure: list page uses
  `AdminTable` only; editor page lives at a single `path: 'xxx/:id'` route
  (`id === 'new'` signals create — see frontend-components.md "Routed
  editor route shape"). Examples: Objects, Flows, Apps, Custom Pages,
  Global Picklists, Profiles, Permission Sets, Record Types, AI Agents.
- **Pattern 2 — Inline editor card below the table** *(DEPRECATED — #832;
  do not use for new work)*: row click / edit callback opens an inline
  editor card rendered under the table. Being migrated to Pattern 1.

### Shared structure (both patterns)

```
PageHeader (title, subtitle, primaryAction=handleCreate|navigate('.../new'))
  └─ AdminTable (data, columns, pagination, search, onEdit, onDelete)
  └─ (Pattern 2 only) {editorOpen && <XxxEditor editingItem onSave onClose isSaving />}
```

### Shared primitives (all from `@orm/ui` unless noted)

- **`AdminTable`** — the single admin-table primitive: opt-in `pagination`
  (client or server), `search`, `columnVisibility`, `density`, `toolbar`
  slot, `storageKey` persistence, `stickyHeader`; built-in
  `onView`/`onEdit`/`onDelete` row actions + `ConfirmDialog` for deletes.
- **`AdminEditorCard`** — structural wrapper (title + close X + content
  slot + save/cancel footer) for the inline editor card. Every inline
  editor uses it for identical chrome.
- **`useEditorState<T>()`** (`packages/frontend/src/hooks/useEditorState.ts`)
  — manages `editorOpen`, `editingItem`, `handleCreate`, `handleEdit`,
  `handleClose`.
- **`useApiErrorToast(map, fallback?)`**
  (`packages/frontend/src/hooks/useApiErrorToast.ts`) — structured
  `ApiError.code` branching for mutation `onError`.
- **Cell helpers** — `activeBadgeCell`, `apiNameCell`, `dateCell`,
  `shortDateCell`, `userCell`, `badgeListCell`, `makeBadgeListCell`.

### Rules (enforced)

1. **No raw `<table>`** in `pages/Admin*.tsx` — use `AdminTable`.
   Non-list tables (diff previews, spreadsheet editors) may be allowlisted
   in `admin-architecture-allowlist.ts` with a reason comment.
2. **No `err.message.match/includes/startsWith`** in delete/mutation
   handlers — branch on `ApiError.code` via `useApiErrorToast`.
3. **No `<dialog>`** for admin create/edit — inline editor card (via
   `AdminEditorCard`) or routed editor page. Non-CRUD dialogs (confirm,
   detail view, import) may be allowlisted OR the file may re-export
   `ADMIN_EDITOR_APPROVED = true` (escape hatch for genuinely modal
   flows).

### Rules (conventional; not auto-enforced yet)

4. **Use `useEditorState<T>()`**, not ad-hoc `useState` pairs.
5. **Editor is a named exported component** in its own file (e.g.
   `components/admin/XxxEditor.tsx`), not inline in the page.
6. **Form state is a single object** (`useState<FormState>`), not N scalar
   hooks.
7. **Every non-idempotent mutation handler is re-entrancy guarded with a
   ref latch** — see "ConfirmDialog — re-entrancy guard" below;
   `isPending` alone is NOT sufficient.
8. **Empty/loading UI uses `EmptyState`** (or `emptyMessage={{ title,
   description, action }}` on AdminTable), not hand-rolled `<div>`s.
9. **No page-replace detail views** — never `if (selectedId) return
   <Editor />` mid-component; heavyweight editors get a routed page
   (`/admin/{entity}/:id`).

Reference implementations: `AdminValidationRulesPage` +
`ValidationRuleEditor` (gold standard, inline editor — Pattern 2 form),
`AdminSecretsPage` + `SecretEditor` (inline editor),
`AdminGlobalPicklistsPage` (list with routed detail editor),
`AdminWebhooksPage` (tabbed list via `AdminEditorCard`). Routed editors:
Flows, Layouts, CustomPages, Objects, Apps, GlobalPicklists; moving routed
(#486 Batch A): Profiles, PermissionSets, RecordTypes, Webhooks — their
list pages still conform to the contract above.

## Error handling — structured, not regex

When a mutation's `onError` needs different copy per failure mode, **branch
on `ApiError.status` and `ApiError.code`, never regex the message text** —
backend copy can change; `code` is the stable contract. This requires the
backend to throw `new PlatformError('FOO_IS_SYSTEM', msg, 409)` rather
than a generic `ConflictError` (see `{{PATHS_RULES_DIR}}/delete-lifecycle.md`).

Prefer `useApiErrorToast` (#537) from
`packages/frontend/src/hooks/useApiErrorToast.ts`, typed against
`ErrorCode` from `@orm/shared` — map keys are checked against the central
registry by `error-toast-registry.test.ts`; a typo (`PROFLIE_IS_SYSTEM`
vs `PROFILE_IS_SYSTEM`) fails CI.

```typescript
import { useApiErrorToast } from '@/hooks/useApiErrorToast';

const handleDeleteError = useApiErrorToast(
  {
    PROFILE_IS_SYSTEM: 'Cannot delete a system profile.',
    PROFILE_IN_USE: 'Cannot delete — users are still assigned. Reassign first.',
  },
  'Failed to delete profile.',
);

deleteProfile.mutate(target.id, { onError: handleDeleteError });
```

Add the corresponding code to
`packages/shared/src/constants/error-codes.ts` when the backend throws a
new `PlatformError` code. Default copy reused across components lives in
`packages/frontend/src/lib/errorCopy.ts` (`DEFAULT_ERROR_COPY`). Where a
one-off inline branch is used instead, it must still branch on `code` —
never `err.message.match(/regex/)`; future copy edits silently break the
UX:

```typescript
import { ApiError } from '@/lib/api';

deleteFoo.mutate(target.id, {
  onError: (err: unknown) => {
    if (err instanceof ApiError && err.status === 409) {
      if (err.code === 'FOO_IS_SYSTEM') return toastError('Cannot delete a system foo.');
      if (err.code === 'FOO_IN_USE')    return toastError('Cannot delete — foo is in use.');
    }
    toastError(err instanceof Error ? err.message : 'Failed to delete foo.');
  },
});
```

## Self-identity under impersonation

When hiding UI affordances for the current user (e.g. deactivate button on
your own row), the effective identity during impersonation is
`authStore.impersonation.targetUser.id`, NOT `authStore.user.id` — the
access token switches to the target while `user` remains the original
admin.

```typescript
// WRONG — during impersonation this is the original admin
const currentUserId = useAuthStore((s) => s.user?.id);

// CORRECT — impersonated identity when active, falls back otherwise
const currentUserId = useAuthStore(
  (s) => s.impersonation?.targetUser.id ?? s.user?.id,
);
```

Getting this wrong lets the impersonator deactivate the user they're
acting as, and hides the button on their own row outside impersonation.
Fixed in #422; don't reintroduce.

## ConfirmDialog — re-entrancy guard

`ConfirmDialog` does NOT disable its own confirm button while async work
runs, and setting state inside the same synchronous click handler does NOT
prevent a second fire — React batches state updates until after the
handler returns. `mutation.isPending` alone is ALSO not sufficient: it
doesn't flip until React Query processes the mutate call, so a fast
double-click fires `onConfirm` twice before the flip propagates. **The
reliable guard is a ref latch combined with the `isPending` check:**

```tsx
const inFlightRef = useRef(false);

<ConfirmDialog
  open={!!deleteTarget}
  onConfirm={() => {
    if (!deleteTarget) return;
    if (inFlightRef.current || mutation.isPending) return;  // ← ref latch
    inFlightRef.current = true;
    const target = deleteTarget;
    setDeleteTarget(null);                                  // close dialog
    mutation.mutate(target.id, {
      onSettled: () => { inFlightRef.current = false; },
    });
  }}
  ...
/>
```

This guard applies to EVERY non-idempotent mutation handler (create,
reorder, reactivate — not only "destructive" ones), and to synchronous
no-mutation confirms; see `frontend-components.md` "Destructive mutation
re-entrancy" for the sync-confirm variant, the multi-handler sibling
sweep, and the setState-updater trap. Precedent: PR #1205 (#1198) r4
added an `isPending`-only guard; r5 caught that it still needed the ref
latch.

## CSS containment (`container-type` / `contain:`) creates a stacking context AND a containing block — sweep both consequences

Adding `container-type: inline-size` (Tailwind `@container`) or any
`contain:` value implying layout containment to a shared layout element
(header, sidebar, panel) has TWO coequal consequences — fixing only the
one you noticed leaves the other as a reachable regression. Precedent:
#1219 (PR #1221) — the header spec caught the containing-block consequence
(portaled `PendingMutationsTray`) but its first stacking mitigation pinned
the header at `z-50`, regressing every sibling `z-40`-backdrop/`z-50`-panel
overlay app-wide across two spec-audit rounds (the `z-30` docked tier was
a third); resolved by `z-20` + enumerating all three tiers:

1. **The element becomes the containing block for `position: fixed`
   descendants** — any fixed-position overlay opened from inside it
   positions relative to the contained box, not the viewport. Fix:
   **portal the overlay to `document.body`**.
2. **The element establishes a NEW STACKING CONTEXT** (CSS Containment
   §2.2) — its internal `z-50` popovers are trapped in its atomic layer,
   whose implicit z-index is `auto` (~0) at root. Before setting an
   explicit z-index to restore its layer, **sweep the app-wide overlay
   z-index tiers and pick a value that clears real page content but stays
   BELOW the overlay tiers that are meant to cover it:**
   - `fixed inset-0 z-40` backdrop + `z-50` panel — full-screen overlays
     (mobile sidebar drawers, chat panel, version-history drawer); the
     contained element MUST stay below `z-40` or it paints over these
     backdrops (header no longer dimmed, stays click-through) and bleeds
     over the drawer's top strip.
   - `fixed right-0 top-0 z-30` — right-docked editor drawers.
   - `z-10` — sticky table headers (`AdminTable stickyHeader`) and in-flow
     page chrome.
   `z-20` clears page content while staying under every overlay tier —
   the correct choice for a header. Accepted trade-off: the element's own
   descendant dropdowns are trapped inside its box, so overlapping
   overlays paint on top — enumerate EVERY overlapping tier in the
   change's accepted-behavior note (`z-40` full-screen AND `z-30` docked,
   not just the first found).

Greppable proxy: any diff adding `@container`, `container-type`, or
`contain:` to a layout element must (a) portal its fixed overlays and (b)
sweep `grep -rn "inset-0 z-40\|right-0 top-0 z-30\|sticky top-0 z-10" packages/`.

## A shared helper called unconditionally in a render body must tolerate a whole-`undefined` argument — and per-key absence ≠ whole-object null across a re-parse hop (#1203)

Replacing an inline truthy render guard
(`{contents && (contents.a.length > 0 || …)}`) with an unconditional call
to a shared pure helper means the helper runs on EVERY render — including
the state the old guard short-circuited. The helper MUST handle a
whole-`undefined`/`null` argument (`if (!contents) return [];`) or it
throws (`Object.entries(undefined)`) and breaks the page render. The old
inline guard hid this; the extracted call does not.

When judging whether the argument can BE undefined, trace every FE/BE hop
and distinguish two absences:

- **Per-key absence inside a present object is normalized away by any
  intermediate `Schema.safeParse()` whose fields carry `.default([])`** —
  e.g. `core/registry-client.ts` `getPackageDetail()` /
  `getSubmissionDetail()` re-parse through `PackageManifestSchema`, so the
  frontend never sees `contents.fields === undefined` even for a
  pre-feature manifest. Don't guard/test a case a re-parse hop makes
  unreachable; check whether the value reaches the consumer raw (the
  `packages/registry` service returns stored JSON verbatim) or through a
  `safeParse` layer.
- **The whole object CAN still be null** — `pkg.latestManifest` is
  `PackageManifest | null`, so `manifest?.contents` is `undefined` for a
  package with no manifest; that case survives every `.default()` and is
  what the helper's guard defends.

Precedent: PR #1240 (#1203) — r1/2 over-scoped a per-key-undefined test +
guard that `registry-client.ts`'s `safeParse` made unreachable; r4 caught
the genuinely-reachable whole-`undefined`
(`manifestContentsSummaryRows(undefined)` via a null `latestManifest`).
