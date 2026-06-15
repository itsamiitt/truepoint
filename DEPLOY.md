# Deploying LeadWolf — Ubuntu preview runbook

This deploys the full app as a **Docker Compose stack on a single Ubuntu host**: the four
LeadWolf services (`web`, `auth`, `api`, `workers`), local Redis/Typesense/MailHog, and a
**Caddy** reverse proxy that terminates HTTPS and routes three subdomains. Postgres is
**external** (managed — Neon/RDS). It is a **working preview**, not the production AWS target
described in [ADR-0010](docs/planning/decisions/ADR-0010-aws-native-self-hosted-stack.md) —
see [Caveats](#caveats) before exposing it to real users.

> **First build, ever.** This codebase has not been built before, so the very first
> `next build` may surface TypeScript/build errors. That's expected — run it, and paste
> any errors back to me and I'll fix them. The build is the step to watch.

## What gets deployed

| Service   | Public URL                  | Runtime           | Notes                              |
|-----------|-----------------------------|-------------------|------------------------------------|
| caddy     | :80 / :443                  | caddy:2           | TLS + routes the subdomains below  |
| web       | `https://app.truepoint.in`  | Next.js (`start`) | Main app UI — the URL you visit    |
| auth      | `https://auth.truepoint.in` | Next.js (`start`) | Dedicated auth origin (IdP)        |
| api       | `https://api.truepoint.in`  | Bun + Hono        | Public API; `/health` for checks   |
| workers   | — (internal)                | Bun + BullMQ      | Background jobs                    |
| redis     | — (internal)                | redis:7           | cache / queues / pub-sub           |
| typesense | — (internal)                | typesense:27.1    | search                             |
| mailhog   | :8025 (localhost)           | mailhog           | captures outgoing email            |
| postgres  | **external**                | Neon / RDS        | set via `DATABASE_URL`             |

All four app services run from **one image** (`leadwolf:latest`) built once. Only Caddy
publishes ports to the internet (80/443); the app services are reached internally.

---

## Prerequisites

- Ubuntu **22.04 or 24.04**, **≥ 4 GB RAM** (8 GB comfortable — the Next build is memory-hungry), ≥ 10 GB disk.
- A managed **Postgres** (Neon/RDS) connection string.
- **DNS**: `A` records for `app`, `auth`, and `api` (`.truepoint.in`) all pointing at this server's public IP.
- **Ports 80 + 443** reachable from the internet (open them in the cloud firewall / EC2 Security Group). Caddy needs port 80 for the Let's Encrypt challenge.
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

- Set **`DATABASE_URL`** to your managed Postgres (append `?sslmode=require` for Neon).
- Set **`BLIND_INDEX_KEY`** to a long random string: `openssl rand -hex 32`.
- The `*_ORIGIN` / `NEXT_PUBLIC_*` values default to the `*.truepoint.in` subdomains — change them
  (and `deploy/Caddyfile`) if your domain differs. They're baked at build, so rebuild after changing.

## Step 4 — Generate JWT signing keys (enables login)

```bash
bash deploy/gen-keys.sh
```

Skip only if you just want the stack to boot without working authentication.

## Step 5 — Open the firewall

Open **80 + 443** in your cloud firewall / **EC2 Security Group** (this is separate from `ufw`).
If `ufw` is active on the host too:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

> DNS for `app`/`auth`/`api.truepoint.in` must resolve to this server **before** you deploy,
> or Caddy can't obtain TLS certificates.

## Step 6 — Deploy

```bash
bash deploy/deploy.sh
```

This builds the image, starts Redis/Typesense/MailHog, runs migrations against `DATABASE_URL`
(extensions + `leadwolf_app`/`leadwolf_admin` roles + tables + RLS policies), then starts the
app services and Caddy. The first run takes several minutes; Caddy then fetches certificates.

## Step 7 — Verify

```bash
docker compose -f docker-compose.prod.yml ps             # all services "running"
docker compose -f docker-compose.prod.yml exec -T api wget -qO- http://localhost:3001/health
curl https://api.truepoint.in/health                     # → {"status":"ok"} (once DNS+TLS are live)
```

Then open **`https://app.truepoint.in`** in a browser. Watch Caddy get certs with:
`docker compose -f docker-compose.prod.yml logs -f caddy`.

---

## Operating the stack

```bash
C="docker compose -f docker-compose.prod.yml"

$C logs -f api auth web workers     # tail logs
$C ps                                # status
$C restart api                       # restart one service
$C down                              # stop everything (keeps data volumes)
$C down -v                           # stop AND wipe Redis/Typesense/Caddy-cert volumes (NOT your external Postgres)
$C logs -f caddy                     # watch TLS certificate provisioning

# Redeploy after a code or .env change:
bash deploy/deploy.sh                # rebuilds image + restarts

# Re-run migrations only (bounded + non-interactive; streams [1/4]…[4/4] then "migrate: done."):
timeout 300 $C run --rm -T migrate

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
- **Browser loads the UI but API calls fail (CORS)** — `APP_ORIGINS` must exactly match `https://app.truepoint.in`, and `NEXT_PUBLIC_API_BASE` must be `https://api.truepoint.in`; rebuild after changing (`bash deploy/deploy.sh`).
- **Caddy won't get a certificate / site shows TLS error** — confirm the subdomain's DNS resolves to this server and ports 80+443 are open in the cloud firewall, then `docker compose -f docker-compose.prod.yml logs caddy`. Caddy retries automatically once DNS/ports are correct.
- **Migration hangs or errors on Neon's pooler** — migrations now run with `prepare: false` + short connect/lock timeouts, so the pooled host should work and a real problem fails fast instead of freezing. If you still prefer the direct host for migrations, set `DATABASE_MIGRATION_URL` in `.env.production` to Neon's **direct** (non-`-pooler`) host; the app keeps using the pooled `DATABASE_URL`.
- **Next.js misbehaves under Bun** — as a fallback I can switch the web/auth build+runtime to a Node base image; tell me and I'll adjust the Dockerfile.

---

## Caveats

This preview intentionally trades production-hardening for speed-to-live:

- **TLS is handled by Caddy** (auto Let's Encrypt). Fine for a preview; for production you'd front it with a managed load balancer / WAF.
- **Dev credentials remain** for Typesense (`dev`). Change before real use.
- **App connects to Postgres as the DB owner**, with RLS enforced via `SET LOCAL ROLE leadwolf_app` per transaction. On managed Postgres (Neon) the `leadwolf_admin` role is created **without** `BYPASSRLS` (superuser-only); it's unused until the DSAR path (M5), so this is safe.
- **Single host, no autoscaling/HA.** Redis/Typesense use local Docker volumes — back them up; your Postgres durability is whatever the managed provider gives you.
- The documented production target is **AWS (ECS/Aurora/ElastiCache/Terraform)** per ADR-0010; this compose stack is for previews/staging, not that.
