---
name: typecheck-all
description: Build shared package and run full backend typecheck
---

# Full Typecheck

Run in sequence:
1. `pnpm --filter @orm/shared build`
2. `pnpm --filter @orm/ui build`
3. `pnpm --filter @orm/frontend typecheck`
4. `pnpm --filter @orm/backend typecheck`

If errors, group them by file and report. Fix any issues found.
