# Removal Cleanup

When a feature, option, field, or behaviour is removed, the removal is not
complete until every trace of it is gone. Leaving dead code is not a safe
default — it is a future bug, a misleading context for the next agent, and a
maintenance liability.

**A removal task is not done when the UI stops showing the thing.
It is done when the code that powered it no longer exists.**

---

## What Must Be Deleted on Every Removal

Work through this checklist top-to-bottom. Do not stop after the first category —
each one is independent and all of them apply.

**UI layer**
- The component file itself
- Sub-components used only by this component
- The route or page file if the surface is being removed entirely
- Menu items, nav links, breadcrumbs, and sidebar entries pointing to it
- Any feature flag, permission gate, or conditional that was gating it
- Empty state copy or illustrations written specifically for it

**State and hooks**
- The hook file(s) that managed its state
- Any context or provider created only for this feature
- Zustand / Jotai / Redux slices, atoms, or selectors only this feature used
- Query keys registered only for this feature's data fetching

**API and data**
- The API call files in `features/[name]/api/`
- Any request/response schema in `@leadwolf/types` (shared Zod schemas) added only
  for this feature, plus the types inferred from it
- Mock data or fixture files written for this feature
- Request/response types that are now unreferenced

**Types**
- Type definitions in `[feature].types.ts` that are now unused
- Enum variants added for this feature with no other consumers
- Zod schemas or validation rules written only for this feature's forms

**Backend / server**
- Route handlers in `app/api/` that only this feature called
- Server actions that only this feature used
- Database query helpers or service functions called only here

**Cross-cutting**
- Analytics event names or tracking calls for removed interactions
- Error messages written for this feature's specific failure states
- Constants and config values only this feature consumed
- Comments or `TODO`s referencing the removed feature
- Permission entries in `@leadwolf/permissions` (the role logic source of truth) that
  only this feature used

---

## How to Verify the Removal is Complete

After working through the checklist, run a name search:

```bash
grep -r "FeatureName\|featureName\|feature-name\|feature_name" \
  --include="*.ts" --include="*.tsx" .
```

Every result outside test files and git history is either something to delete
or something to update. The removal is not complete while results remain.

Then run the type checker:

```bash
bun run typecheck
```

TypeScript will catch dangling references the grep missed. Every type error
after a removal is a required fix — not a warning to defer.

---

## What NOT to Do

Do not comment out the code. Do not wrap it in `false &&`. Do not move it to
`_deprecated/`. Do not add `// TODO: remove this` and leave the code intact.
These are all the same mistake — the code remains in the codebase and will
confuse every agent and engineer who reads it after you.

**The only acceptable exception**: when a backend route must stay live until all
clients have deployed the removal. In this case, add a single comment:

```ts
// REMOVE AFTER: customer app v2.4.0 is fully deployed
```

Create a tracking ticket for the removal. Set a calendar reminder. Do not let
`REMOVE AFTER` comments age past their condition.

---

## Staged Removal Pattern

When UI and backend cannot be removed simultaneously, use this sequence:

1. Remove the UI first. Ship it.
2. Wait for all clients to be running the new version (check analytics or deploy logs).
3. Remove the backend. Ship it.
4. Delete the `REMOVE AFTER` comment.

Never reverse this order. Removing the backend before the UI causes runtime errors
for users still on the old client.
