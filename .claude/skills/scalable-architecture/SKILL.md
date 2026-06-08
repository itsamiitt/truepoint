---
name: scalable-architecture
description: >-
  Scaffold a new project, add a new feature, or review/audit project structure against a clean,
  modular, feature-based architecture. Use to set up clean, scalable architecture.
---

# scalable-architecture

**Prime directive: every codebase you touch must stay feature-based, layered, typed, and small enough
for an AI assistant to hold in full context.** Organize by *feature*, never by file type. Keep business
logic out of UI. Features never import from each other — only through `shared/` or a published public
interface. This skill makes codebases easy to manage, easy to "vibe code," low-error, scalable, and
easy to extend.

This skill has **three modes** — *scaffold a new project*, *add a new feature*, *review/audit an existing
project*. Detect the mode from the request (§ "Mode detection"), then follow that mode's numbered steps
exactly. Numbered steps are mandatory sequences, not suggestions.

## When this skill applies

Trigger on requests like:
- "scaffold a new project", "set up a clean architecture", "start a new app the right way" → **Scaffold**.
- "add a new feature", "create a `billing` module", "scaffold the `auth` feature" → **Add a feature**.
- "review my project structure", "audit this codebase", "is my architecture clean?" → **Review/audit**.

If the request is about something other than project/code structure (e.g. a one-off bug fix unrelated to
layout), this skill does not apply.

## The 10 core principles (enforce in every mode)

1. Organize by **FEATURE, not by file type** — no top-level `controllers/`, `models/`, `views/` folders.
2. Within each feature, **separate the layers**: presentation/UI, business logic (services), data access.
3. **Single Responsibility** — each file/module does one thing.
4. Features **NEVER import directly from each other** — they communicate only through a `shared/` layer
   or a defined public interface.
5. Each feature exposes a **public interface via an `index` barrel file**; internals stay hidden.
6. Keep **business logic OUT of UI components** — put it in services/hooks so it is testable and reusable.
7. **Type everything** (TypeScript / Python type hints) to catch errors before runtime.
8. **Never hardcode secrets** — use environment variables and provide a `.env.example`.
9. Keep **files small** (under ~200–300 lines) so an AI assistant can hold full context.
10. Use **consistent, descriptive naming** conventions across all features.

## Load supporting files only when needed (progressive disclosure)

- **`REFERENCE.md`** — load it when you need detailed naming rules, the import-boundary *enforcement*
  config, the public-interface/barrel strategy, separation-of-concerns rules, testing layout, or
  per-stack / monorepo folder variations. Keep this `SKILL.md` as the lean spine; the depth lives there.
- **`templates/`** — use these files when scaffolding. `templates/feature/` is the canonical feature
  folder you copy in "add a feature" mode. `templates/ARCHITECTURE.md`, `templates/CLAUDE.md`,
  `templates/README.md`, `templates/.env.example`, and `templates/import-boundaries.md` are the
  scaffold outputs. Treat `Example`/`example` tokens in `templates/feature/` as placeholders to replace.

## Target folder structure (the canonical single-app layout)

```
src/
├── features/          # Feature modules (auth/, dashboard/, payments/, ...)
│   └── <feature>/
│       ├── components/   # UI
│       ├── services/     # Business logic / API calls
│       ├── hooks/        # Reusable stateful logic
│       ├── types/
│       ├── utils/
│       └── index.*       # Public exports only
├── shared/            # Reusable across features (components, hooks, utils, constants, types)
├── lib/               # External integrations (db, api clients)
├── config/            # Env + settings
├── store/             # Global state
└── app/               # Routing, entry, layout
tests/
.env.example
README.md
```

Adapt per stack (see `REFERENCE.md` for Next.js App Router, Node/Hono/Express, the Turborepo monorepo
variant, and a Python note). The single-app `src/features/` layout above is the default.

## Mode detection

1. Read the request. If it asks to start/bootstrap a project → **Mode 1 (Scaffold)**.
2. If it names or implies one new feature to add to an existing project → **Mode 2 (Add a feature)**.
3. If it asks to check/review/audit existing structure → **Mode 3 (Review/audit)**.
4. If genuinely ambiguous, ask one clarifying question before proceeding. Never guess between scaffolding
   and reviewing — they have opposite write behavior.

---

## Mode 1 — Scaffold a new project

1. **Ask the stack** (do not assume). Offer concrete options: React/Next.js, Node/Express or Hono,
   Python/FastAPI or Django, or other. Capture language (TypeScript by default) and framework.
2. **Confirm the topology.** Default to the single-app `src/features/` layout above. Offer the
   **Turborepo monorepo variant** (`apps/*` + `packages/*`) if the project will have multiple deployables
   or shared libraries (see `REFERENCE.md` → "Monorepo variant").
3. **Generate the folder tree** for the chosen stack/topology, creating the layer folders empty (with a
   `.gitkeep` where a folder would otherwise be empty) plus one starter feature folder copied from
   `templates/feature/`.
