# UI Consolidation

Before scaffolding any new page, tab, route, or feature folder, ask one question:

**Can this live on a surface that already exists?**

The default answer is yes unless there is a concrete reason otherwise. AI agents
have a strong tendency to create a new tab or page for every logical variation of
a feature. This produces codebases with redundant layouts, duplicated hooks,
near-identical API files, and surfaces the user must navigate between when a
single unified surface with a switcher would have served them better.

---

## The Merge-First Test

Before creating anything new, run through this checklist:

1. **Same domain?** Does this feature operate on the same data type or entity as
   something that already exists? If yes, it belongs on the same page.

2. **Same layout?** Would the new surface share the same shell, filters, search
   bar, or action buttons as an existing one? If yes, those should not be
   duplicated.

3. **Variants, not pages?** Is the difference between the "two features" simply a
   parameter — a type, a category, a status filter? If the only difference is
   what data is fetched, use a single page with a `type` prop or query param, not
   two pages.

4. **Additive, not parallel?** Would a user move between these two surfaces during
   the same task? If yes, they should be co-located with a switcher — not separate
   routes requiring navigation.

---

## The Enrichment Example

A common failure: asked to build "people enrichment" and "company enrichment,"
an agent creates:

```
features/
├── people-enrichment/        ← separate folder
│   ├── PeopleEnrichment.tsx
│   ├── usePeopleEnrichment.ts
│   └── api/fetch.ts
└── company-enrichment/       ← separate folder
    ├── CompanyEnrichment.tsx
    ├── useCompanyEnrichment.ts
    └── api/fetch.ts
```

Two routes, two pages, duplicate layout, duplicate hooks, near-identical API calls.

The correct structure:

```
features/
└── enrichment/
    ├── index.ts
    ├── components/
    │   ├── EnrichmentPage.tsx       # single page, renders the switcher + active panel
    │   ├── EnrichmentSwitcher.tsx   # "People / Company" toggle
    │   ├── PeoplePanel.tsx          # people-specific content
    │   └── CompanyPanel.tsx         # company-specific content
    ├── hooks/
    │   ├── useEnrichment.ts         # shared: selected type, shared state
    │   ├── usePeopleEnrichment.ts   # people-specific data fetching
    │   └── useCompanyEnrichment.ts  # company-specific data fetching
    ├── api/
    │   ├── index.ts
    │   ├── fetch.ts                 # fetchEnrichment(type, id) — one function, type param
    │   └── types.ts
    └── types/
        └── enrichment.types.ts      # EnrichmentType = 'people' | 'company'
```

One route. One page component. One feature folder. The switcher is a component,
not a navigation element. The type is a local state value or query param, not a
separate URL. Shared logic (layout, error handling, loading states) lives once.

---

## When a Separate Page IS Correct

A new route is justified when:

- The two surfaces have genuinely different layouts with no shared structure
- A user would never switch between them within the same task (different
  workflows, different roles)
- The data domains are unrelated — not variants of the same entity
- One surface requires permissions the other does not, and showing a disabled tab
  would cause confusion rather than clarity

If none of these apply, consolidate.

---

## Switcher vs Tab vs Query Param

Once you have decided to consolidate, pick the switcher mechanism:

| Scenario | Mechanism |
|---|---|
| User switches type within the same workflow | Local state (`useState`) — no URL change |
| User might share or bookmark a specific view | Query param (`?type=company`) |
| Two distinct sections of equal weight on one page | Tab component from `@leadwolf/ui` |
| A primary view with a secondary sub-view | Nested layout with a sub-nav |

Never use a separate route just to preserve the URL for a view that is a variant
of an existing page. Query params handle this without a new route.
