# CLAUDE.md — {{PROJECT_NAME}}

> Scaffold note: this file tells future AI sessions how to work in this repo. If a `CLAUDE.md` already
> exists, MERGE these rules in rather than overwriting. Delete this blockquote after scaffolding.

This project uses a **feature-based, layered architecture**. Follow these rules in every session.

## Non-negotiable rules

1. **Organize by feature**, never by file type. Put code in `src/features/<feature>/`, not in
   top-level `controllers/`, `models/`, or `views/`.
2. **Never import one feature from another.** Route shared needs through `src/shared/` or the other
   feature's public `index`. Import a feature only via `features/<x>/index` — never deep-import its
   internals.
3. **Keep business logic out of UI.** Components render; logic lives in `services/`, stateful glue in
   `hooks/`. No `fetch`/DB/SDK calls inside components.
4. **Type everything.** No `any`; add type hints. Define types in the feature's `types/`.
5. **No secrets in code.** Read config only through `src/config/`; document new vars in `.env.example`.
6. **Keep files under ~300 lines.** Split by responsibility when they grow.
7. **Each feature exposes a public `index` barrel** — export only the public surface; keep the rest
   internal.

## Where things go

- UI → `features/<x>/components/`
- Stateful UI logic → `features/<x>/hooks/`
- Business logic / external calls → `features/<x>/services/`
- Domain types → `features/<x>/types/`
- Cross-feature reusable code → `src/shared/`
- DB/API clients & SDK wrappers → `src/lib/`
- Env validation & settings → `src/config/`
- Routing/entry → `src/app/`

## Adding a feature

Create `src/features/<feature>/` with `components/ services/ hooks/ types/ utils/ __tests__/` and an
`index` barrel. Wire the barrel to export only the public surface. Import only from `shared/`, `lib/`,
`config/`.

## Before finishing a change

- No cross-feature imports introduced (the boundary lint rule must pass).
- New logic is in a service/hook, unit-tested, not in a component.
- New env vars added to `.env.example`.
- No file exceeds ~300 lines.

See `ARCHITECTURE.md` for the full rationale and folder map.