4. **Generate config files** for the stack: `tsconfig.json` (strict) / `pyproject.toml`, lint/format
   config, and the import-boundary rule from `templates/import-boundaries.md` (enforces principle #4).
5. **Generate `.env.example`** from `templates/.env.example` — documented variable names with placeholder
   values, never real secrets.
6. **Generate `README.md`** from `templates/README.md` — what the project is, how to run it, and a short
   description of the architecture and where things go.
7. **Generate `ARCHITECTURE.md`** from `templates/ARCHITECTURE.md` — the conventions (the 10 principles,
   folder structure, naming, import rules) recorded for the team.
8. **Generate or update `CLAUDE.md`** from `templates/CLAUDE.md` so future AI sessions follow these
   conventions automatically. If a `CLAUDE.md` already exists, merge — do not clobber existing content.
9. **Print the final folder tree** and a one-line note on how to add the next feature (Mode 2).

## Mode 2 — Add a new feature

1. **Get the feature name** (e.g. `billing`). Derive the folder name (kebab/lower) and the symbol name
   (PascalCase, e.g. `Billing`) for replacing placeholders.
2. **Locate `features/`** (or `packages/` in a monorepo). If it does not exist, tell the user the project
   is not scaffolded and offer Mode 1.
3. **Copy `templates/feature/`** into `features/<feature>/`, keeping the layer folders: `components/`,
   `services/`, `hooks/`, `types/`, `utils/`, `__tests__/`, and `index` barrel.
4. **Rename placeholders**: replace `Example`→`<Feature>` and `example`→`<feature>` in file names and
   contents so the feature is named correctly and consistently.
5. **Wire the `index` barrel** to export ONLY the feature's public surface (principle #5). Keep
   everything else internal.
6. **Imports rule**: the new feature may import from `shared/`, `lib/`, `config/`, and its own files —
   **never from another feature**. If it needs another feature's capability, route it through `shared/`
   or that feature's published `index`.
7. **Report** what was created: the file tree of the new feature and the public exports its `index`
   exposes.

## Mode 3 — Review / audit an existing project

1. **Map the project** first: locate `src/`, `features/`/`packages/`, `shared/`, config, and tests.
2. **Scan for violations** of the 10 principles. Check for each:
   - **Cross-feature imports** — a file in `features/A` importing from `features/B` (violates #4).
   - **By-type top-level folders** — `controllers/`, `models/`, `views/`, `services/` at the root
     instead of inside features (violates #1).
   - **Business logic in UI** — fetch/DB/computation logic inside components instead of services/hooks
     (violates #6).
   - **Oversized files** — files over ~300 lines (violates #9). Report path + line count.
   - **Missing/weak types** — `any`, untyped exports, missing Python type hints (violates #7).
   - **Hardcoded secrets** — API keys/tokens/passwords in code instead of env; missing `.env.example`
     (violates #8).
   - **Missing public interface** — a feature folder with no `index` barrel (violates #5).
   - **Inconsistent naming** — mixed conventions across features (violates #10).
3. **Emit a structured report**: group findings by principle; for each, give `path:line — issue` and a
   one-line suggested fix. End with a short prioritized summary (highest-impact violations first).
4. **BOUNDARY — report only.** In review mode you must **NOT modify any code**. Only after the user
   explicitly asks ("fix these", "apply the fixes") may you switch to making edits.

---

## Examples (input → expected output)

- **"Scaffold a new Next.js app with clean architecture"** → Mode 1. Ask "Next.js App Router + TypeScript?",
  then generate `src/{features,shared,lib,config,store,app}`, a starter feature, `tsconfig.json`,
  `.env.example`, `README.md`, `ARCHITECTURE.md`, `CLAUDE.md`, and print the tree.
- **"Add a `billing` feature"** → Mode 2. Create `src/features/billing/{components,services,hooks,types,
  utils,__tests__,index.ts}` from the template with placeholders renamed, `index.ts` exporting only the
  public surface, importing only from `shared/`. Report the new tree + public exports.
- **"Review my project structure"** → Mode 3. Produce a violations report (e.g. "`features/cart/
  CartList.tsx:42` imports from `features/checkout` — cross-feature import, route via `shared/`";
  "`api/userController.ts:210` — file is 410 lines, split by responsibility") and make no edits.

## Guardrails (non-negotiable)

- **Ask the stack before scaffolding.** Never invent or assume a framework.
- **Review mode is read-only.** Report violations; edit only on explicit instruction.
- **Never write real secrets.** Only `.env.example` with placeholders.
- **Keep files small and single-purpose.** If a file you generate would exceed ~300 lines, split it.
- **No cross-feature imports, ever.** Route shared needs through `shared/` or a published `index`.
- **Type everything you generate.** No `any`; add Python type hints.
- **Match the existing project's conventions** when adding to or reviewing a codebase — consistency
  (principle #10) outranks personal preference.
