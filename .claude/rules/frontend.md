---
globs:
  - "packages/frontend/**"
---

# Frontend Conventions

## Stack
- React 19 + Vite 6 + TypeScript (strict)
- Tailwind CSS v4 with CSS custom property design tokens
- TanStack Query for server state, Zustand for client state
- Consumes `@orm/shared` for types and validation schemas

## Style Guide
- **All visual styling MUST follow [STYLE_GUIDE.md](../../.ai/context/STYLE_GUIDE.md)**
- Use semantic color tokens (`bg-brand`, `text-text-primary`, `bg-status-error-subtle`) — never raw Tailwind color scales
- Use `<Button>` component from `components/ui/Button.tsx` — never inline button styles
- Border radius: `rounded-lg` for controls, `rounded-xl` for cards/modals
- Font: Inter (sans), JetBrains Mono (mono) — configured via `@theme` in `index.css`
- Shadows: borders provide structure, not shadows. Only `shadow-lg` on dropdowns, `shadow-xl` on modals.

## Patterns
- All API calls through the typed HTTP client (`lib/api.ts`)
- Client handles auth tokens and `X-Tenant-ID` header automatically
- Form validation uses same Zod schemas as backend
- Named exports only (no default exports)
- Use `import type` for type-only imports

## API paths — NEVER include `/api/v1`

`ApiClient.baseUrl` defaults to `API_BASE_URL` which is `/api/v1` (see
`packages/frontend/src/lib/config.ts`). Every `api.get / api.post / api.patch
/ api.del / api.getWithMeta` call MUST use a path that starts AFTER the
`/api/v1` prefix — otherwise the request ships as `/api/v1/api/v1/...`
and 404s on every default setup.

```typescript
// WRONG — double-prefix, 404 in production
api.get('/api/v1/records/.../containers/summary');
api.post('/api/v1/containers/:id/links', body);

// CORRECT
api.get('/records/.../containers/summary');
api.post('/containers/:id/links', body);
```

Every other hook in this repo (see `useApproval*`, `useIntegrations`,
`useAdmin`, etc.) uses relative paths. A hook file that uses `/api/v1/...`
absolute paths is a review-stopper. Grep your own changes:

```bash
grep -rn "/api/v1/" packages/frontend/src/hooks/ packages/frontend/src/components/
# any match in a newly-written file is a bug
```

Caught in PR #485 round 3 — four absolute-prefix call sites in one hook.

## Component Conventions
- Utility function `cn()` from `lib/utils.ts` for conditional class merging
- Lucide React for icons (`h-4 w-4` inline, `h-5 w-5` navigation)
- Native `<dialog>` for record-level modals only (RecordModal, CloneDialog, ChangeOwnerDialog, ConfirmDialog, InstallPreviewDialog — preview/confirm flow, not an editor)
- `@fontsource-variable/inter` and `@fontsource/jetbrains-mono` for fonts (self-hosted)

## Admin Page Pattern (IMPORTANT)

Admin list pages MUST conform to this contract. Architectural tests in
`packages/frontend/src/__tests__/admin-architecture.test.ts` enforce it —
a violation fails CI.

