---
globs:
  - "docker-compose*.yml"
  - "Dockerfile"
  - "packages/*/Dockerfile"
  - "railway*.json"
  - ".railway/**"
---

# Railway Deployment Conventions

## Project
- **Project:** <railway-project-name>
- **Project ID:** `<RAILWAY_PROJECT_ID>`
- **Environment:** production
- **Dashboard:** https://railway.com/project/<RAILWAY_PROJECT_ID>

## Services

| Service | Type | Internal Host | Public Domain | Dockerfile |
|---------|------|---------------|---------------|------------|
| Postgres | Database plugin | `postgres.railway.internal:5432` | — | — |
| Redis | Database plugin | `redis.railway.internal:6379` | — | — |
| MinIO | Docker image (`minio/minio:latest`) | `MinIO.railway.internal:9000` | — | — |
| app-api | GitHub repo | `app-api.railway.internal:3000` | `<app-api-public-domain>` | `packages/backend/Dockerfile` |
| app-worker | GitHub repo | *(internal only — no HTTP)* | — | `packages/backend/Dockerfile.worker` |
| app-frontend | GitHub repo | `app-frontend.railway.internal:8080` | `<app-frontend-public-domain>` | `packages/frontend/Dockerfile` |
| app-registry | GitHub repo | `app-registry.railway.internal:3002` | `<app-registry-public-domain>` | `packages/registry/Dockerfile` |

## CLI Commands

```bash
# Link to project
railway link -p <RAILWAY_PROJECT_ID>

# Link to a specific service (required before vars/logs/domain commands)
railway link -p <RAILWAY_PROJECT_ID> -s <service-name>

# Check status
railway status                           # Current linked service
railway service status --all --json      # All services

# Environment variables
railway vars                             # List vars for linked service
railway vars set KEY=VALUE KEY2=VALUE2   # Set vars
railway vars --json                      # JSON output

# Logs
railway logs                             # Linked service
railway service logs -s app-api          # Specific service

# Domains
railway domain                           # Generate Railway domain for linked service

# Deploy (auto-deploys on git push, but manual trigger available)
railway service redeploy -s app-api      # Redeploy specific service

# Volumes
railway volume add -m /data              # Add volume to linked service
railway volume list                      # List volumes
```

## Key Environment Variables

Each app service needs `RAILWAY_DOCKERFILE_PATH` to tell Railway which Dockerfile to use (monorepo).

