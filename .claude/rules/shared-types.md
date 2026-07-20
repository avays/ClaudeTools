---
globs:
  - "packages/shared/**"
---

# Shared Package Conventions

## Zod-First Types
- Define Zod schemas first, then infer TypeScript types with `z.infer<typeof Schema>`
- Export both the schema (runtime validation) and inferred type (compile-time)
- Example: `export const CreateObjectSchema = z.object({...})` + `export type CreateObjectInput = z.infer<typeof CreateObjectSchema>`

## Structure
- `types/` — Zod schemas and TypeScript interfaces per domain
- `constants/` — Shared constants with `as const` for enum-like objects
- `index.ts` — Re-exports everything (barrel file)

## Constraints
- No Node.js-specific APIs — consumed by both backend and frontend
- Must run `pnpm --filter @orm/shared build` before backend typecheck
- `JSONB_COLUMN_MAP` in constants maps field type names to storage columns
- `FIELD_TYPES` constant has all 18 field type identifiers


## Constants registries (#537)

The constants directory hosts the typed registries that the FE/BE boundary
contract is built on. Adding to one of these is a coordinated change — the
arch tests on both sides break the moment a new value lands without the
matching update.

| File | Exports | Used by |
|------|---------|---------|
| `constants/error-codes.ts` | `ERROR_CODES`, `ErrorCode`, `isErrorCode` | `PlatformError(ERROR_CODES.X, ...)` on backend; `useApiErrorToast` map keys on frontend |
| `constants/permissions.ts` | `PERMISSIONS`, `Permission`, `ALL_PERMISSIONS` | `requireSystemPermission(PERMISSIONS.X)`, `'x-requires-permission'`: `[PERMISSIONS.X]` |
| `constants/statuses.ts` | `RECORD_STATUS`, `FLOW_STATUS`, `APPROVAL_STATUS`, `INTEGRATION_CONNECTION_STATUS`, `JOB_STATUSES` (re-exported) | service-layer status comparisons; UI status filters |

**Adding a new code / permission / status:**

1. Edit the relevant `constants/*.ts` file. Values are wire-format strings —
   never change a value, only add new ones.
2. `pnpm --filter @orm/shared build`.
3. Reference at the call site: `ERROR_CODES.YOUR_CODE`,
   `PERMISSIONS.YOUR_PERM`, `RECORD_STATUS.YOUR_STATE`.

The arch tests `error-codes-registry.test.ts`, `permissions-registry.test.ts`
(backend), and `error-toast-registry.test.ts` (frontend) reject anything
unregistered. CI is the safety net.

## Identity keys, sentinels, and schema-enforced invariants (#947)

Contract patterns for any schema whose fields participate in an identity /
lookup key (selection entries, dedupe keys, cache keys, reverse-lookup maps).
Every rule below was discovered as a Copilot review round on PR #988 —
applying them at write time saves 3–4 review cycles per feature.

### Composite identity keys: JSON-encode, never `?? ''` sentinels

```ts
// WRONG — null and '' collapse into the same key; a crafted '' value can
// alias another item's identity
const key = `${entityType}::${parentApiName ?? ''}::${targetApiName ?? ''}`;

// RIGHT — JSON keeps null and '' distinct components
const key = JSON.stringify([entityType, parentApiName ?? null, targetApiName ?? null]);
```

### apiName-shaped fields: `.min(1)`, absence is `null` — never `''`

Any Zod field that holds an apiName (or other identifier) is
`z.string().min(1)` (+ `.nullable()` when absence is legal). Empty string is
never a valid encoding of "absent" — it forges/collapses identity keys.
When a server-side producer can genuinely encounter a missing source value,
substitute a stable placeholder (e.g. `#<ordinal>`) at the produce site
rather than loosening the schema.

### JSDoc invariants MUST be schema-enforced

If a field's doc comment asserts an invariant — "always populated, never
empty", "only meaningful when X is null", "exactly one of A/B" — encode it:
`.min(1)`, `.refine`, `.superRefine`. A documented-but-unenforced invariant
is a standing review finding. If enforcement is deliberately omitted (e.g.
the schema parses at produce time and rejecting would turn representable
data into a hard failure), say so in the JSDoc with the reason.

Partial refinements are legitimate: enforce the half that breaks identity
(both-null → unresolvable) while accepting harmless redundancy (both-set,
when one side is ignored) — document the asymmetry in a comment so a later
pass doesn't "complete" the XOR and break clients that echo objects back.

### Tightening one schema? Sweep its siblings

Schemas that mirror each other's fields (a produce-side schema and its
select/update-side counterpart, e.g. `GapReportItemSchema` ↔
`TranslationSelectionEntrySchema`) MUST stay consistent. When adding
`.min(1)` / `.refine` to one, grep for sibling schemas sharing the field
names and reconcile in the same commit — an asymmetric constraint pair is
worse than none (PR #988 round 6: gap items the selection schema could not
reference).

### Case-sensitivity must match the canonical lookup

Dedupe/uniqueness logic over identifiers MUST compare with the same case
semantics as the platform's canonical lookup for that entity (objects:
case-insensitive `lower(api_name)` fallback; fields: exact). A
case-sensitive dedupe over a case-insensitive namespace ships candidates
that collide only at deploy time.
