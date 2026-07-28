> **This file is a worked example, not a template.** It documents one real
> Railway deployment — the service names, env vars, and boot gates are the
> upstream project's, kept concrete because the *pattern* being taught only
> lands when you can see it applied end to end: every boot-gated var
> documented per-service, with a both-processes checklist, so an operator
> configuring one service from one section cannot miss a var whose absence
> crashes the other. Replace the specifics with your own; keep the shape.

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
- **Project:** laudable-sparkle
- **Project ID:** `da8395dd-2c59-4a5e-9c11-7d583c34f3bb`
- **Environment:** production
- **Dashboard:** https://railway.com/project/da8395dd-2c59-4a5e-9c11-7d583c34f3bb

## Services

| Service | Type | Internal Host | Public Domain | Dockerfile |
|---------|------|---------------|---------------|------------|
| Postgres | Database plugin | `postgres.railway.internal:5432` | — | — |
| Redis | Database plugin | `redis.railway.internal:6379` | — | — |
| MinIO | Docker image (`minio/minio:latest`) | `MinIO.railway.internal:9000` | — | — |
| app-api | GitHub repo | `app-api.railway.internal:3000` | `app-api-production.up.railway.app` | `packages/backend/Dockerfile` |
| app-worker | GitHub repo | *(internal only — no HTTP)* | — | `packages/backend/Dockerfile.worker` |
| app-frontend | GitHub repo | `app-frontend.railway.internal:8080` | `app-frontend-production-8ce6.up.railway.app` | `packages/frontend/Dockerfile` |
| app-registry | GitHub repo | `app-registry.railway.internal:3002` | `app-registry-production.up.railway.app` | `packages/registry/Dockerfile` |

## CLI Commands

```bash
# Link to project
railway link -p da8395dd-2c59-4a5e-9c11-7d583c34f3bb

# Link to a specific service (required before vars/logs/domain commands)
railway link -p da8395dd-2c59-4a5e-9c11-7d583c34f3bb -s <service-name>

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

Each app service needs `RAILWAY_DOCKERFILE_PATH` to tell Railway which
Dockerfile to use (monorepo).

**Boot-gate vars are validated on BOTH processes.** Any var enforced by a
`core/config.ts` boot gate (a `superRefine` both-or-neither pair, or an
environment-gated "`X=production` requires `Y`" guard) is checked at MODULE LOAD
by `loadConfig()`, which BOTH `index.ts` (app-api) AND `worker.ts` (app-worker)
import directly. The gate runs on every process, not just the HTTP-serving one —
so even a var the worker never functionally reads (its purge processor, its
cron, …) MUST be set there too, or it throws `Invalid configuration: …` on boot
as soon as the gating condition (e.g. `EBAY_ENVIRONMENT=production`) is set on
it. Two **mandatory** documentation consequences when adding such a var:

1. **Never** write "app-api only" for a var behind a `loadConfig()` gate — write
   "Set on BOTH `app-api` and `app-worker`" and name the module-load gate.
   (Below, **BOTH services** is shorthand for exactly that phrasing.)
2. It MUST also get its **own row in the `### app-worker` section** — this file's
   per-service-checklist convention (every both-services var: `GITHUB_APP_ID`,
   `ADMIN_DATABASE_URL`, `EBAY_CLIENT_ID`, …) — so an operator configuring the
   worker from that section alone can't miss it.

(PR #1229 / #1215: `EBAY_DELETION_VERIFICATION_TOKEN` shipped documented
"app-api only" — r3 HIGH, the CARD-SR-6 `superRefine` runs at module load on the
worker, so the promotion runbook as written boot-crashed app-worker; r5 then
caught its missing `### app-worker` bullet.)

### app-api

