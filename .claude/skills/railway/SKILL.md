---
name: railway
description: Manage Railway deployment — check status, view logs, set vars, redeploy services
argument-hint: "[status|logs|vars|redeploy|domain] [service-name]"
---

# Railway: $ARGUMENTS

Manage the Railway deployment for the ORM platform.

## Commands

### `status`
Show deployment status for all services.
```bash
railway link -p da8395dd-2c59-4a5e-9c11-7d583c34f3bb
railway service status --all --json
```
Report: service name, status (SUCCESS/BUILDING/FAILED), stopped flag.

### `logs [service-name]`
View recent logs for a service. Default: app-api.
```bash
railway link -p da8395dd-2c59-4a5e-9c11-7d583c34f3bb -s $1
railway logs
```

### `vars [service-name]`
List environment variables for a service. Default: app-api.
```bash
railway link -p da8395dd-2c59-4a5e-9c11-7d583c34f3bb -s $1
railway vars
```
To set: `railway vars set KEY=VALUE`

### `redeploy [service-name]`
Trigger a redeploy of a service. Default: all app services.
```bash
railway service redeploy -s app-api
railway service redeploy -s app-frontend
railway service redeploy -s app-registry
```

### `domain [service-name]`
Show or generate a public domain for a service.
```bash
railway link -p da8395dd-2c59-4a5e-9c11-7d583c34f3bb -s $1
railway domain
```

## Service Names
- `app-api` — Backend API (Fastify, port 3000)
- `app-frontend` — Frontend (nginx + React, port 8080 — non-root nginx, #1130)
- `app-registry` — Package registry (Fastify, port 3002)
- `Postgres` — PostgreSQL database
- `Redis` — Redis cache
- `MinIO` — Object storage

## Quick Reference
- **Project ID:** `da8395dd-2c59-4a5e-9c11-7d583c34f3bb`
- **Dashboard:** https://railway.com/project/da8395dd-2c59-4a5e-9c11-7d583c34f3bb
- Auto-deploys on push to `main`
- See `{{PATHS_RULES_DIR}}/railway.md` for full env var reference
