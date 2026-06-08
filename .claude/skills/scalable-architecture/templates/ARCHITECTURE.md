# Architecture — {{PROJECT_NAME}}

> Scaffold note: replace `{{PROJECT_NAME}}` and `{{STACK}}`, prune the stack-specific section that does
> not apply, then delete this blockquote. This document is the contract for how code is organized.

**Stack:** {{STACK}}

## Principles

This codebase follows a **feature-based, layered architecture**. The rules:

1. Organize by **feature**, not by file type. No top-level `controllers/`, `models/`, `views/`.
2. Within a feature, separate layers: **presentation** (components/hooks), **business logic** (services),
   **data access** (repositories / `lib/` clients).
3. **Single Responsibility** — one job per file/module.
4. **Features never import from each other** — only through `shared/` or a feature's public `index`.
5. Each feature exposes a **public interface** via its `index` barrel; internals stay hidden.
6. **No business logic in UI** — it lives in services/hooks so it is testable and reusable.
7. **Type everything.** No `any`; add type hints.
8. **No hardcoded secrets** — env vars only; see `.env.example`.
9. **Small files** (~200–300 lines max) so the whole file fits in an AI assistant's context.
10. **Consistent, descriptive naming** across all features.

## Folder structure

```
src/
├── features/          # Feature modules
│   └── <feature>/
│       ├── components/   # UI
│       ├── services/     # Business logic / API calls
│       ├── hooks/        # Reusable stateful logic
│       ├── types/
│       ├── utils/
│       └── index.*       # Public exports only
├── shared/            # Reusable across features (components, hooks, utils, constants, types)
├── lib/               # External integrations (db, api clients)
├── config/            # Env validation + settings
├── store/             # Global state
└── app/               # Routing, entry, layout
tests/
```

## Import boundaries

- `features/<x>` → `shared/`, `lib/`, `config/`, `store/`, own files. **Never another feature.**
- `shared/`, `lib/` → must not import from `features/`.
- Outside code imports a feature only via `features/<x>/index` (no deep imports).

Enforced mechanically — see the lint config committed at scaffold time. Run the boundary check in CI.

## Layers & data flow

`component → hook → service → data access (repository / lib client)`. Validation happens at the service
boundary. Components never call the DB/API client directly.

## Naming & file size

See the project's conventions: feature folders `kebab-case`; components `PascalCase.tsx`; hooks
`useThing.ts`; services `thingService.ts`; tests `*.test.ts` co-located. Keep files under ~300 lines;
split by responsibility when they grow.

## Testing

Unit tests co-located in each feature (`__tests__/`); integration/e2e under top-level `tests/`.

## Adding a feature

Copy the feature template (`components/ services/ hooks/ types/ utils/ __tests__/ index`), wire the
`index` barrel to export only the public surface, and import only from `shared/`.
