# Agent Instructions (Omniscripta Frontend)

Read this first, then follow the detailed runbook:
- `/var/www/omniscripta-app/.agent/workflows/operations_runbook.md`

## Scope
- This file applies to the frontend repo rooted at `/var/www/omniscripta-app`.

## Repo relationship
- Frontend source is here: `/var/www/omniscripta-app`.
- Backend live is `/srv/transcribe`.
- Backend dev is `/home/gunnar/projects/transcribe-dev`.

## Test paths
- Live-backend frontend path: `http://localhost:8080/index.html`.
- Dev-backend frontend path: `http://127.0.0.1:18010/index.html` (via tunnel to server `127.0.0.1:8010`).

## Deploy
- Deploy to live static: `/var/www/omniscripta-app/deploy.sh`.
- Deploy to dev static: `/var/www/omniscripta-app/deploy-dev.sh`.
- Do not edit built static artifacts directly in `/srv/transcribe/static`.

## Services
- Server-side dev proxy service: `transcribe-frontend-dev.service`.
- Dev backend services: `transcribe-api-dev.service`, `transcribe-worker-dev@.service`.

## Secrets
- LLM key is server-side worker config, not frontend browser config.
- Live key source: `/etc/transcribe/transcribe.env`.
- Dev key source: `~/.config/transcribe/dev.env`.
