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
- Must run `{{PKG_BUILD}}` before backend typecheck
- `JSONB_COLUMN_MAP` in constants maps field type names to storage columns
- `FIELD_TYPES` constant has all 18 field type identifiers

## Constants registries (#537)

The typed registries the FE/BE boundary contract is built on. Adding to one
is a coordinated change — arch tests on both sides break the moment a value
lands without the matching update.

| File | Exports | Used by |
|------|---------|---------|
| `constants/error-codes.ts` | `ERROR_CODES`, `ErrorCode`, `isErrorCode` | `PlatformError(ERROR_CODES.X, ...)` on backend; `useApiErrorToast` map keys on frontend |
| `constants/permissions.ts` | `PERMISSIONS`, `Permission`, `ALL_PERMISSIONS` | `requireSystemPermission(PERMISSIONS.X)`, `'x-requires-permission'`: `[PERMISSIONS.X]` |
| `constants/statuses.ts` | `RECORD_STATUS`, `FLOW_STATUS`, `APPROVAL_STATUS`, `INTEGRATION_CONNECTION_STATUS`, `JOB_STATUSES` (re-exported) | service-layer status comparisons; UI status filters |

**Adding a new code / permission / status:** (1) edit the relevant
`constants/*.ts` file — values are wire-format strings, so never change one,
only add; (2) `{{PKG_BUILD}}`; (3) reference at the call
site (`ERROR_CODES.YOUR_CODE`, `PERMISSIONS.YOUR_PERM`,
`RECORD_STATUS.YOUR_STATE`). Arch tests `error-codes-registry.test.ts`,
`permissions-registry.test.ts` (backend) and `error-toast-registry.test.ts`
(frontend) reject anything unregistered — CI is the safety net.

## Identity keys, sentinels, and schema-enforced invariants (#947)

For any schema whose fields participate in an identity / lookup key
(selection entries, dedupe keys, cache keys, reverse-lookup maps). Each rule
below was a Copilot round on PR #988.

### Composite identity keys: JSON-encode, never `?? ''` sentinels

```ts
// WRONG — null and '' collapse into the same key; a crafted '' value can
// alias another item's identity
const key = `${entityType}::${parentApiName ?? ''}::${targetApiName ?? ''}`;

// RIGHT — JSON keeps null and '' distinct components
const key = JSON.stringify([entityType, parentApiName ?? null, targetApiName ?? null]);
```

### apiName-shaped fields: `.min(1)`, absence is `null` — never `''`

Any Zod field holding an apiName (or other identifier) is `z.string().min(1)`
(+ `.nullable()` when absence is legal). Empty string is never a valid
encoding of "absent" — it forges/collapses identity keys. Where a server-side
producer can genuinely hit a missing source value, substitute a stable
placeholder (e.g. `#<ordinal>`) at the produce site rather than loosening the
schema.

### JSDoc invariants MUST be schema-enforced

A doc comment asserting an invariant — "always populated, never empty", "only
meaningful when X is null", "exactly one of A/B" — MUST encode it: `.min(1)`,
`.refine`, `.superRefine`. A documented-but-unenforced invariant is a
standing review finding; if enforcement is deliberately omitted (e.g. the
schema parses at produce time and rejecting would turn representable data
into a hard failure), state the reason in the JSDoc.

Partial refinements are legitimate: enforce the half that breaks identity
(both-null → unresolvable), accept harmless redundancy (both-set, when one
side is ignored) — and document the asymmetry so a later pass doesn't
"complete" the XOR and break clients that echo objects back.

### Optional string fields with "cleared" semantics: trim AND normalize the empty case, in the schema itself

`.min(1)` alone does not close the loop for a field whose comment describes a
3-state contract (`undefined` = unchanged, `null` = cleared, string = set) or
a 2-state "clear on empty" contract. Two gaps recur together: it still admits
whitespace-only input (`'   '`) as non-empty-but-meaningless content,
violating the comment's own "never stores empty" invariant; and it 400s a
caller's bare `''` (UI clear button, LLM/tool caller sending the obvious
"empty" value) instead of mapping it to the field's own "cleared" sentinel —
forcing every caller to know to send `null`, with no signal about which one
this field wants.

