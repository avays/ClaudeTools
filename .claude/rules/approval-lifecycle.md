# Approval Lifecycle Conventions

Applies to the **approval domain** — every feature that touches submit/approve/reject/
recall/reassign, process versioning, SLA, delegation, and escalation.

Codifies the patterns introduced in #331 (Approvals Redesign Phase A). Read this before
touching `approval.service.ts`, `assignee-resolver.ts`, or any routes under
`/api/v1/admin/approval-processes` or `/api/v1/approvals`.

---

## Backend — Service pattern

**Discriminated returns for every lifecycle state machine transition.**

All state-changing methods (`submit`, `approve`, `reject`, `recall`, `reassign`) follow:
1. Load + validate the instance and process (throw `NotFoundError`/`ValidationError` early).
2. Verify authorization — check `approvalCurrentApproversRepository.isCurrentApprover()`
   first (fast denormalized path); fall back to legacy `resolveApprovers()` for backward
   compat with pre-redesign processes.
3. Run business logic inside or outside a transaction as appropriate.
4. **Always clear `approval_current_approvers` rows** when an instance terminates:
   `clearForInstance()` on approve/reject/recall.
5. Append an `approval_audit_log` entry for every transition — never skip.
6. Emit a domain event (`eventBus.emit(APPROVAL_EVENTS.*)`) after side-effects succeed.
7. Return the updated `ApprovalInstanceResponse`.

**Typed error codes, not generic messages:**

| Code | HTTP | When |
|------|------|------|
| `APPROVAL_IN_USE` | 409 | Cannot delete process — has active/pending instances |
| `APPROVAL_VERSION_CONFLICT` | 409 | Activating a version that was already activated by another request |
| `APPROVAL_ALREADY_ACTED` | 409 | User already approved/rejected this step |
| `APPROVAL_NOT_AUTHORIZED` | 403 | User is not a current step approver |
| `APPROVAL_ROUTING_FAILED` | 409 | Cannot resolve approvers (missing manager, deleted field, etc.) |
| `APPROVAL_ROUTING_OVERFLOW` | 409 | Assignee set exceeds `APPROVAL_ASSIGNEE_PROFILE_MAX` (500) |
| `APPROVAL_DRAFT_LIMIT` | 409 | More than 10 draft versions for one process |
| `APPROVAL_STALE_STATE` | 409 | Pre-tx `instance.currentStep` ≠ the FOR UPDATE-locked row's `current_step`. A concurrent reject with `rejectionBehavior:'go_to_step'` regressed the step between the pre-tx read and the lock acquire. Caller must refetch + retry. (#668 L1) |

Use `new PlatformError('APPROVAL_ROUTING_FAILED', message, 409)` — never a generic `ConflictError`.

---

## Assignee resolution — always use `resolveAssignees()`

**NEVER re-implement assignee resolution in a new method.**

The canonical entry point is:
```typescript
import { resolveAssignees, legacyStepToAssigneeRef, type ResolvedAssignee } from './assignee-resolver.js';

// New-style step (has assignedTo: AssigneeRef)
const assignees: ResolvedAssignee[] = await resolveAssignees(step.assignedTo, ctx);

// Legacy step (approverType/approverId)
const ref = legacyStepToAssigneeRef(step);
if (ref) {
  const assignees = await resolveAssignees(ref, ctx);
}
```

Delegation is applied **inside `resolveAssignees()`** — you never need to check
`approval_delegates` directly outside the resolver. Each `ResolvedAssignee` carries
`resolvedFrom` which traces the routing path for the audit log.

After resolution, persist via:
```typescript
await approvalCurrentApproversRepository.setForStep(tenantId, instanceId, stepOrder, assignees);
```

**Always clear on step completion:**
```typescript
// On advance to next step:
await approvalCurrentApproversRepository.clearForStep(tenantId, instanceId, previousStep);
// On terminal state (approved / rejected / recalled):
await approvalCurrentApproversRepository.clearForInstance(tenantId, instanceId);
```

**Assignee type caps:**
- `group`, `profile`, `role` all cap at `APPROVAL_ASSIGNEE_PROFILE_MAX` (500 users).
- `fieldRef` requires the field to be a `Lookup` or `PolymorphicLookup` type; wrong type throws `APPROVAL_ROUTING_FAILED`.
- `manager` returns empty set (not an error) when the submitter has no manager configured.

---

## Process versioning

**In-flight instances must never re-read process rules.**

- `approval_instances.process_version_id` is set at submit time from `approval_processes.active_version_id`.
- All mid-flight resolves (step advancement, approver check) read from `approval_processes.steps`
  which the UI binds to the process row (not the version). Full version-aware dispatch is Phase B.
- `approval_process_versions` is the audit trail and the source of truth for re-activation.
- At most 10 versions per process can be in `draft` state simultaneously (`APPROVAL_DRAFT_LIMIT`).
- Activation is transactional: the current active version is flipped to `inactive` and the
  parent process's `active_version_id` is updated atomically.

**Version lifecycle:**
```
draft ──(activate)──► active ──(deactivate / new activation)──► inactive
```
- Draft can be edited freely.
- Only one version can be `active` per process at any time (enforced by partial unique index).
- Inactive versions are immutable (historical record).

