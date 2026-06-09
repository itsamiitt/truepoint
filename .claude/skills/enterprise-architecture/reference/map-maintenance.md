# map-maintenance — when & how to keep the navigation graph current

## When to regenerate
Regenerate at the **end of any task** that adds, removes, moves, or renames a source file under
`apps/**` or `packages/**` — i.e. whenever the *file set* changes. Pure content edits (no files
added/removed/moved) do **not** require regeneration; the feature→files index is unchanged, and the Stop
hook (which keys on `fileSetHash`) will stay silent.

The cycle:
```
1. run:   node .claude/hooks/gen-architecture-map.mjs     # rewrites docs/architecture-map.json
2. read:  docs/architecture-map.json                      # the new, authoritative paths
3. edit:  docs/ARCHITECTURE_MAP.md                         # refresh prose/tree/index/Mermaid per spec
4. check: did the generator report unassigned[] or warnings[]?  -> fix the code, not the map
```

A convenient alias once `package.json` exists: add `"arch:map": "node .claude/hooks/gen-architecture-map.mjs"`
so it's `npm run arch:map`.

## Bootstrap (no code yet → a `status:"planned"` map)
Today the repo has no `apps/`/`packages/`. To give future sessions a target:
1. Run the generator. With no source files it emits `status:"planned"`, empty `features`, and the
   empty-set `fileSetHash` — this keeps the Stop hook silent until real code lands.
2. Author `docs/ARCHITECTURE_MAP.md` from the planning docs (16/02/05/11) describing the **target** tree
   and the FEATURE→FILES targets, each clearly under the "⚠ Planned — targets, not locations" banner
   (navigation-map-spec §4).
3. Do **not** invent paths in the JSON — the JSON only ever reflects files that exist. Targets live in the
   prose until the code is written.

When the first real code is committed, the generator flips `status` to `"live"`, the `fileSetHash`
changes, the Stop hook fires once, and you replace the planned prose with the live index.

## Merge-conflict policy: **regeneration wins**
`docs/architecture-map.json` is deterministic and stable-sorted, so day-to-day diffs are minimal. But on a
feature branch the feature→files index will still change, so conflicts can happen. Resolve them
mechanically, never by hand:

1. Take *either* side (or `git checkout --theirs`/`--ours` — it doesn't matter).
2. Re-run `node .claude/hooks/gen-architecture-map.mjs` against the **post-merge working tree**.
3. The regenerated JSON is correct by construction. Re-author the prose from it. Commit.

Optionally register a git merge driver so this is automatic — add to `.gitattributes`:
```
docs/architecture-map.json merge=arch-map-regen
```
and define the driver (`git config merge.arch-map-regen.driver 'node .claude/hooks/gen-architecture-map.mjs && cp %A %A'`)
or simply rely on the manual step above.

**Alternative if a team still finds the committed JSON noisy:** gitignore `docs/architecture-map.json`,
regenerate it on demand (the `arch:map` script + a CI step), and commit only the human
`docs/ARCHITECTURE_MAP.md`. Trade-off: the Stop hook then can't compare against a committed hash on a fresh
checkout, so it regenerates first. Pick one policy and note it in the repo README; the default is
**commit both**.

## Authority
If the code and the map disagree, the **code is truth** — regenerate, never hand-patch the JSON to match a
belief about the code. The map serves navigation; it must never become a second, drifting source of truth.