Fix both in the schema with `z.preprocess`, never an ad-hoc service-layer
check the caller can bypass:

```ts
// A field with `undefined` = unchanged, `null` = clear, string = set:
acceptanceCriteria: z.preprocess(
  (v) => {
    if (typeof v !== 'string') return v;       // pass through null/undefined
    const trimmed = v.trim();
    return trimmed.length === 0 ? null : trimmed;   // '' and whitespace-only => explicit clear
  },
  z.string().min(1).max(2000).nullable().optional(),
),
```

Create-side variant (`undefined` = absent, string = set, no `null` state):
same preprocess returning `undefined` for the empty case, wrapping
`z.string().min(1).max(2000).optional()`.

Document the mapping (which sentinel `''`/whitespace collapses to) directly
above the field — the preprocess step IS the enforcement the JSDoc-invariants
rule requires. (PR #1196 (#1186) r1–2: `PlanStepInputSchema` /
`UpdatePlanStepSchema` `acceptanceCriteria` both shipped a bare `.min(1)` — two schemas, same
missed pair of checks; the sibling-sweep rule below applied to this shape
too.)

### Tightening one schema? Sweep its siblings

Schemas that mirror each other's fields (a produce-side schema and its
select/update-side counterpart, e.g. `GapReportItemSchema` ↔
`TranslationSelectionEntrySchema`) MUST stay consistent: when adding
`.min(1)` / `.refine` to one, grep sibling schemas sharing the field names
and reconcile in the same commit. An asymmetric constraint pair is worse than
none (PR #988 r6: gap items the selection schema could not reference).
General form: `workflow.md` "Sibling sweep (canonical statement)".

### Case-sensitivity must match the canonical lookup

Dedupe/uniqueness logic over identifiers MUST compare with the same case
semantics as the platform's canonical lookup for that entity (objects:
case-insensitive `lower(api_name)` fallback; fields: exact). A case-sensitive
dedupe over a case-insensitive namespace ships candidates that collide only
at deploy time.

## `.default()` makes the field REQUIRED in the inferred type — sweep every construction site, including tests (#1033)

`.default(x)` on a Zod object field makes that field **required** in the
*inferred output type* (`z.infer<typeof Schema>`), even though it stays
optional to *provide* at parse time. Every `const input: SchemaType = {...}`
literal that previously omitted the field now fails `tsc` with "Property 'x'
is missing... but required" — including test fixtures, which construct the
type directly rather than going through `.parse()`.

```ts
// Before: bundleScope optional in both the schema and the inferred type
bundleScope: z.enum(['namespace', 'full']).optional(),

// After: still optional to the CALLER of .parse(), but the inferred output
// type now REQUIRES it — every literal typed against SubmitPackageInput
// must include it, or fail to compile.
bundleScope: z.enum(['namespace', 'full']).default('namespace'),
```

**Grep every construction site of the inferred type — not just production
call sites** — and add the field (or an explicit interim value) to each:

```bash
grep -rn "SubmitPackageInput\|submitMutation.mutate(\|result.current.mutate(" packages/frontend/src packages/backend/src
```

Test files are the easy miss: a grep for the schema name alone doesn't cover
them, and a sub-phase's "Verify" step that runs only `typecheck` won't catch
them — run BOTH typecheck and test locally before committing. A `.default()`
addition is a chain trigger of its own, of the same "incomplete chain" class
`workflow.md` "Completeness traps" documents. (PR #1195 (#1033) r1–2 — three
construction sites broke: `useRegistry.test.tsx`, `PackageSubmitEditor.test.tsx`
(a related but distinct UI-default miss), and `AdminPackageSubmitEditorPage.tsx`'s
production `submitMutation.mutate(...)` call — the last deferred by the first
fix to a later sub-phase under a green-typecheck claim that wasn't true at
that boundary; never defer a known-broken construction site.)
