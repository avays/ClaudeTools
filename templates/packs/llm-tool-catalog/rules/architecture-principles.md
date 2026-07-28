---
globs: []
---

# Architectural North Star — Maximalist Dynamic Posture

Every design decision in this codebase defaults to the **more dynamic, more
composable, more LLM-introspectable choice**. The platform is built so LLMs
can compose components, hydrate them with data in real time, and create
interactions the original author didn't anticipate. When choosing between
"static, hardcoded, hidden" and "registered, introspectable, exposed" —
pick the second unless there's a concrete reason not to, and write that
reason down.

This applies to every primitive, behavior, and API surface. The specific
patterns in `{{PATHS_RULES_DIR}}/registry.md`, `{{PATHS_RULES_DIR}}/agent-skills.md`,
`{{PATHS_RULES_DIR}}/backend-api.md`, `{{PATHS_RULES_DIR}}/shared-types.md`, and
`{{PATHS_RULES_DIR}}/frontend-components.md` are concrete instances.

## The ten decision rules

Before adding a new primitive, behavior, or surface, ask each. Any "no"
must be justified in the spec or a code comment.

1. **Is it registered?** Every primitive type (field type, flow step,
   layout component, action type, context builder, permission…) goes
   through a registry exposing metadata + a runtime function; zero switch
   statements on type strings outside definition files (see `registry.md`).
   Anti-pattern: `if (field.fieldType === 'Text') { ... } else if (...)`.
2. **Is it LLM-callable?** Every authenticated route can be exposed to
   agents by adding `'llm-tool'` to its tags; any capability the UI can
   drive should be agent-reachable — without that, the LLM sees a UI it
   can't replicate (see `agent-skills.md`, `backend-api.md`).
   Anti-pattern: a feature living only behind an admin UI button with no
   tagged route equivalent.
3. **Does it expose list + describe?** Every registry exposes
   `GET /api/v1/admin/{primitive}-types` (list all — metadata only, no
   runtime function) and `…/:apiName` (describe one), both tagged
   `llm-tool` — the catalog is THE source of truth. Anti-pattern: a
   supported-types list in a markdown file or hand-maintained const.
4. **Is the contract typed?** Zod schemas first; TypeScript types
   inferred — runtime validation and compile-time type are the same
   artifact; LLM JSON Schema derived from the same Zod via the `x-zod-*`
   route extensions — never hand-written (see `shared-types.md` and
   `agent-skills.md` "x-zod-body / x-zod-query / x-zod-params").
   Anti-pattern: separate definitions for what TypeScript sees, what
   runtime checks, and what the LLM is told.
5. **Do components declare their props?** Layout-composable components
   declare a props schema; the renderer dispatches via registry lookup
   (`LAYOUT_COMPONENT_API_NAMES` + component registry; see
   `frontend-components.md`). Anti-pattern: a layout renderer switching on
   component-type strings.
6. **Is data declared, not baked in?** Components declare a query (object
   api name + filter) or a context builder; the renderer hydrates at
   render time — that's what lets an LLM say "show this layout with these
   records". Anti-pattern: a dashboard hardcoding `SELECT * FROM customers`
   instead of declaring a query parameter.
7. **Composition over specialization.** Prefer "add a new field type" over
   "add a column to records"; "add a flow step" over "add a method on
   flow.service.ts". Specialization compounds; primitives compose.
   Anti-pattern: bespoke fields/columns/methods for a single feature a
   registry-eligible extension would serve.
8. **No black-box services.** Every service exposes its operations +
   parameter schemas through tagged routes; "what the platform can do" is
   queryable. Anti-pattern: a service method called from one route handler
   that isn't itself agent-callable.
9. **Treat the LLM as a peer.** Every label, description, and help string
   in the catalog is text the LLM reads to decide how to use the
   primitive — write for intent, and use the SAME names in the UI and the
   catalog. Anti-pattern: a registry `description` saying "X" while the
   admin tooltip says "Y" — the LLM and the human see different platforms.
10. **Runtime resolution beats compile-time switch.** Dispatch on
    type/api-name/event-name via registry lookup so new primitives land
    via configuration without code changes. Anti-pattern: `getHandler(type)`
    implemented as a switch; should be `registry.get(type).execute`.

## When to deviate

- **Performance**: a registry lookup costs ~ns — never a reason.
- **Contract stability**: registries make adding easy and removing hard;
  genuinely experimental code may ship a private switch first, promoted to
  the registry when stable — document the deviation in the file.
- **Tightly-bound implementation details**: a helper serving one behavior
  with no plausible reuse can stay specialized — but err toward "could
  this be a primitive?"

Deviations earn a comment explaining why; the maximalist choice is the
default.

## How specs and PRs are evaluated against this rule

`/create-spec` and `/audit-phase` load this rule always-on (`globs: []`)
and check specs against the ten rules; code reviews ask the same
questions; the auditor agent has an explicit
"did this preserve the maximalist dynamic posture?" dimension (see
`{{PATHS_AGENTS_DIR}}/auditor.md`). The end state: an LLM with access to this
platform's catalog + admin endpoints can compose a complete vertical SaaS
application — pages, automations, integrations, agents — from existing
primitives. The principle keeps that goal reachable.
