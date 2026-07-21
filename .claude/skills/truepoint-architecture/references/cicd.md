# CI/CD — Pipelines and Deploy Strategy

Each app has its own pipeline. A change to `apps/web` (the customer app)
only triggers the customer pipeline. A change to `apps/admin` (the internal app)
only triggers the admin pipeline. Shared package changes propagate via Turborepo's
dependency graph.

> **Implementation status:** today there is a **single** `.github/workflows/ci.yml`, not
> per-app pipelines — the per-app, path-filtered design below is the target. There is no
> `customer-web.yml` / `admin.yml` yet; do not reference them.

---

## Pipeline Trigger Rules

Pipelines are path-filtered in GitHub Actions:

```yaml
# .github/workflows/customer-web.yml
on:
  push:
    branches: [main]
    paths:
      - 'apps/web/**'
      - 'packages/**'      # package changes rebuild dependents
  pull_request:
    paths:
      - 'apps/web/**'
      - 'packages/**'
```

The `packages/**` path means any shared package change triggers all app
pipelines. This is intentional — a package change is a potential breaking
change for every consumer.

---

## Standard Pipeline Steps

Every app pipeline runs these steps in order. Do not skip steps to speed up
a deploy — each step catches a different class of error.

```
lint → type-check → test → build → deploy
```

**lint** — `biome check` (Biome is the linter/formatter, not ESLint/Prettier);
module boundaries via `bun run lint:boundaries` (dependency-cruiser). Fails on any
error; warnings are allowed but reviewed in PR.

**type-check** — `bun run typecheck` (turbo, `tsc --noEmit` per package). No type
errors permitted on `main`.

**test** — `bun test` (unit + integration). Coverage threshold is enforced: 80%
line coverage minimum for `packages/`, 60% for `apps/`.

**build** — `turbo build` with remote caching enabled. Build artifacts are
cached by content hash — unchanged packages do not rebuild.

**deploy** — runs only on pushes to `main`. Preview deploys run on every PR.

---

## Environments

| Branch | Customer (`apps/web`) | Internal (`apps/admin`) |
|---|---|---|
| `main` | `app.truepoint.in` | internal surface (subdomain TBD) |
| `staging` | `staging.app.truepoint.in` | staging internal surface (subdomain TBD) |
| PR | `pr-[number].preview.truepoint.in` (per app) | same pattern |

> The customer domain `app.truepoint.in` (and `auth.truepoint.in`, `api.truepoint.in`)
> are real and configured. The internal app's subdomain is **not decided yet** — do
> not assume `staff.truepoint.in` / `admin.truepoint.in`; they are not configured.

Environment variables are injected at build time from the secrets manager.
Each environment has its own secret set — never share production secrets with
staging.

---

## Turborepo Configuration

`turbo.json` at the repo root defines the build graph. When adding a new
package or app, register it here.

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "dist/**"]
    },
    "lint": {
      "outputs": []
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "outputs": []
    }
  }
}
```

`^build` means: build all dependencies first. If `apps/web` depends on
`packages/ui`, Turborepo builds `packages/ui` before `apps/web`.

---

## Adding a New App

1. Create the app directory under `apps/`
2. Add a `package.json` with the app name (e.g. `"name": "@leadwolf/web"`)
3. The root `package.json` workspaces already glob `apps/*` — run `bun install` to link it
4. Create a pipeline file in `.github/workflows/[app-name].yml`
5. Configure path filters for the new app's directory
6. Add the app to the Turborepo pipeline if it has a build step

---

## Hotfix Process

Hotfixes go directly to `main` via a short-lived `hotfix/[ticket-id]-description`
branch. The same pipeline runs. There is no bypass for hotfixes — a pipeline
failure blocks the deploy.

---

## Secrets Management

Secrets are never in the repo. The pipeline pulls them at deploy time:

```yaml
- name: Pull secrets
  run: |
    # AWS Secrets Manager example
    aws secretsmanager get-secret-value \
      --secret-id truepoint/customer/production \
      --query SecretString \
      --output text | jq -r 'to_entries | .[] | "\(.key)=\(.value)"' >> $GITHUB_ENV
```

The CI role has read-only access to secrets. It cannot create or modify them.

---

## Commit Conventions

Commits are the unit of coordination between agents and the unit of review for
humans. Keep them small, atomic, and legible.

Format (Conventional Commits):

```
<type>(<scope>): <summary>

<optional body explaining why, not what>
```

- **type**: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `perf`, `style`
- **scope**: the feature or package touched — `prospects`, `auth`, `permissions`
- **summary**: imperative, lower-case, no trailing period — "add list export", not "Added list export."

```
feat(prospects): add CSV export to list detail
fix(auth): refresh token on 401 before redirecting
refactor(enrichment): split fetch and normalise into separate files
```

One logical change per commit. If the summary needs an "and", it is two commits.
A commit must build and type-check on its own — never commit a half-wired state
that breaks the build for whoever pulls next (see `multi-agent.md`).

---

## Pull Request Scope

A PR maps to one claimed unit of work — one feature, one fix, one shared-file
change. PRs that touch many unrelated areas are slow to review and likely to
conflict.

- Keep PRs focused: a reviewer should hold the whole change in their head.
- A PR that changes a shared file (`permissions`, `turbo.json`, a barrel) should
  be that change alone, landed first, so dependent feature PRs build on it.
- The PR description states what changed, why, and what is explicitly out of
  scope — the same framing as the pre-build plan.
- Every PR passes the full pipeline (lint, type-check, test, build) before merge.
  There is no bypass.

If a feature is large, split it into sequential PRs that each build and ship on
their own, rather than one enormous PR — smaller PRs merge faster and conflict less.
