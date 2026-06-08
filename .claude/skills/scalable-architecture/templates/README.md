# {{PROJECT_NAME}}

> Scaffold note: replace `{{PROJECT_NAME}}`, `{{ONE_LINE_DESCRIPTION}}`, `{{STACK}}`, and the run
> commands, then delete this blockquote.

{{ONE_LINE_DESCRIPTION}}

## Stack

{{STACK}}

## Getting started

```bash
# 1. Install dependencies
{{INSTALL_COMMAND}}        # e.g. npm install  /  bun install  /  uv sync

# 2. Configure environment
cp .env.example .env       # then fill in real values

# 3. Run in development
{{DEV_COMMAND}}            # e.g. npm run dev  /  bun run dev  /  uvicorn app.main:app --reload
```

## Architecture

This project uses a **feature-based, layered architecture** — organized by feature, with UI, business
logic, and data access kept in separate layers, and no imports between features. Full details and the
folder map are in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

```
src/
├── features/   # one folder per feature (components, services, hooks, types, utils, index)
├── shared/     # reusable across features
├── lib/        # external integrations (db, api clients)
├── config/     # env validation + settings
├── store/      # global state
└── app/        # routing, entry, layout
```

### Adding a feature

Create `src/features/<feature>/` from the feature template, expose its public surface through the
`index` barrel, and import only from `shared/`. See [`ARCHITECTURE.md`](./ARCHITECTURE.md#adding-a-feature).

## Scripts

| Command | What it does |
|---|---|
| `{{DEV_COMMAND}}` | Run the app in development |
| `{{TEST_COMMAND}}` | Run tests |
| `{{LINT_COMMAND}}` | Lint + check import boundaries |
