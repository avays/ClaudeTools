---
globs: []
---

# Architectural North Star — Maximalist Dynamic Posture

Every design decision in this codebase defaults to the **more dynamic, more
composable, more LLM-introspectable choice**. The platform is built so that
LLMs can compose components, hydrate them with data in real time, and create
new interactions that the original author didn't anticipate.

If you're choosing between two designs and one is "static, hardcoded, hidden"
and the other is "registered, introspectable, exposed", **pick the second**
unless there's a concrete reason not to. That reason should be written down.

This rule isn't about a single subsystem; it applies to every primitive,
every behavior, every API surface. Specific patterns elsewhere in this rule
set (`registry.md`, `agent-skills.md`, `backend-api.md`, `shared-types.md`,
`frontend-components.md`) are concrete instances of this principle.

## The ten decision rules

When you're about to add a new primitive, behavior, or surface, ask each of
these. If any answer is "no", justify it in the spec or in a code comment.

### 1. Is it registered?

Every primitive type — field type, flow step, layout component, action type,
context builder, permission, etc. — goes through a registry that exposes
metadata + a runtime function. Zero switch statements on type strings outside
the registry's definition files.

See `.claude/rules/registry.md` for the full pattern.

**Anti-pattern:** `if (field.fieldType === 'Text') { ... } else if (...)`.

### 2. Is it LLM-callable?

Every authenticated route can be exposed to agents by adding `'llm-tool'` to
its tags. Domain capabilities that the UI can do should also be reachable by
agents — without that, the LLM sees a UI it can't replicate.

See `.claude/rules/agent-skills.md` and `.claude/rules/backend-api.md`.

**Anti-pattern:** a feature that lives only behind an admin UI button with no
tagged route equivalent.

### 3. Does it expose list + describe?

Every registry exposes two endpoints:
- `GET /api/v1/admin/{primitive}-types` — list all (metadata only, no runtime)
- `GET /api/v1/admin/{primitive}-types/:apiName` — describe one

Both tagged `llm-tool` so agents auto-discover available types. The catalog
is **the** source of truth, not a hand-maintained doc.

**Anti-pattern:** a list of supported types in a markdown file or a hardcoded
const that callers have to update separately from the registry.

### 4. Is the contract typed?

Zod schemas first, TypeScript types inferred. Runtime validation and
compile-time type are the same artifact. JSON Schema for LLM tool definitions
is derived from the same Zod schemas — never hand-written.

See `.claude/rules/shared-types.md` and `.claude/rules/agent-skills.md`
("x-zod-body / x-zod-query / x-zod-params").

**Anti-pattern:** separate type definitions for "what TypeScript sees", "what
runtime checks", and "what the LLM is told".

### 5. Do components declare their props?

Every UI component that participates in layout composition declares its
props schema (Zod or JSON Schema). The renderer dispatches via registry
lookup — `LAYOUT_COMPONENT_API_NAMES` + the component registry — not via
switch on a string.

**Anti-pattern:** a layout renderer with a switch statement over component
types it knows about.

### 6. Is data declared, not baked in?

A component or layout shouldn't hardcode the records it shows. It declares
either a query (object api name + filter) or a context builder (e.g. user,
record, page). The renderer hydrates at render time. This is what lets an
LLM say "show me this layout filled with these records" without rebuilding
the component.

**Anti-pattern:** a "Customers Dashboard" component that hardcodes
`SELECT * FROM customers` rather than declaring a query parameter that the
caller fills in.

### 7. Default to composition over specialization

When designing a feature, ask: "Is this a hard-coded behavior, or a primitive
that other features could compose?" Prefer the primitive. Prefer "add a new
field type" over "add a new column to records". Prefer "add a new flow step"
over "add a new method on flow.service.ts". Specialization compounds; new
primitives compose.

**Anti-pattern:** adding bespoke fields, columns, or service methods for a
single feature when a registry-eligible extension would serve the feature
and N future ones.

### 8. No black-box services

Every service exposes its operations + parameter schemas through tagged
routes. If a service has internal capabilities the UI can drive, those
capabilities are agent-callable too. The set of "what the platform can do"
is queryable, not hidden in code.

**Anti-pattern:** a service method called only from one route handler that
isn't itself agent-callable, hiding the capability from the LLM.

### 9. Treat the LLM as a peer

Every human-facing label, description, help text, and documentation string
in the catalog is text the LLM reads to decide how to use the primitive.
Write descriptions that make the *intent* clear, not just the syntax. Use
the same labels and descriptions in the UI and the catalog so the LLM and
the human reason about the same names.

**Anti-pattern:** a registry entry whose `description` says "X" while the
admin UI tooltip says "Y". The LLM and the human see different platforms.

### 10. Runtime resolution beats compile-time switch

When the platform needs to dispatch on type / api-name / event-name, prefer
a runtime registry lookup over a compile-time switch or if/else chain. This
lets new primitives land via configuration (or via a future LLM-driven
flow) without code changes.

**Anti-pattern:** `getHandler(type)` implemented as a switch statement; should
be `registry.get(type).execute`.

## When to deviate

The principle has costs. Sometimes you need to.

- **Performance**: a registry lookup costs ~ns; a switch statement is
  comparable. Don't worry about this.
- **Stability of the contract**: registries make adding easy and removing
  hard (other code depends on the registered values). For genuinely
  experimental code, a private switch can ship first; promote to the registry
  when stable. Document the deviation in the file.
- **Tightly-bound implementation details**: a helper that exists only to
  serve one specific behavior, with no plausible reuse, can stay specialized.
  But err on the side of: "Could this be a primitive?"

If you deviate, write a comment that explains why. The default is the
maximalist choice; deviations are the exception that earns its justification.

## How specs and PRs are evaluated against this rule

When `/create-spec` or `/audit-phase` runs, this rule joins the auto-loaded
context (`globs: []` makes it always-on). Specs are checked against the ten
rules above. Code reviews ask the same questions. The auditor agent has an
explicit dimension for "did this work preserve the maximalist dynamic
posture?" — see `.claude/agents/auditor.md`.

The end state we're building toward: an LLM, given access to this platform's
catalog + admin endpoints, can compose a complete vertical SaaS application
— pages, automations, integrations, agents — by combining existing
primitives. The principle exists to keep that goal reachable.
