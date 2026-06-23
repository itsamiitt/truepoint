# State, Data Fetching, and Error Handling

This is the data backbone of TruePoint. Every feature reads and writes state
the same way, so an agent never has to invent an approach. If the codebase
already has a setup that differs from what is described here, match the
codebase — but the patterns below are the intended target.

---

## Two Kinds of State

Keep these strictly separate. Conflating them is the most common cause of
sync bugs.

**Server state** — anything that lives in the database and is fetched over the
network: contacts, prospects, lists, deals, activity. This is owned by the
server. The client holds a *cache* of it, never the source of truth. Managed
with TanStack Query (react-query).

> This TanStack Query cache is the **client-side** cache, scoped to one user's
> browser. It is not the server-side cache (CDN/Redis) that protects the backend
> at scale — that lives in **truepoint-platform** (caching). Both exist and do
> different jobs; this file is only the client one.

**Client state** — UI-only state that never persists to the server: which tab
is open, whether a drawer is expanded, the current filter selection before it
is applied, form input before submit. Managed with `useState` / `useReducer`
locally, or a small store (Zustand) only when genuinely shared across distant
components.

Rule of thumb: if a value could be answered by a GET request, it is server
state and belongs in a query — not in `useState`.

---

## Data Fetching — TanStack Query

All server reads go through a query hook. All server writes go through a
mutation hook. Components never call the API client directly.

### Query Key Convention

Query keys are hierarchical arrays, defined once per feature in a `keys.ts`
file. Never inline a query key as a string or ad-hoc array — a typo in one
place silently breaks cache invalidation everywhere.

```ts
// features/prospects/api/keys.ts
export const prospectKeys = {
  all:     ['prospects'] as const,
  lists:   () => [...prospectKeys.all, 'list'] as const,
  list:    (filters: ProspectFilters) => [...prospectKeys.lists(), filters] as const,
  details: () => [...prospectKeys.all, 'detail'] as const,
  detail:  (id: string) => [...prospectKeys.details(), id] as const,
}
```

This structure lets you invalidate broadly (`prospectKeys.all` clears
everything) or narrowly (`prospectKeys.detail(id)` clears one record).

### Query Hook

```ts
// features/prospects/hooks/useProspects.ts
export function useProspects(filters: ProspectFilters) {
  return useQuery({
    queryKey: prospectKeys.list(filters),
    queryFn: () => fetchProspects(filters),
    staleTime: 30_000,   // 30s — server state is fresh enough for this window
  })
}
```

The hook returns react-query's shape: `{ data, isLoading, error, refetch }`.
This is exactly what `StateSwitch` in the design system consumes — see the
design skill.

### Mutation Hook

Mutations invalidate the queries they affect, so the UI re-reads fresh data.
Optimistic updates are wired here when latency is visible (see
`dependency-wiring.md`).

```ts
// features/prospects/hooks/useUpdateProspect.ts
export function useUpdateProspect() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: updateProspect,
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: prospectKeys.detail(variables.id) })
      qc.invalidateQueries({ queryKey: prospectKeys.lists() })
    },
  })
}
```

### Where the Client Is Configured

A single `QueryClient` is created once at the app root and provided via
`QueryClientProvider`. Default options live there — do not create a second
client, and do not override defaults per-query unless there is a specific reason.

```ts
// apps/<app>/lib/queryClient.ts
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,                    // one retry, then surface the error
      refetchOnWindowFocus: false, // CRM data doesn't need refetch-on-focus churn
    },
  },
})
```

---

## Cache Invalidation Rules

- A mutation invalidates every query whose data it could have changed — no more, no less.
- Invalidate by the narrowest key that covers the change. Adding a prospect to a
  list invalidates that list's members and the list's summary count, not all prospects.
- Never manually `setQueryData` to patch the cache unless implementing an
  optimistic update with a matching rollback. Prefer invalidation — it is
  simpler and correct by default.

---

## Error Handling Architecture

Pre-build asks "what happens when it fails." This is the answer for how
failures actually move through the codebase.

### Three Layers

1. **API client layer** — the typed client (payloads validated against the
   `@leadwolf/types` Zod schemas) throws typed errors. A response
   interceptor maps HTTP status to a typed error class (see below). A 401
   triggers token refresh once (see `auth.md`); a second 401 redirects to login.

2. **Hook layer** — query and mutation hooks surface the error object. They do
   not swallow it, log-and-continue, or convert it to `null`. The error reaches
   the component as `error` on the query/mutation result.

3. **Component layer** — the component decides what the user sees:
   - Data that failed to *load* → `StateSwitch` shows `ErrorState` with a retry.
   - An *action* that failed (mutation) → a destructive toast (`useToast`),
     plus the form stays filled so the user can retry without re-entering data.
   - Never a silent failure. Never a raw error string dumped into the UI.

### Typed Errors

Define error types so the UI can branch on them. A `403` is "you don't have
permission" (show a clear message, no retry); a `500` is "something broke"
(show retry); a network error is "you're offline" (show retry).

```ts
// the typed API client's errors module (alongside the client; types from @leadwolf/types)
export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message)
  }
  get isAuth()       { return this.status === 401 }
  get isForbidden()  { return this.status === 403 }
  get isNotFound()   { return this.status === 404 }
  get isServer()     { return this.status >= 500 }
  get isRetryable()  { return this.isServer || this.status === 0 }
}
```

### Error Boundaries

Each app wraps its view area in a React error boundary so a render crash in
one view shows a recoverable error panel instead of a white screen. The
boundary is a shell-level component — one per app, not one per feature.

A render crash is a bug, not a user error — the boundary's message should say
"something went wrong, try reloading," log the error to the monitoring service,
and never blame the user.

---

## What NOT to Do

- Do not store fetched server data in `useState` and mutate it locally — the
  cache and your copy will drift.
- Do not call `fetch` or the typed API client inside a component or a `useEffect` —
  use a query hook.
- Do not catch an error in a hook and return `null` or `[]` as if nothing
  happened — the UI then shows an empty state for what is actually a failure.
- Do not create per-component `QueryClient` instances.
- Do not invalidate `queryClient.invalidateQueries()` with no key (clears the
  entire cache) when a narrow key would do.
