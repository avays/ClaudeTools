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
railway link -p <RAILWAY_PROJECT_ID>
railway service status --all --json
```
Report: service name, status (SUCCESS/BUILDING/FAILED), stopped flag.

### `logs [service-name]`
View recent logs for a service. Default: app-api.
```bash
railway link -p <RAILWAY_PROJECT_ID> -s $1
railway logs
```

### `vars [service-name]`
List environment variables for a service. Default: app-api.
```bash
railway link -p <RAILWAY_PROJECT_ID> -s $1
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
railway link -p <RAILWAY_PROJECT_ID> -s $1
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
- **Project ID:** `<RAILWAY_PROJECT_ID>`
- **Dashboard:** https://railway.com/project/<RAILWAY_PROJECT_ID>
- Auto-deploys on push to `main`
- See `.claude/rules/railway.md` for full env var reference
