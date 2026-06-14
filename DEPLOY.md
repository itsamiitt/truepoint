# Deploying LeadWolf — Ubuntu preview runbook

This deploys the full app as a **Docker Compose stack on a single Ubuntu host**: the four
LeadWolf services (`web`, `auth`, `api`, `workers`) plus their dependencies
(Postgres, Redis, Typesense, MailHog). It is a **working preview**, not the production
AWS target described in [ADR-0010](docs/planning/decisions/ADR-0010-aws-native-self-hosted-stack.md) —
see [Caveats](#caveats) before exposing it to real users.

> **First build, ever.** This codebase has not been built before, so the very first
> `next build` may surface TypeScript/build errors. That's expected — run it, and paste
> any errors back to me and I'll fix them. Steps 1–5 are infrastructure and won't fail;
> step 6 (build) is where to watch.

## What gets deployed

| Service   | Port | Runtime            | Notes                                  |
|-----------|------|--------------------|----------------------------------------|
| web       | 3002 | Next.js (`start`)  | Main app UI — the URL you visit        |
| auth      | 3000 | Next.js (`start`)  | Dedicated auth origin (IdP)            |
| api       | 3001 | Bun + Hono         | Public API; `/health` for checks       |
| workers   | —    | Bun + BullMQ       | Background jobs (no port)              |
| postgres  | 5432 | postgres:16        | localhost-only                          |
| redis     | —    | redis:7            | cache / queues / pub-sub               |
| typesense | —    | typesense:27.1     | search                                 |
| mailhog   | 8025 | mailhog            | captures outgoing email; localhost-only|

All four app services run from **one image** (`leadwolf:latest`) built once.

---

## Prerequisites

- Ubuntu **22.04 or 24.04**, **≥ 4 GB RAM** (8 GB comfortable — the Next build is memory-hungry), ≥ 10 GB disk.
- A public **IP or domain** for the server.
- `sudo` access.

---

## Step 1 — Install Docker

```bash
# Docker Engine + Compose plugin (official convenience script)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"     # run docker without sudo
newgrp docker                        # apply the group in this shell (or log out/in)

docker --version
docker compose version               # must be v2 ("Docker Compose version v2.x")
```

## Step 2 — Get the code onto the server

**Option A — git (recommended).** First commit the deploy files from your machine and push,
then on the server:

```bash
git clone <your-repo-url> leadwolf
cd leadwolf
```

**Option B — copy from your Windows machine** (run in PowerShell locally):

```powershell
scp -r C:\Users\Administrator\Downloads\DuskWolf user@SERVER_IP:~/leadwolf
```

Then on the server: `cd ~/leadwolf`.

## Step 3 — Configure environment

```bash
cp deploy/env.production.template .env.production
nano .env.production
```

Edit these:

- Replace **every `PUBLIC_HOST`** with your server's public IP or domain (not `localhost`).
- Set **`BLIND_INDEX_KEY`** to a long random string: `openssl rand -hex 32`.
- (Optional) change the Postgres/Typesense creds — if you do, keep `DATABASE_URL` in sync
  and update `docker-compose.prod.yml` to match.

## Step 4 — Generate JWT signing keys (enables login)

```bash
bash deploy/gen-keys.sh
```

Skip only if you just want the stack to boot without working authentication.

## Step 5 — Open the firewall (if enabled)

```bash
sudo ufw allow 3000/tcp   # auth
sudo ufw allow 3001/tcp   # api
sudo ufw allow 3002/tcp   # web
```

## Step 6 — Deploy

```bash
bash deploy/deploy.sh
```

This builds the image, starts infrastructure, waits for Postgres, runs migrations
(extensions + `leadwolf_app`/`leadwolf_admin` roles + tables + RLS policies), then starts
the app services. The first run takes several minutes.

## Step 7 — Verify

```bash
curl http://localhost:3001/health         # → {"status":"ok"}
docker compose -f docker-compose.prod.yml ps   # all services "running"/"healthy"
```

Then open **`http://PUBLIC_HOST:3002`** in a browser.

---

## Operating the stack

```bash
C="docker compose -f docker-compose.prod.yml"

$C logs -f api auth web workers     # tail logs
$C ps                                # status
$C restart api                       # restart one service
$C down                              # stop everything (keeps data volumes)
$C down -v                           # stop AND wipe Postgres/Redis/Typesense data

# Redeploy after a code or .env change:
bash deploy/deploy.sh                # rebuilds image + restarts

# Re-run migrations only:
$C run --rm migrate

# Seed demo data (optional, one-shot):
$C --profile seed run --rm seed
```

View captured email (MailHog) over an SSH tunnel from your machine:

```bash
ssh -L 8025:localhost:8025 user@SERVER_IP    # then open http://localhost:8025
```

---

## Troubleshooting

- **`next build` fails** — paste the error to me. Likely a type or import issue to fix in source.
- **`docker build` can't use `--secret`** — ensure Docker ≥ 20.10 (BuildKit). `deploy.sh` sets `DOCKER_BUILDKIT=1`.
- **Out of memory during build** — add swap: `sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`.
- **A service exits on boot with "Invalid environment configuration"** — a required key in `.env.production` is missing/invalid; the log lists exactly which one.
- **Browser loads the UI but API calls fail (CORS / connection refused)** — `NEXT_PUBLIC_*` and `APP_ORIGINS` must use the real public host (not `localhost`), and you must rebuild after changing them (`bash deploy/deploy.sh`).
- **Next.js misbehaves under Bun** — as a fallback I can switch the web/auth build+runtime to a Node base image; tell me and I'll adjust the Dockerfile.

---

## Caveats

This preview intentionally trades production-hardening for speed-to-live:

- **No TLS.** Traffic is plain HTTP. For anything real, put **Caddy or Nginx** in front for HTTPS (I can add a Caddy service that terminates TLS and routes the three origins — just ask).
- **Dev credentials.** Postgres `leadwolf/leadwolf`, Typesense key `dev`. Change them before real use.
- **App connects to Postgres as the DB owner**, with RLS enforced via `SET LOCAL ROLE leadwolf_app` per transaction. The intended hardening (a dedicated non-owner connection role) is a follow-up.
- **Single host, no autoscaling/HA**, local Docker volumes for data — back them up yourself.
- The documented production target is **AWS (ECS/Aurora/ElastiCache/Terraform)** per ADR-0010; this compose stack is for previews/staging, not that.
