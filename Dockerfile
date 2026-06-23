# syntax=docker/dockerfile:1.7
# TruePoint — ONE image for all four services (web, auth, api, workers).
#   • api / workers run TypeScript directly under Bun (no build step).
#   • web / auth are Next.js apps (next build → next start; not standalone).
# The compose file overrides CMD per service, so the same image runs everything.
#
# Build-time env arrives via a BuildKit secret (id=dotenv) so NO secret value lands
# in an image layer. Only NEXT_PUBLIC_* values get inlined into the web bundle — those
# are public by design. The build is invoked by deploy/deploy.sh:
#   DOCKER_BUILDKIT=1 docker build --secret id=dotenv,src=.env.production -t leadwolf:latest .

FROM oven/bun:1.3.14 AS build
WORKDIR /app

# Install ALL workspace deps, including devDependencies (drizzle-kit, next type defs, …).
# NOTE: NODE_ENV must NOT be "production" here, or Bun would skip devDependencies.
COPY . .
RUN bun install --frozen-lockfile

# Build the Next apps directly — NOT `turbo run build`. The workspace has a declared
# dependency cycle (@leadwolf/db's test-only devDependency on @leadwolf/core) that makes
# Turbo refuse the package graph. The Next apps don't need Turbo orchestration: they
# transpile the workspace TS packages themselves, and there is no runtime module cycle
# (db/src never imports core). api/workers need no build step (Bun runs their TS directly).
# Source the env so NEXT_PUBLIC_* inline correctly and @leadwolf/config's fail-fast boot
# validation passes during `next build`.
RUN --mount=type=secret,id=dotenv \
    sh -c 'set -a; [ -f /run/secrets/dotenv ] && . /run/secrets/dotenv; set +a; \
           bun run --filter "@leadwolf/web" build && \
           bun run --filter "@leadwolf/auth-app" build'

ENV NODE_ENV=production
# web 3002 · auth 3000 · api 3001
EXPOSE 3000 3001 3002

# Default command; overridden per-service in docker-compose.prod.yml.
CMD ["bun", "run", "--filter", "@leadwolf/api", "start"]