- `RAILWAY_DOCKERFILE_PATH=packages/backend/Dockerfile`
- `NODE_ENV=production` — **required.** Security gates read `process.env.NODE_ENV`
  directly and fail OPEN (dev posture) when unset: CORS localhost allowance
  (`plugins/cors.ts` `isAllowedOrigin` + the socket.io realtime origin in
  `core/realtime/realtime.ts`, #840), auth cookie `secure`/`sameSite=none`
  (`auth.routes.ts`), and the RLS role + `ADMIN_DATABASE_URL` boot checks
  (`core/role-check.ts`). The Dockerfile does NOT set it — it MUST be in the
  Railway environment. BOTH services.
- `DATABASE_URL` / `REDIS_URL` — internal Postgres / Redis URLs.
  `MINIO_ENDPOINT=MinIO.railway.internal`. `JWT_SECRET`, `ENCRYPTION_KEY` —
  shared secrets. `CORS_ORIGIN`, `FRONTEND_BASE_URL` — frontend public URL.
- `MINIO_BUCKET` — platform-file bucket; default `platform-files`, must be
  non-empty (`z.string().min(1)`). One bucket for the whole deploy — tenant
  isolation is path-prefix based (`tenants/{tenantId}/...`), not per-bucket.
  Versioning is enabled automatically at boot by `ensureBucket()` (#515).
- `REGISTRY_URL=http://app-registry.railway.internal:3002` — registry internal
  URL for the marketplace `installFromRegistry` path (dev default
  `http://localhost:3002`).
- `API_PUBLIC_URL` — public API base URL; builds repositories-domain webhook
  registration URLs. Dev `http://localhost:3001`, production
  `https://app-api-production.up.railway.app`. Required for that registration to
  succeed — when unset it falls back to `http://localhost:3001`, which is incorrect in
  production.
- `RLS_ROLE_CHECK_MODE` — optional. `enforce` (default — throw on privileged role
  in production); `warn` (log but allow boot — emergency-only, role-rotation
  window); `auto` (recommended post-rotation steady state, self-arming: counts
  clean non-privileged boots, throws once `RLS_AUTO_BOOT_THRESHOLD` consecutive
  clean boots precede a privileged-role detection). **Production runs `enforce`**
  (var unset on both services per the 2026-04-26 cutover; CHANGELOG Phase 4).
  `auto` is the recommended follow-up deploy — same failure mode, plus the
  self-arming guardrail. Keep `warn` only as an emergency escape hatch.
- `RLS_AUTO_BOOT_THRESHOLD` — optional, default `3`; consecutive
  non-privileged-role boots before `auto` self-arms. Only read under `auto`.
- `ALLOW_RATE_LIMIT_SOFT_FAIL` — optional; unset → **production fails closed**
  (#841): the plugin is a security control (auth brute-force + per-tenant
  quotas), so a boot-registration throw aborts boot rather than serving
  unprotected. Set `'true'` (string literal) ONLY as an operator-acknowledged emergency
  escape hatch → legacy soft-fail (log error + `rate_limit_plugin_up=0` metric, continue
  WITHOUT rate limiting). Dev/test always soft-fail so local boot without Redis
  works. BOTH services. With `lazyConnect` Redis, registration rarely throws on
  an outage — the gate mainly catches synchronous misconfiguration; runtime Redis
  failures fail closed via the pinned `skipOnError: false`.
- `MIGRATION_DATABASE_URL` — optional; DDL-capable role for `runMigrations()` at
  boot; falls back to `DATABASE_URL` when unset (dev/local, one shared role). In
  production after role rotation: the `postgres` superuser string, while
  `DATABASE_URL` switches to `orm_app` (NOSUPERUSER NOBYPASSRLS). BOTH services.
- `ADMIN_DATABASE_URL` — **required in production after role rotation**;
  `orm_admin` role (NOSUPERUSER BYPASSRLS, max pool 5) for the `withAdmin()`
  cross-tenant paths in `core/db.ts:1813-1831` — pre-tenant-context auth lookups
  (api_keys bearer-token, oauth_clients client_credentials), super-admin console
  reads (platform-admin tenant aggregates / impersonation lookup), cross-tenant
  crons (agent-executions `markStaleAsFailed` zombie cleanup). Unset,
  `withAdmin()` falls back to `DATABASE_URL` and every `WITH_ADMIN_ALLOWLIST`
  call site raises `unrecognized configuration parameter "app.current_tenant_id"`
  under `orm_app` — breaking bearer-token auth, client_credentials OAuth, the
  whole super-admin console, and the zombie cron. BOTH services.
- `ALLOW_ENCRYPTION_KEY_ROTATION_BACKFILL` — **rare opt-in.** `'true'` (string
  literal) ONLY on a deploy where `ENCRYPTION_KEY` was INTENTIONALLY rotated AND
  the operator manually completed the rotation runbook (re-encrypted every
  relevant column, old key → new). Otherwise the boot-time guard
  (`core/crypto/key-rotation-guard.ts`) detects the fingerprint change and
  secret-decrypt reads surface a typed `ENCRYPTION_KEY_ROTATION_DETECTED` 503
  (not opaque 500s) until acknowledged; the flag re-records the fingerprint so
  reads resume. Default unset on every deploy. BOTH services, for the SINGLE
  post-rotation deploy, then unset. (The `_BACKFILL` suffix is historical —
  #738's boot backfills were removed in Sub-phase I; greenfield, secrets are
  encrypted-on-write.)
- `GITHUB_APP_ID` — optional; numeric App ID (stored as string), needed only for
  GitHub App installation auth on repository connections (`auth_type =
  'github_app_installation'`). If set, `GITHUB_APP_PRIVATE_KEY` MUST also be set
  — partial config throws at boot (#763 Phase D). BOTH services.
- `GITHUB_APP_PRIVATE_KEY` — optional; RSA PEM (`-----BEGIN...` / `-----END...`
  lines, `\n` newlines) signing App JWTs for installation-token exchange. If set,
  `GITHUB_APP_ID` MUST also be set. Store as a multi-line Railway secret (Railway
  preserves newlines). BOTH services.
- `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` — optional; Cardhouse RH-2 (#1214,
  CARD-SR-3) platform-owned shared eBay keyset, one keyset across every tenant
  (#1053 Option A). If one is set BOTH must be — partial config throws at boot
  (`core/config.ts` `superRefine`, mirroring the `GITHUB_APP_ID` /
  `GITHUB_APP_PRIVATE_KEY` pair). Read via `getMarketplaceCredential('ebay')`
  (`core/marketplace/marketplace-credentials.ts`); never stored in
  `integration_connections` (tenant-scoped — wrong home for a shared credential),
  see `{{PATHS_SPECS_DIR}}/cardhouse-security-requirements.md` CARD-SR-3. BOTH services.
- `EBAY_ENVIRONMENT` — optional; `sandbox` (default) or `production`. **#1215
  (CARD-SR-6) shipped the account-deletion compliance endpoint**; sandbox stays
  the default until an operator completes the runbook below (the code no longer
  gates on an unbuilt endpoint). BOTH services.

  **Production-promotion runbook:**
  1. Set `EBAY_DELETION_VERIFICATION_TOKEN` on BOTH `app-api` and `app-worker`.
     Boot-gated: config parse fails if `EBAY_ENVIRONMENT=production` is set
     without it (`core/config.ts` `superRefine`), and step 4 flips that on both
     processes — so the token MUST be on both or the worker crashes on boot.
  2. Confirm `API_PUBLIC_URL` is set — the eBay-registered URL must be
     byte-identical to
     `${API_PUBLIC_URL}/api/v1/marketplace-compliance/ebay/account-deletion`. A
     mismatch (or missing `API_PUBLIC_URL` in production) fails the challenge
     hash silently, unless `apiPublicUrl()`'s guard catches the missing-var case
     (`EBAY_DELETION_API_PUBLIC_URL_MISSING`, 500).
  3. Register that URL + the token in the eBay developer portal; eBay
     immediately fires the `GET ?challenge_code=...` handshake — watch `app-api`
     logs and confirm a 200.
  4. Only after the challenge succeeds, flip `EBAY_ENVIRONMENT=production` on
     BOTH `app-api` and `app-worker`.
- `EBAY_DELETION_VERIFICATION_TOKEN` — optional; Cardhouse RH-3 (#1215,
  CARD-SR-6) operator-chosen token for the account-deletion endpoint's
  challenge-response handshake (32–80 chars, `[A-Za-z0-9_-]`), entered in the
  eBay developer portal with the endpoint URL. Until set, both endpoint verbs
  answer `503 EBAY_DELETION_NOT_CONFIGURED`. **Boot-gated in production**:
  `EBAY_ENVIRONMENT=production` without it fails config parse (CARD-SR-6 —
  promotion is gated on the compliance endpoint being configured). NOT paired
  with the keyset (`EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET`): the challenge
  handshake needs only this token; notification signature verification needs the
  keyset too, enforced at runtime with typed 503s. BOTH services — module-load
  gate, see the app-worker row.
- `EBAY_DAILY_CALL_CAP` — optional; default `5000`. App-level daily call-budget
  cap enforced by the cross-tenant marketplace call-budget ledger
  (`core/marketplace/marketplace-budget.ts`, #1214, CARD-SR-4). **Provisional
  figure** from #1053's still-open recommended-at-N=1 Option A; see
  `{{PATHS_CONTEXT_DIR}}/DEFERRED_ITEMS.md` "CARD-SR-4 5k/day app-level call-budget
  figure". Re-tunable via this env var without a code change. BOTH services.
- **Recovering a failed deletion purge** (#1215, CARD-SR-6) — the endpoint
  returns `200 accepted` as soon as a notification's signature verifies, BEFORE
  the async purge runs, so a purge that exhausts its 5 BullMQ attempts leaves a
  `marketplace_deletion_notifications` row at `purge_status IN
  ('partial','failed')` and eBay (having seen the `200`) never redelivers it.
  **No automated recovery in v1**: the purge-target registry is empty, so every
  real attempt returns `no_data` and the state is unreachable until the first
  Cardhouse purge target registers — at which point a periodic reconciliation
  worker MUST land in the same PR (spec Sub-Phase C "Deferred: reconciliation
  sweep"). Until then, manual recovery — an ops/SQL action, there is no admin UI
  or API over the audit table in v1:
  1. `SELECT` the stuck rows (`WHERE purge_status IN ('partial','failed')`).
  2. Clear the retained FAILED BullMQ job FIRST — `ebayDeletionPurgeQueue.clean(0,
     N, 'failed')`, or remove the specific
     `ebay-del-purge-<notificationId>-<publishAttempt>` jobId. BullMQ's `add()`
     no-ops against a retained FAILED jobId, so this step MUST precede step 3 or
     the re-enqueue does nothing.
  3. Re-enqueue the purge for those `notificationId`s.
- `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_DISCOVERY_URL` — optional;
  generic external-IdP (OIDC) social login (#546). All three set → a "Continue
  with {OIDC_DISPLAY_NAME}" button on the login page and an `oidc` provider at
  `/api/v1/auth/oauth/oidc`. Any standards-compliant IdP works (WorkOS AuthKit,
  Auth0, Okta, Google, Microsoft Entra); `OIDC_DISCOVERY_URL` points at the IdP's
  `.well-known/openid-configuration` (e.g.
  `https://api.workos.com/sso/oidc/.well-known/openid-configuration`) and the
  authorize/token/userinfo endpoints resolve from it (cached 1h). **Partial
  config throws at boot** — all three MUST be set together. `app-api` only (the
  worker does not serve login). First OIDC login creates a passwordless user
  linked to the IdP `sub` in `user_identities`; later logins match on `sub`. **As
  of #815 the `OIDC_*` (and `GITHUB_*`) vars are a deployment-level FALLBACK**:
  per-tenant providers in the `sso_providers` table (admin UI
  `/admin/auth-providers`, `manageSso`) win on slug collision, and the reserved
  slugs `oidc`/`github` keep the identity namespaces disjoint — a tenant with its
  own DB-configured provider needs none of these.
- `OIDC_SCOPES` — optional; space-separated, default `openid email profile`;
  override only if the IdP requires extra scopes. `OIDC_DISPLAY_NAME` —
  optional; login-button label ("Continue with {OIDC_DISPLAY_NAME}"), default
  `SSO`; set to the IdP's product name (`WorkOS`, `Okta`).
- `BULL_BOARD_USER` / `BULL_BOARD_PASSWORD` — optional; Basic Auth for the Bull
  Board queue dashboard at `/admin/queues` (#839) — browser-served HTML can't
  send a Bearer header, so it self-guards instead of using the JWT middleware.
  **NOT mounted unless BOTH are set, except when `NODE_ENV` is explicitly
  `development`/`test`** (fail closed — 404). That open-without-creds fallback is
  dev-only and keys off the raw `NODE_ENV`; it does NOT require
  `NODE_ENV=production`, so a missing/unexpected `NODE_ENV` still fails closed
  (Railway does not inject `NODE_ENV`). With both set: browser prompts, 401 +
  `WWW-Authenticate` until supplied. `app-api` only in practice — `buildApp()`
  registers the plugin on `app-worker` too, but that process is inject-only
  (never calls `app.listen()`), so it is never served there. Set both or neither
  — one alone is treated as unset.
- `DISABLE_SCRIPT_EXECUTION` — optional; unset → tenant scripting **enabled**.
  Emergency kill-switch (#1106): `'true'` (string literal) hard-fails ALL
  tenant-authored script paths before the sandbox is entered — script-backed
  custom skills, flow "script" steps, validation-rule scripts, the classifier
  redact step. `executeScript()` returns a failed result (`error: 'Script
  execution is disabled by DISABLE_SCRIPT_EXECUTION'`); no code runs, no platform
  API is called. An operator lever if the QuickJS WASM sandbox ever misbehaves —
  that sandbox is a real isolation boundary (separate WASM JS engine, no host
  realm), so it should not normally be needed. BOTH services. This kill-switch
  wins over every `SCRIPT_*` / `ALLOW_SCRIPT_*` var below.
- `SCRIPT_EXECUTION_MODE` — optional; default `worker` (#1121). `worker`: scripts
  run in a `worker_threads` pool so CPU-bound scripts can't block the API event
  loop (host platform-API calls still run on the main thread; RBAC/audit
  unchanged). `inline`: pre-#1121 same-thread execution, operator escape hatch
  only — a CPU-bound tenant script blocks every request on the process for its
  timeout slice. BOTH services.
- `SCRIPT_WORKER_POOL_SIZE` — optional; default `2`, max 16 (#1121). Script
  worker threads per process; 2 caps script CPU at 2 cores on small Railway
  containers without starving the API. BOTH services (or per-service sizing) —
  see the app-worker row for its concurrency-3 delta.
- `SCRIPT_WORKER_QUEUE_MAX` — optional; default `100` (#1121). Bounded
  pending-script queue per process; overflow fails fast with `Script worker queue
  saturated` (never unbounded memory). Each queued task also carries a queue-wait
  budget equal to its own timeout — expiry fails with the distinct `Script queue
  wait exceeded`.
- `ALLOW_SCRIPT_INLINE_FALLBACK` — **rare opt-in** (#1121; mirrors
  `ALLOW_RATE_LIMIT_SOFT_FAIL`'s posture). Unset → when the script worker pool is
  unavailable (spawn failure, or degraded after 3 consecutive fast
  pre-first-task worker deaths) production **fails scripts closed**: typed
  `Script worker pool unavailable` error,
  `script_worker_pool_unavailable_rejections_total` incremented,
  `script_worker_pool_degraded` gauge (0/1) as the alert signal, pool retrying
  respawn every 60s. Set `'true'` (string literal) ONLY as an operator-acknowledged
  emergency escape hatch — a degraded pool then falls back to inline
  (event-loop-blocking, pre-#1121) execution with a loud error log. Dev/test
  always allow the fallback. BOTH services.

### app-worker

- `RAILWAY_DOCKERFILE_PATH=packages/backend/Dockerfile.worker`
- Also needs the automation/AI secrets: `OAUTH_*`, `SMTP_*`/`RESEND_*`/
  `SENDGRID_*`, LLM provider keys.
- `PRICECHARTING_API_TOKEN` — optional; Cardhouse P1.2 (#1058) platform-level,
  non-tenant PriceCharting API token consumed by the collectible-catalog
  freshness-refresh worker's `fetchBulk` (`core/collectibles/catalog-sources.ts`).
  **`app-worker` only** — the refresh runs on the weekly
  `collectible-catalog-refresh` BullMQ queue/worker (`app-api` does not need it).
  Unset, `processCatalogRefresh` treats the source as unconfigured and skips it
  with a single `logger.info` (expected steady state, not an error) — no ingest
  run is recorded. **Leave unset in every environment until #1054 records
  license/ToS facts** for PriceCharting (mirrors the CARD-SR-2/-3 provisional
  posture above).
- **Catalog embeddings (#1059) consume the existing `OPENAI_API_KEY` on
  `app-worker`** — already listed above under "LLM provider keys"; #1059 adds
  no new env var. When unset, the hourly `collectible-catalog-embedding-sweep`
  tick logs one `info` line and skips (expected steady state until Cardhouse
  goes live, not an error) — same posture as `PRICECHARTING_API_TOKEN` above.

Every var below, whenever it is set at all, MUST also be set on
`app-worker`; each var's own applicability conditions and full semantics
(default, gate, failure mode) live in the app-api section above — the right
column is only the worker-specific reason/delta. **This table IS the
worker's per-service checklist** — an operator MUST be able to see from it
alone WHICH vars the worker needs.

| Var | Worker-specific reason / delta |
|---|---|
| `NODE_ENV=production` | **Required** — same fail-open gates; the worker runs the same boot-time `role-check.ts` gate. |
| `DATABASE_URL`, `REDIS_URL`, `MINIO_*`, `JWT_SECRET`, `ENCRYPTION_KEY` | Same values as `app-api`. |
| `REGISTRY_URL` | Shares the marketplace service module; calls the registry if invoked from a job path. |
| `RLS_ROLE_CHECK_MODE` | Worker runs the same boot-time `checkDbRole()` gate; enable `auto` on both services together. |
| `RLS_AUTO_BOOT_THRESHOLD` | Must match `app-api` if both use `auto`. |
| `ALLOW_RATE_LIMIT_SOFT_FAIL` | Only if used as an emergency escape hatch — the worker calls `buildApp()`, so the same fail-closed gate runs at boot (#841). |
| `DISABLE_SCRIPT_EXECUTION` | The worker runs tenant scripts via automation triggers/flows/actions — required on both to fully disable scripting (#1106). |
| `SCRIPT_EXECUTION_MODE`, `SCRIPT_WORKER_QUEUE_MAX`, `ALLOW_SCRIPT_INLINE_FALLBACK` | The worker runs flow-script steps and agent script-skills through the same pool (#1121). |
| `SCRIPT_WORKER_POOL_SIZE` | May be raised here independently: flow-execution runs at concurrency 3, so 3 concurrent flow-script steps serialize 3-into-2 on the default pool of 2 (bounded, fail-fast). |
| `MIGRATION_DATABASE_URL` | Required during AND after role rotation — both processes call `runMigrations()` at boot under an advisory lock that serializes them. |
| `ADMIN_DATABASE_URL` | Required in production after role rotation — the worker-side `markStaleAsFailed` zombie-cleanup cron is itself a `WITH_ADMIN_ALLOWLIST` call site. |
| `ALLOW_ENCRYPTION_KEY_ROTATION_BACKFILL` | Only for the single post-rotation deploy; unset on the next one. |
| `GITHUB_APP_ID` | Required when GitHub App auth is in use — the worker's token-refresh processor renews installation tokens at the ~50-minute mark (60min lifetime − REFRESH_BUFFER_MS 10min; tokens ~1h-lived). |
| `GITHUB_APP_PRIVATE_KEY` | Same `GITHUB_APP_ID` pairing rule (#763 Phase D). |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` / `EBAY_ENVIRONMENT` / `EBAY_DAILY_CALL_CAP` | The worker runs the #1063 scanner workloads that consume the shared keyset and debit the call-budget ledger (#1214, CARD-SR-3/-4). |
| `EBAY_DELETION_VERIFICATION_TOKEN` | CARD-SR-6 `superRefine` runs at module load here too (`worker.ts` imports `config.js` directly), so `EBAY_ENVIRONMENT=production` without it crashes app-worker at boot — even though the worker serves no HTTP and never reads the value (#1215). |

- No public domain — workers are internal-only (Redis + Postgres + MinIO
  connectivity only)
- Health: Railway process liveness (no HTTP healthcheck endpoint)
- Watch path: `packages/backend/**` — rebuilds when backend code changes
- **Manual setup required** — create `app-worker` service in the Railway
  dashboard before first deploy

### app-frontend
- `RAILWAY_DOCKERFILE_PATH=packages/frontend/Dockerfile`
- **Serves on port 8080, not 80** (#1130). The image runs
  `nginxinc/nginx-unprivileged:alpine` as uid 101 so the container never holds
  root; an unprivileged nginx cannot bind a port below 1024, so 8080 is inherent
  to the non-root posture rather than a preference.
- `PORT` — **must be `8080`** as of #1130, in BOTH `production` and `staging`.
  Verified via the Railway API on 2026-07-19: no explicit *target port* is pinned
  on any service domain (`targetPort` is null), so routing follows the `PORT`
  variable — which is `80` in both environments today. nginx does not read
  `PORT`; its listen port is fixed in `nginx.conf.template`. So `PORT` is purely
  a routing hint here, and it must be kept in sync with that file by hand.
  **Ordering matters:** flipping `PORT` to `8080` while the deployed image still
  listens on 80 causes an outage, and leaving it at `80` after the #1130 image
  ships causes a 502 — set it immediately after the #1130 deploy goes live.
  **`PORT` must be changed WITH a redeploy, not on its own** — Railway's router
  only re-registers the target port on deploy, so `railway variables --set
  PORT=8080 --skip-deploys` leaves the edge pointing at the old port and the
  service returns connection-refused rather than recovering.
  `app-api` (3000) and `app-registry` (3002) are unaffected — their ports are
  unchanged and both are >1024.
  Rehearsed on `staging` 2026-07-19 before merge: the #1130 image with `PORT=80`
  reproduced the 502 exactly; `PORT=8080` + redeploy returned 200, with
  `/assets` emitting a relative `location: /assets/` over HTTP/2. Staging was
  then rolled back to main's deployment and `PORT` reset to 80.
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

**⚠️ The staging release flow documented in `CLAUDE.md` does not match reality.**
`CLAUDE.md` describes `feature/*` → PR to `staging` → smoke test → PR to `main`,
and states that a push to `staging` auto-deploys the staging environment. (The
bullets above are silent on staging — they only cover `main`.) As of 2026-07-19
there is **no `staging` branch** on the remote, and the `staging` environment's
services deploy from **`main`** — verified via the Railway API, both environments
sitting on the identical commit. To exercise a branch in staging you must deploy
it explicitly (e.g. `railway up` against the staging environment) and roll it
back afterwards.

## Gotchas
- Railway CLI has no `service delete` command — use the web dashboard
- Must `railway link -s <name>` before running `vars`, `logs`, `domain` commands
- MinIO Docker image needs `RAILWAY_START_COMMAND` env var for the server command
- Frontend nginx config uses `envsubst` for `API_HOST`/`API_PORT` — don't hardcode backend URLs
- Redis must run `maxmemory-policy noeviction` (BullMQ's own requirement, and the assumption behind the `claimJobOnce` idempotency guard in `core/jobs/job-idempotency.ts` — a claim key must not be LRU-evicted out from under a live job). Don't switch Redis to an eviction policy.
