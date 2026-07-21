# syntax=docker/dockerfile:1.7
# TruePoint — ONE image for all five services (web, auth, admin, api, workers).
#   • api / workers run TypeScript directly under Bun (no build step).
#   • web / auth / admin are Next.js apps (next build → next start; not standalone).
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
# Load the env so NEXT_PUBLIC_* inline correctly and @leadwolf/config's fail-fast boot
# validation passes during `next build`. This goes through scripts/export-dotenv.sh rather than
# `set -a; . "$file"`: the latter makes the SHELL parse the file, so an unquoted value containing
# a metacharacter silently changes the line's meaning. A Neon DATABASE_URL ends in
# `?sslmode=require&channel_binding=require`, and that `&` backgrounds the assignment — the
# variable never reaches the parent shell and the build fails with "DATABASE_URL: Required"
# while the value is plainly present in the file. compose's env_file reader does not
# shell-interpret values, so that same file works at runtime; export-dotenv.sh matches it.
# NODE_ENV is forced back to production AFTER loading: a stray NODE_ENV=development in the
# dotenv (e.g. a dev .env copied as .env.production) makes `next build` mix dev+prod React
# runtimes → prerender crashes with "null is not an object (evaluating 'useState')".
# The path goes in via DOTENV_FILE, never as a `.` argument: this /bin/sh is dash, which ignores
# arguments to the dot command (the sourced script would see an empty $1 and export nothing).
# The canary check right after makes any such silent failure loud immediately: if the secret was
# mounted, DATABASE_URL must have come out of it — otherwise abort before minutes of Next builds
# fail on a misleading "Required" error.
RUN --mount=type=secret,id=dotenv \
    sh -c 'DOTENV_FILE=/run/secrets/dotenv; . ./scripts/export-dotenv.sh; \
           if [ -f /run/secrets/dotenv ] && [ -z "$DATABASE_URL" ]; then \
             echo "ERROR: dotenv secret is mounted but DATABASE_URL did not load — env parsing is broken" >&2; exit 1; \
           fi; \
           export NODE_ENV=production; \
           bun run --filter "@leadwolf/web" build && \
           bun run --filter "@leadwolf/auth-app" build && \
           bun run --filter "@leadwolf/admin" build && \
           bun run --filter "@leadwolf/forge" build'

ENV NODE_ENV=production
# web 3002 · auth 3000 · api 3001 · admin 3003 · forge console 3004 · forge-api 3005
# (forge-worker runs TS directly under Bun, no port).
EXPOSE 3000 3001 3002 3003 3004 3005

# Default command; overridden per-service in docker-compose.prod.yml.
CMD ["bun", "run", "--filter", "@leadwolf/api", "start"]