> **⚠️ Pattern 2 (inline editor card) is DEPRECATED and being removed (#832).**
> Do NOT add a new inline editor card / inline create-edit form below a list
> table. All admin create/edit MUST use a **routed editor page** (Pattern 1).
> Rule 7 in the architecture test fails CI for any list page that renders an
> inline editor outside the shrinking `INLINE_EDITOR_ALLOWLIST` migration
> snapshot. The Pattern-2 prose below is retained only until the in-flight
> migration completes, then removed.

- **Pattern 1 — Routed editor page** (the only sanctioned pattern): row click
  + "New" button both `navigate()` to a dedicated URL. The editor page reads
  params (`isNew = id === 'new'`), breadcrumbs back to the list, and navigates
  on save/cancel. Examples: Objects, Flows, Apps, Custom Pages, Global
  Picklists, Profiles, Permission Sets, Record Types, **AI Agents**. Structure:
  list page uses `AdminTable` only; editor page lives at a single `path:
  'xxx/:id'` route (`id === 'new'` signals create — see
  `frontend-components.md` "Routed editor route shape").
- **Pattern 2 — Inline editor card below the table** *(DEPRECATED — #832; do
  not use for new work)*: row click / edit callback opens an inline editor
  card rendered under the table. Being migrated to Pattern 1.

### Shared structure (both patterns)

```
PageHeader (title, subtitle, primaryAction=handleCreate|navigate('.../new'))
  └─ AdminTable (data, columns, pagination, search, onEdit, onDelete)
  └─ (Pattern 2 only) {editorOpen && <XxxEditor editingItem onSave onClose isSaving />}
```

### Shared primitives (all from `@orm/ui` unless noted)

- **`AdminTable`** — the single admin-table primitive. Supports opt-in
  `pagination` (client or server), `search`, `columnVisibility`, `density`,
  `toolbar` slot, `storageKey` persistence, `stickyHeader`. Has built-in
  `onView` / `onEdit` / `onDelete` row action icons + `ConfirmDialog` for deletes.
- **`AdminEditorCard`** — structural wrapper (title + close X + content slot +
  save/cancel footer) for the inline editor card below the table. Every
  inline editor uses it for identical chrome.
- **`useEditorState<T>()`** (`packages/frontend/src/hooks/useEditorState.ts`) —
  manages `editorOpen`, `editingItem`, `handleCreate`, `handleEdit`, `handleClose`.
- **`useApiErrorToast(map, fallback?)`** (`packages/frontend/src/hooks/useApiErrorToast.ts`) —
  structured `ApiError.code` branching for mutation `onError`; replaces
  `err.message.match/includes` patterns.
- **Cell helpers** — `activeBadgeCell`, `apiNameCell`, `dateCell`, `shortDateCell`,
  `userCell`, `badgeListCell`, `makeBadgeListCell`.

### Rules (enforced)

1. **No raw `<table>`** in `pages/Admin*.tsx`. Use `AdminTable`. Non-list tables
   (diff previews, spreadsheet editors) may be allowlisted in
   `admin-architecture-allowlist.ts` with a reason comment.
2. **No `err.message.match/includes/startsWith`** in delete / mutation handlers.
   Branch on `ApiError.code` via `useApiErrorToast`.
3. **No `<dialog>`** for admin create/edit. Use an inline editor card (via
   `AdminEditorCard`) or a routed editor page. Non-CRUD dialogs (confirm,
   detail view, import) may be allowlisted OR the file may re-export
   `ADMIN_EDITOR_APPROVED = true` (escape hatch for genuinely modal flows).

### Rules (conventional; not auto-enforced yet)

4. **Use `useEditorState<T>()`**, not ad-hoc `useState` for `editorOpen` /
   `editingItem` pairs.
5. **Editor is a named exported component** in its own file (e.g.
   `components/admin/XxxEditor.tsx`), not an inline function inside the page.
6. **Form state is a single object** (`useState<FormState>`), not N scalar
   `useState` hooks.
7. **Delete mutation is re-entrancy guarded** — `if (mutation.isPending) return;`
   inside the confirm / delete handler.
8. **Empty / loading UI uses `EmptyState`** (or `emptyMessage={{ title, description, action }}`
   on AdminTable), not hand-rolled `<div>` empty messages.
9. **No page-replace detail views** — do not `if (selectedId) return <Editor />`
   mid-component. Heavyweight editors get a routed page (`/admin/{entity}/:id`),
   following the Flows/Layouts pattern.

### Reference implementations

- `AdminValidationRulesPage` + `ValidationRuleEditor` (gold standard, inline
  editor)
- `AdminSecretsPage` + `SecretEditor` (inline editor)
- `AdminGlobalPicklistsPage` (list with routed detail editor)
- `AdminWebhooksPage` (tabbed list with `OutboundWebhookEditor` + `InboundWebhookEditor`
  via `AdminEditorCard`)

### Routed editor pages (heavyweight)

These entities' detail editors live at a dedicated route; the list page
still conforms to the contract above:

- **Existing routed**: Flows, Layouts, CustomPages, Objects, Apps,
  GlobalPicklists
- **Moving to routed (#486 Batch A)**: Profiles, PermissionSets, RecordTypes,
  Webhooks

## Error handling — structured, not regex

When a mutation's `onError` needs to show different copy for different failure
modes (e.g. 409 "system entity" vs 409 "in-use"), **branch on `ApiError.status`
and `ApiError.code`, never regex the message text**. Backend error messages are
human-readable copy that can change; `code` is a stable contract.

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

This requires the backend to throw `new PlatformError('FOO_IS_SYSTEM', msg, 409)`
rather than a generic `ConflictError` — see `.claude/rules/delete-lifecycle.md`.
Never do `err.message.match(/regex/)` — future copy edits silently break the UX.

### Typed error-code branching with `useApiErrorToast` (#537)

Prefer `useApiErrorToast` from `packages/frontend/src/hooks/useApiErrorToast.ts`
for branching on `ApiError.code`. The hook is typed against `ErrorCode` from
`@orm/shared` — keys in the map are checked against the central registry by
`error-toast-registry.test.ts`. A typo (`PROFLIE_IS_SYSTEM` vs `PROFILE_IS_SYSTEM`)
fails CI.

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

Add the corresponding code to `packages/shared/src/constants/error-codes.ts`
when the backend service throws a new `PlatformError` code. For default
copy reused across multiple components, see
`packages/frontend/src/lib/errorCopy.ts` (`DEFAULT_ERROR_COPY`).

## Self-identity under impersonation

When hiding UI affordances for the current user (e.g. deactivate button on
your own row), the effective signed-in identity during an impersonation session
is `authStore.impersonation.targetUser.id`, NOT `authStore.user.id`. The access
token switches to the target user while `user` remains the original admin.

```typescript
// WRONG — during impersonation this is the original admin, not the effective user
const currentUserId = useAuthStore((s) => s.user?.id);

// CORRECT — uses the impersonated identity when active, falls back otherwise
const currentUserId = useAuthStore(
  (s) => s.impersonation?.targetUser.id ?? s.user?.id,
);
```

Getting this wrong means the impersonator can deactivate the user they're
acting as, and can't see the button on their own row outside impersonation.
Fixed in #422; don't reintroduce.

## ConfirmDialog — re-entrancy guard

`ConfirmDialog` does NOT disable its own confirm button while async work runs.
A fast double-click fires `onConfirm` twice before React re-renders. Always
guard the mutation in `onConfirm`:

```typescript
<ConfirmDialog
  open={!!deleteTarget}
  onConfirm={() => {
    if (!deleteTarget) return;
    if (mutation.isPending) return;           // ← re-entrancy guard
    const target = deleteTarget;
    setDeleteTarget(null);                    // close dialog
    mutation.mutate(target.id);
  }}
  ...
/>
```

Setting state inside the same synchronous click handler does NOT prevent the
second fire — React batches state updates until after the handler returns.
The `isPending` check is the reliable fix.