### app-api
- `RAILWAY_DOCKERFILE_PATH=packages/backend/Dockerfile`
- `NODE_ENV=production` — **required.** Multiple security gates read `process.env.NODE_ENV` directly and fail OPEN (dev posture) when it is unset: the CORS localhost allowance (`plugins/cors.ts` `isAllowedOrigin` + the socket.io realtime origin in `core/realtime/realtime.ts`, #840), auth cookie `secure`/`sameSite=none` (`auth.routes.ts`), and the RLS role + `ADMIN_DATABASE_URL` boot checks (`core/role-check.ts`). The Dockerfile does NOT set it — it must be present in the Railway environment. Set on BOTH `app-api` and `app-worker`.
- `DATABASE_URL` — Postgres internal URL
- `REDIS_URL` — Redis internal URL
- `MINIO_ENDPOINT=MinIO.railway.internal`
- `MINIO_BUCKET` — bucket name for platform files (default `platform-files`; must be non-empty, `z.string().min(1)`). Same bucket is used across the whole deploy — tenant isolation is path-prefix based (`tenants/{tenantId}/...`), not per-bucket. Bucket versioning is enabled automatically at boot by `ensureBucket()` (#515).
- `JWT_SECRET`, `ENCRYPTION_KEY` — shared secrets
- `CORS_ORIGIN` — frontend public URL
- `FRONTEND_BASE_URL` — frontend public URL
- `REGISTRY_URL=http://app-registry.railway.internal:3002` — internal URL for the registry service, used by the marketplace `installFromRegistry` path (default: `http://localhost:3002` in dev)
- `API_PUBLIC_URL` — public base URL of the API; used to construct webhook registration URLs in the repositories domain. Dev: `http://localhost:3001`. Production: `https://<app-api-public-domain>`. Required for repositories domain webhook registration to succeed (falls back to `http://localhost:3001` when unset, which is incorrect in production).
- `RLS_ROLE_CHECK_MODE` — optional. Three values: `enforce` (default — throw on privileged role in production), `warn` (log but allow boot — emergency-only, use during role-rotation window), `auto` (recommended post-rotation steady-state — self-arming gate: increments clean-boot counter when non-privileged, throws once `RLS_AUTO_BOOT_THRESHOLD` consecutive clean boots have been observed and then a privileged role is detected). **Production currently runs `enforce`** (the var is unset on `app-api` / `app-worker` per the 2026-04-26 cutover; see CHANGELOG Phase 4). Switching to `auto` is a recommended follow-up deploy — it adds a self-arming guardrail without changing the failure mode under privileged-role detection. Keep `warn` only as an emergency escape hatch.
- `RLS_AUTO_BOOT_THRESHOLD` — optional, default `3`. Number of consecutive non-privileged-role boots required before `auto` mode self-arms. Only relevant when `RLS_ROLE_CHECK_MODE=auto`.
- `ALLOW_RATE_LIMIT_SOFT_FAIL` — optional; default unset → **production fails closed** (#841). The rate-limit plugin is a security control (brute-force protection on auth routes + per-tenant API quotas). If its boot registration throws in production, boot aborts rather than serving traffic with protection silently disabled. Set to `'true'` (string literal) ONLY as an operator-acknowledged emergency escape hatch to restore the legacy soft-fail (log error + `rate_limit_plugin_up=0` metric, continue WITHOUT rate limiting). In dev/test the soft-fail path is always used so local boot without Redis works. Set on BOTH `app-api` and `app-worker` — the worker also calls `buildApp()` and runs the same gate. Note: with `lazyConnect` Redis, registration rarely throws on a Redis outage; the gate primarily defends against synchronous misconfiguration. Runtime Redis failures fail closed independently via the plugin's pinned `skipOnError: false`.
- `MIGRATION_DATABASE_URL` — optional; connection string for the DDL-capable role used by `runMigrations()` at boot. Falls back to `DATABASE_URL` when unset (dev/local where both roles share the same URL). In production after role rotation: set to the `postgres` superuser connection string while `DATABASE_URL` switches to `orm_app` (NOSUPERUSER NOBYPASSRLS). Set on BOTH `app-api` and `app-worker` — both processes call `runMigrations()` at boot with an advisory lock that serializes them.
- `ADMIN_DATABASE_URL` — **required in production after role rotation.** Connection string for the `orm_admin` role (NOSUPERUSER BYPASSRLS, max pool 5). Used by the `withAdmin()` cross-tenant code paths in `core/db.ts:1813-1831`: pre-tenant-context auth lookups (api_keys bearer-token, oauth_clients client_credentials), super-admin console reads (platform-admin tenant aggregates / impersonation lookup), and cross-tenant maintenance crons (agent-executions `markStaleAsFailed` zombie cleanup). Without it, `withAdmin()` falls back to `DATABASE_URL` and every call site listed in `WITH_ADMIN_ALLOWLIST` raises `unrecognized configuration parameter "app.current_tenant_id"` under `orm_app` — which breaks bearer-token auth, client_credentials OAuth, the entire super-admin console, and the zombie-cleanup cron. Set on BOTH `app-api` and `app-worker`.
- `ALLOW_ENCRYPTION_KEY_ROTATION_BACKFILL` — **rare opt-in.** Set to `'true'` (string literal) on a deploy where `ENCRYPTION_KEY` has been INTENTIONALLY rotated AND the operator has manually completed the rotation runbook (re-encrypted every relevant column from the old key to the new one). Without this flag, the boot-time key-rotation guard (`core/crypto/key-rotation-guard.ts`) detects the fingerprint change and the runtime secret-decrypt read paths surface a typed `ENCRYPTION_KEY_ROTATION_DETECTED` 503 (instead of opaque 500s) until acknowledged. Setting the flag re-records the fingerprint so the read paths resume. Default unset on every deploy. Set on BOTH `app-api` and `app-worker` for the SINGLE deploy that follows the rotation, then unset on the next deploy. (The env var name retains the historical `_BACKFILL` suffix; the #738 boot backfills themselves were removed in Sub-phase I — greenfield, secrets encrypted-on-write.)
- `GITHUB_APP_ID` — optional; numeric GitHub App ID (stored as string). Required only when using GitHub App installation authentication for repository connections (`auth_type = 'github_app_installation'`). If set, `GITHUB_APP_PRIVATE_KEY` MUST also be set — partial config throws at server boot (#763 Phase D).
- `GITHUB_APP_PRIVATE_KEY` — optional; RSA private key (PEM format, include `-----BEGIN...` and `-----END...` lines with `\n` newlines). Used to sign GitHub App JWTs for installation token exchange. If set, `GITHUB_APP_ID` MUST also be set. Store as a multi-line secret in Railway (Railway preserves newlines in env vars). Set on BOTH `app-api` and `app-worker` — the worker's token-refresh processor proactively renews GitHub App installation tokens at the ~50-minute mark (60min lifetime − REFRESH_BUFFER_MS 10min; tokens are ~1h-lived).
- `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_DISCOVERY_URL` — optional; generic external-IdP (OIDC) social login (#546). When all three are set, a "Continue with {OIDC_DISPLAY_NAME}" button appears on the login page and an `oidc` provider is enabled at `/api/v1/auth/oauth/oidc`. Works with any standards-compliant IdP — WorkOS AuthKit, Auth0, Okta, Google, Microsoft Entra. `OIDC_DISCOVERY_URL` points at the IdP's `.well-known/openid-configuration` (e.g. `https://api.workos.com/sso/oidc/.well-known/openid-configuration`); the authorize/token/userinfo endpoints are resolved from it (cached 1h). **Partial config throws at boot** — all three must be set together. `app-api` only (the worker does not serve login). First OIDC login creates a passwordless user linked to the IdP `sub` in `user_identities`; subsequent logins match on `sub`. **As of #815 these `OIDC_*` (and `GITHUB_*`) env vars are a deployment-level FALLBACK**: per-tenant providers configured in the `sso_providers` table (admin UI `/admin/auth-providers`, `manageSso`) take precedence on slug collision, and the reserved slugs `oidc`/`github` keep the two identity namespaces disjoint. A tenant with its own DB-configured OIDC provider does not need these env vars set.
- `OIDC_SCOPES` — optional; space-separated OIDC scopes. Default `openid email profile`. Override only if the IdP requires extra scopes.
- `OIDC_DISPLAY_NAME` — optional; label shown on the login button ("Continue with {OIDC_DISPLAY_NAME}"). Default `SSO`. Set to the IdP's product name (e.g. `WorkOS`, `Okta`).
- `BULL_BOARD_USER` / `BULL_BOARD_PASSWORD` — optional; HTTP Basic Auth credentials for the Bull Board queue dashboard at `/admin/queues` (#839). The dashboard is browser-served HTML and cannot use a Bearer header, so it self-guards with Basic Auth instead of the JWT middleware. **The dashboard is NOT mounted unless BOTH are set, except when `NODE_ENV` is explicitly `development`/`test`** (fail closed — `/admin/queues` returns 404). The open-without-creds fallback is dev-convenience only and keys off the raw `NODE_ENV`; it does NOT rely on `NODE_ENV=production` being set, so a deploy with a missing/unexpected `NODE_ENV` still fails closed (Railway does not inject `NODE_ENV` automatically). When both are set, the dashboard requires these credentials (browser prompts; 401 + `WWW-Authenticate` without them). Operationally relevant to `app-api` only: `buildApp()` registers the plugin in `app-worker` too, but the worker is inject-only (never calls `app.listen()`), so the dashboard is never served there. Set both or neither; one alone is treated as unset.
- `DISABLE_SCRIPT_EXECUTION` — optional; default unset → tenant scripting **enabled**. Emergency kill-switch (#1106). When set to `'true'` (string literal), ALL tenant-authored script execution paths hard-fail before the sandbox is entered: script-backed custom skills, flow "script" steps, validation-rule scripts, and the classifier redact step. `executeScript()` returns a failed result (`error: 'Script execution is disabled by DISABLE_SCRIPT_EXECUTION'`) — no code runs, no platform API is called. It exists as an operator lever if the QuickJS WASM sandbox (#1106) ever shows a problem in production; the sandbox is a real isolation boundary (separate WASM JS engine, no host realm), so this should not normally be needed. **Set on BOTH `app-api` and `app-worker`** — the worker runs scripts via automation triggers/flows/actions. The default (unset) keeps the feature live. The kill-switch wins over every `SCRIPT_*` / `ALLOW_SCRIPT_*` var below.
- `SCRIPT_EXECUTION_MODE` — optional; default `worker` (#1121). `worker`: tenant scripts execute in a `worker_threads` pool so CPU-bound scripts cannot block the API event loop; host platform-API calls still run on the main thread (RBAC/audit unchanged). `inline`: the pre-#1121 same-thread execution — operator escape hatch only (a CPU-bound tenant script blocks every request on the process for its timeout slice). Set on BOTH `app-api` and `app-worker`.
- `SCRIPT_WORKER_POOL_SIZE` — optional; default `2`, max 16 (#1121). Number of script worker threads per process. 2 caps script CPU at 2 cores on small Railway containers without starving the API. Note: `app-worker` runs flow-execution at concurrency 3, so 3 concurrent flow-script steps serialize 3-into-2 on the default pool — bounded and fail-fast; raise on `app-worker` if flow-script throughput matters. Set on BOTH services (or per-service to size them differently).
- `SCRIPT_WORKER_QUEUE_MAX` — optional; default `100` (#1121). Bounded pending-script queue per process; overflow fails fast with `Script worker queue saturated` (never unbounded memory). Each queued task additionally has a queue-wait budget equal to its own timeout — expiry fails with the distinct `Script queue wait exceeded`.
- `ALLOW_SCRIPT_INLINE_FALLBACK` — **rare opt-in** (#1121, mirrors `ALLOW_RATE_LIMIT_SOFT_FAIL`'s posture). Default unset → when the script worker pool is unavailable (spawn failure, or degraded after 3 consecutive fast pre-first-task worker deaths), production **fails scripts closed** with the typed `Script worker pool unavailable` error and increments `script_worker_pool_unavailable_rejections_total`; the `script_worker_pool_degraded` gauge (0/1) is the alert signal, and the pool retries respawn every 60s. Set to `'true'` (string literal) ONLY as an operator-acknowledged emergency escape hatch: a degraded pool then falls back to inline (event-loop-blocking, pre-#1121) execution with a loud error log. Dev/test always allow the fallback. Set on BOTH `app-api` and `app-worker`.

### app-worker
- `RAILWAY_DOCKERFILE_PATH=packages/backend/Dockerfile.worker`
- `NODE_ENV=production` — **required**, same semantics as `app-api` above (security gates fail open when unset). The worker runs the same boot-time `role-check.ts` gate.
- Same env vars as `app-api`: `DATABASE_URL`, `REDIS_URL`, `MINIO_*`, `JWT_SECRET`, `ENCRYPTION_KEY`
- Also needs automation/AI secrets: `OAUTH_*`, `SMTP_*`/`RESEND_*`/`SENDGRID_*`, LLM provider keys
- `REGISTRY_URL=http://app-registry.railway.internal:3002` — same as `app-api`; the worker shares the marketplace service module and will call the registry if invoked from a job path
- `RLS_ROLE_CHECK_MODE` — same semantics as `app-api` above. Production currently runs `enforce` (var unset). The worker runs the same boot-time `checkDbRole()` gate; if `auto` is enabled in a follow-up deploy, set it on both `app-api` and `app-worker`.
- `RLS_AUTO_BOOT_THRESHOLD` — same as `app-api`. Must match if both services use `auto` mode.
- `ALLOW_RATE_LIMIT_SOFT_FAIL` — same semantics as `app-api` (#841). The worker calls `buildApp()`, so it runs the same fail-closed gate at boot. If used as an emergency escape hatch, set on both `app-api` and `app-worker`.
- `DISABLE_SCRIPT_EXECUTION` — same semantics as `app-api` (#1106). The worker runs tenant scripts via automation triggers/flows/actions, so the kill-switch MUST be set on both `app-api` and `app-worker` to fully disable scripting.
- `SCRIPT_EXECUTION_MODE` / `SCRIPT_WORKER_POOL_SIZE` / `SCRIPT_WORKER_QUEUE_MAX` / `ALLOW_SCRIPT_INLINE_FALLBACK` — same semantics as `app-api` above (#1121). The worker executes flow-script steps and agent script-skills through the same pool. `SCRIPT_WORKER_POOL_SIZE` may be raised here independently if flow-script throughput matters (flow-execution runs at concurrency 3 vs the default pool size of 2).
- `MIGRATION_DATABASE_URL` — same semantics as `app-api`. Must be set on both services during and after role rotation.
- `ADMIN_DATABASE_URL` — same semantics as `app-api` above. Required in production after role rotation. Without it, every cross-tenant call site listed in `WITH_ADMIN_ALLOWLIST` raises under `orm_app` — including the worker-side `markStaleAsFailed` zombie-cleanup cron. Must be set on both `app-api` and `app-worker`.
- `ALLOW_ENCRYPTION_KEY_ROTATION_BACKFILL` — same semantics as `app-api`. Must be set on both services for the single deploy following an intentional `ENCRYPTION_KEY` rotation; unset on the next deploy.
- `GITHUB_APP_ID` — same semantics as `app-api`. Must be set on both services when GitHub App auth is in use; the worker's token-refresh processor needs it to renew installation tokens at the ~50-minute mark (60min lifetime − REFRESH_BUFFER_MS 10min). If set, `GITHUB_APP_PRIVATE_KEY` MUST also be set (#763 Phase D).
- `GITHUB_APP_PRIVATE_KEY` — same semantics as `app-api`. Same paired-with-`GITHUB_APP_ID` rule. Set on both `app-api` and `app-worker`.
- No public domain — workers are internal-only (Redis + Postgres + MinIO connectivity only)
- Health: Railway process liveness (no HTTP healthcheck endpoint)
- Watch path: `packages/backend/**` — rebuilds when backend code changes
- **Manual setup required** — create `app-worker` service in Railway dashboard before first deploy

### app-frontend
- `RAILWAY_DOCKERFILE_PATH=packages/frontend/Dockerfile`
- **Serves on port 8080, not 80** (#1130). The image runs
  `nginxinc/nginx-unprivileged:alpine` as uid 101 so the container never holds
  root; an unprivileged nginx cannot bind a port below 1024, so 8080 is
  inherent to the non-root posture rather than a preference.
- `PORT` — **must be `8080`** as of #1130, in BOTH `production` and `staging`.
  Verified via the Railway API on 2026-07-19: no explicit *target port* is
  pinned on any service domain (`targetPort` is null), so routing follows the
  `PORT` variable — which is `80` in both environments today. nginx does not read `PORT`; its listen port
  is fixed in `nginx.conf.template`. So `PORT` is purely a routing hint here,
  and it must be kept in sync with that file by hand.
  **Ordering matters:** flipping `PORT` to `8080` while the deployed image still
  listens on 80 causes an outage, and leaving it at `80` after the #1130 image
  ships causes a 502. Set it immediately after the #1130 deploy goes live.
  **`PORT` must be changed WITH a redeploy, not on its own** — Railway's router
  only re-registers the target port on deploy, so `railway variables --set
  PORT=8080 --skip-deploys` leaves the edge pointing at the old port and the
  service returns connection-refused rather than recovering.
  `app-api` (3000) and `app-registry` (3002) are unaffected — their ports are
  unchanged and both are >1024.

  Rehearsed on `staging` 2026-07-19 before merge: deploying the #1130 image with
  `PORT=80` reproduced the 502 exactly; `PORT=8080` + redeploy returned 200,
  with `/assets` correctly emitting a relative `location: /assets/` over HTTP/2.
  Staging was then rolled back to main's deployment and `PORT` reset to 80.

- `API_HOST=app-api.railway.internal` — backend internal host for nginx proxy
- `API_PORT=3000`

### app-registry
- `RAILWAY_DOCKERFILE_PATH=packages/registry/Dockerfile`
- `DATABASE_URL` — same Postgres URL as backend
- `MINIO_ENDPOINT=MinIO.railway.internal`
- `JWT_SECRET` — same as backend (shared JWT verification)

## Internal Networking
- Services communicate via `<service-name>.railway.internal` (private DNS)
- Only services with a Railway domain are publicly accessible
- No port mapping needed — Railway routes traffic internally

## Deployment Flow
- Push to `main` → Railway auto-builds all app services (api, worker, frontend, registry)
- Each service uses its `RAILWAY_DOCKERFILE_PATH` to find the right Dockerfile
- Builds happen in parallel
- Database services don't rebuild on push
- `app-api` and `app-worker` always ship the same `dist/` from the same git SHA — no version skew

**⚠️ The staging release flow documented in `CLAUDE.md` does not match
reality.** `CLAUDE.md` describes `feature/*` → PR to `staging` → smoke test →
PR to `main`, and states that a push to `staging` auto-deploys the staging
environment. (The bullets above are silent on staging — they only cover
`main`.) As of 2026-07-19 there is **no `staging` branch** on the remote, and
the `staging` environment's services deploy from **`main`** — verified via the
Railway API, with both environments sitting on the identical commit. To
exercise a branch in staging you must deploy it explicitly (e.g. `railway up`
against the staging environment) and roll it back afterwards.

## Gotchas
- Railway CLI has no `service delete` command — use the web dashboard
- Must `railway link -s <name>` before running `vars`, `logs`, `domain` commands
- MinIO Docker image needs `RAILWAY_START_COMMAND` env var for the server command
- Frontend nginx config uses `envsubst` for `API_HOST`/`API_PORT` — don't hardcode backend URLs
- Redis must run `maxmemory-policy noeviction` (BullMQ's own requirement, and the assumption behind the `claimJobOnce` idempotency guard in `core/jobs/job-idempotency.ts` — a claim key must not be LRU-evicted out from under a live job). Don't switch Redis to an eviction policy.
