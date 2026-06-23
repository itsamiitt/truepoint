# Testing Strategy

CI enforces coverage thresholds (80% lines for `packages/`, 60% for `apps/`), but
coverage is a floor, not a goal. A suite that hits 80% by asserting implementation
details is worse than useless — it breaks on every refactor and catches no real
bugs. This file is about writing tests that earn their place, across the full range
of test types a system at this scale needs — not just unit tests.

---

## The Test Pyramid for TruePoint

Different bugs are caught by different test types. A product serving millions of
users and isolating many tenants cannot rely on unit tests alone:

- **Unit** — pure functions, permission logic, query-key factories, reducers,
  mutation-hook invalidation. Fast, numerous, the base of the pyramid.
- **Component** — what a user sees and can do on a surface (React Testing Library).
- **Contract** — that the frontend and backend agree on the API shape. **Critical
  here** because the API has many consumers (both web apps, the Chrome extension,
  external integrations) all sharing one source of truth — the `@leadwolf/types` Zod
  schemas imported by both `apps/api` and the clients — so a contract test
  catches a breaking API change before it breaks a consumer (see
  **truepoint-platform** api-contract).
- **Integration** — the backend against a real database and real RLS policies, so
  tenant scoping and queries are tested as they actually run, not mocked away.
- **Tenant-isolation** — the single highest-value test class in a multi-tenant CRM
  (its own section below). Mandatory.
- **End-to-end** — a few high-value full-stack journeys (log in → search → add a
  prospect → see it) on critical paths, not exhaustive.
- **Load / performance** — that critical paths hold at expected scale and degrade
  gracefully (its own section below).

The cheap, numerous tests live at the bottom; the expensive, few at the top. But the
top is not optional — skipping contract, integration, isolation, and load testing is
how a system passes unit tests and still fails in production.

---

## The Mandatory Tenant-Isolation Test

Because one tenant seeing another's data is the worst-case failure of a multi-tenant
CRM (see **truepoint-platform** tenancy and **truepoint-security** access-control),
isolation is tested explicitly and the test blocks merge:

- Seed two tenants (A and B). Authenticate as A. Assert that **every** read, list,
  update, and delete path cannot see or touch B's records — by direct ID, by
  enumeration, and by manipulating filters/params. For workspace-scoped tables,
  cover the `workspace_id` boundary as well as the `tenant_id` boundary.
- Assert that a write attempting to set another tenant's `tenant_id` (or
  `workspace_id`) is rejected (RLS `WITH CHECK`). The GUCs are `app.current_tenant_id`
  and `app.current_workspace_id`; the application connects as the non-BYPASSRLS role
  `leadwolf_app` (RLS ENABLE + FORCE, fail-closed via `NULLIF` on the GUC).
- Run it in CI on every change to a data path. A multi-tenant CRM without an
  automated cross-tenant isolation test is one refactor away from a breach.

This test is not optional and is not "nice to have" — it is the proof that the
isolation model actually holds.

> **Implementation status:** partially met — a DB-level proof exists
> (`packages/db/test/workspaceSwitch.itest.ts`, exercising the RLS GUCs as
> `leadwolf_app`), but there is **no per-endpoint cross-tenant isolation test** yet.
> The mandate stands: every data path still needs the per-endpoint isolation
> assertions above before it is considered proven.

---

## Load and Performance Testing

The pre-build pass asks "what breaks at 10x?" Load tests verify the answer for
critical paths (see **truepoint-platform** scaling-playbook):

- Critical read paths (search, list) sustain target throughput within their latency
  SLO (see **truepoint-platform** observability).
- Write/bulk paths degrade gracefully under load (queue depth grows and drains;
  nothing cascades into connection exhaustion) rather than falling over.
- Run against representative data volumes — testing search over a thousand rows
  proves nothing about its behaviour over hundreds of millions.

Load tests don't run on every commit, but they gate major changes to load-bearing
paths and run on a schedule against staging.

---

## What to Test (unit/component)

Test behaviour a caller or user depends on. For each unit: "what is the contract,
and what would a real bug look like?"

Always test: pure helpers in `@leadwolf/core` (cover empty/null/max/malformed);
permission logic (a permissions bug is a security bug — cover each role × action);
query-key factories (stable, correctly-nested keys); mutation hooks (they invalidate
the right keys); reducers and branching business rules.

Test the seams, not the internals: for a hook, what it returns and calls — not its
intermediate state; for a component, what the user sees and does — not which
sub-components rendered.

---

## What NOT to Test

- **Don't snapshot whole components** — snapshots break on any markup change, assert
  nothing about behaviour, and train people to `--update` without thinking.
- **Don't test the design system** — your usage of a `@leadwolf/ui` component (e.g. `TpButton`), not the component itself.
- **Don't test implementation details** — internal names, private state, render
  counts; they break on refactor while behaviour is fine.
- **Don't unit-test the shared schemas themselves** — the `@leadwolf/types` Zod
  schemas are exercised by the contract and integration tests (and by validation at
  the boundary), not by redundant unit tests asserting Zod works.
- **Don't write tests purely to hit the number** — a file that's hard to test
  meaningfully is usually doing too much; split it.

---

## Mocking

- Mock the **network boundary** (the typed API client) in component/unit tests, not
  react-query or your own hooks. Integration and contract tests do *not* mock the
  boundary — that's the point of them.
- For query/mutation hook tests, wrap in a `QueryClientProvider` with a fresh client
  per test so cache state never leaks.
- Prefer real implementations for pure functions — the real thing is the best double.
- If a test needs five mocks, the unit has too many dependencies — a design signal.

---

## Test Structure

Co-locate tests with the code under test. One describe block per unit; one assertion
focus per `it`. Name by behaviour, not method:

```ts
it('returns an error when the prospect id is unknown', ...)   // reads as a spec
it('invalidates the list query after a successful add', ...)
```

Arrange-Act-Assert; keep setup minimal and visible.

---

## Wire Tests With the Feature

Like dependency-wiring, observability, and runbooks, tests are wired at build time:
pure helpers → unit tests as written; the mutation hook → an invalidation test;
permission entries → a per-role test; the happy path → one Testing Library test; any
new data path → it's covered by the tenant-isolation suite. These are cheap,
high-value, and painful to retrofit.