---

## Frontend error branching — structured, not regex

```typescript
import { ApiError } from '@/lib/api';

mutate(instanceId, {
  onError: (err: unknown) => {
    if (err instanceof ApiError && err.status === 409) {
      if (err.code === 'APPROVAL_ROUTING_FAILED')
        return toastError('Could not resolve approvers — check process configuration.');
      if (err.code === 'APPROVAL_ROUTING_OVERFLOW')
        return toastError('Too many approvers resolved — narrow the group or profile.');
      if (err.code === 'APPROVAL_DRAFT_LIMIT')
        return toastError('Too many draft versions — activate or delete a draft first.');
      if (err.code === 'APPROVAL_ALREADY_ACTED')
        return toastError('You have already acted on this approval step.');
    }
    if (err instanceof ApiError && err.status === 403) {
      if (err.code === 'APPROVAL_NOT_AUTHORIZED')
        return toastError('You are not an approver for the current step.');
    }
    toastError(err instanceof Error ? err.message : 'Approval action failed.');
  },
});
```

Never `err.message.match(/regex/)` — backend copy can change; `code` is the stable contract.

---

## SLA / escalation

- When a step has `slaHours > 0`, the service writes `current_step_due_at` on the instance
  and enqueues a delayed job on `approvalSlaQueue` (queue name `'approval-sla'`).
- The job carries `{ tenantId, instanceId, stepOrder }`.
- The worker processor is registered in `packages/backend/src/core/jobs/worker.ts`
  (`processApprovalSlaJob` in `domains/approval/approval-sla.worker.ts`).
- **Job-ID idempotency**: `jobId` is `sla-check:<instanceId>:<stepOrder>` (stable per step).
  The service removes any prior job with that id before re-adding, so a step that restarts
  (e.g. via `go_to_step`) gets a fresh timer instead of BullMQ silently dropping the add.
- **Run-time idempotency**: before side effects, the worker calls
  `approvalRepository.claimForSlaEscalation(tenantId, instanceId, stepOrder)` — a conditional
  UPDATE that sets `escalated_at = now()` WHERE `status='pending' AND current_step=stepOrder
  AND escalated_at IS NULL`. Zero-row match ⇒ return early. This prevents retries or racing
  workers from double-firing notifications, reassignments, or auto-reject actions.
- `escalated_at` gates the UI "escalated" badge.
- The `escalationApprover` on a step (optional `AssigneeRef`) is resolved by the
  `escalateApproval` action executor and written to `approval_current_approvers`.
- Action-type safety: the worker checks `def.supportsApprovalAction` via
  `actionTypeRegistry.get(type)` before execution and refuses to run action types that
  aren't approval-safe (flow-only or custom-only types). `ApprovalStepSchema.escalationActions`
  is `z.array(z.record(z.unknown()))` — open-ended by design — so the runtime gate is the
  authoritative defence.

---

## Criteria evaluation on step advance

When a step has a non-empty `criteria` object, it is evaluated against the current record
before resolving assignees:

```typescript
if (step.criteria && Object.keys(step.criteria).length > 0) {
  const record = await dataService.getRecord(...);
  if (!evaluateCriteria(step.criteria, record)) {
    // Skip step — append 'step_skipped' audit entry, advance to next step
  }
}
```

- A loop guard (`MAX_CRITERIA_SKIP_LOOPS = 100`) prevents infinite chains of skipped steps.
- If all remaining steps are skipped, the instance is automatically approved and
  process-level `approvalActions` are executed.
- Skipped steps NEVER have approver rows set in `approval_current_approvers`.

---

## Common missteps

1. **Re-implementing resolveAssignees inline.** Use `resolveAssignees()` from `assignee-resolver.ts`;
   never rewrite the delegation or profile/group resolution logic.

2. **Forgetting to clear `approval_current_approvers` on terminal states.** A stale row means
   `listPendingInstanceIdsForUser()` keeps returning a completed instance.

3. **Skipping audit log writes.** Every state change MUST append a row to `approval_audit_log`
   with the correct `eventType`. The ApprovalTimeline UI and agent tools consume this table.

4. **Reading `approval_processes.steps` inside the worker for a specific version.** When Phase B
   binds versions fully, all step reads should go through the version. For now, the service reads
   from the process row — do not reach into `approval_process_versions.steps` in the service layer.

5. **Using `ConflictError` for multiple 409 cases.** Use `PlatformError` with a dedicated `code`
   string so the frontend can branch without fragile message-text matching.

6. **Self-approval is always blocked.** `submittedById === userId` → throw `ForbiddenError`.
   This applies even if the submitter is explicitly listed as an approver on the step.

7. **Re-entrancy on approve/reject UI buttons.** Protect with `if (mutation.isPending) return;`
   in `ConfirmDialog.onConfirm` (see `.claude/rules/frontend.md` re-entrancy section).

## Precedents

- Migration 063–067: approval_process_versions, approval_current_approvers, approval_delegates, approval_audit_log, column additions.
- Phase A implementation: `approval.service.ts` full redesign, `assignee-resolver.ts`, new repos, `approval-process-versions.service.ts`, routes — issue #331.
