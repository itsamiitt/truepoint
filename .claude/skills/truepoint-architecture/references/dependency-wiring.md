# Dependency Wiring

> **Contents:** Dependency Checklist (Audit Trail · Export · Permissions ·
> Notifications · Activity Feed · Search/Indexing · Optimistic UI · Webhooks) ·
> The Prospect-to-List Example · Stub Pattern · Dependency Map by Feature Type

Every feature exists inside a product — and every product has cross-cutting
concerns that apply to new features automatically: audit trails, exports,
notifications, permissions, search indexing, activity feeds, and more.

**An agent that builds a feature in isolation and stops is doing half the job.**

Before closing any feature implementation, map it against the dependency
checklist below and wire everything that applies. If a dependency is not yet
built, stub it — a typed no-op with a `// WIRE:` comment is better than
silence, because it makes the gap visible to the next agent or engineer.

---

## Dependency Checklist

Run through every item for every new feature or significant data mutation.

### Audit Trail

Does this feature create, modify, or delete a record that matters to ops,
compliance, or support? If yes, every mutation emits an audit event. The
call goes at the service layer — never in the UI component.

```ts
// api/mutate.ts — immediately after the mutation succeeds
await auditLog.record({
  action:     'list.prospect_added',
  entityType: 'list',
  entityId:   list.id,
  actorId:    session.userId,
  metadata:   { prospectId, source }
})
```

Audit is not optional on mutations that touch: user data, billing records,
list membership, contact ownership, permissions, or configuration.

---

### Export

Does this feature produce a collection of records a user might want to extract?
Wire a CSV export from day one. Export is never a "future enhancement" — it
is expected by every ops user and retrofitting it later means touching the
data layer twice. The export function lives at `features/[name]/api/export.ts`.

Minimum viable export: `exportAsCsv(filters): Promise<Blob>`. The UI
trigger is an `ExportButton` component that calls the hook and triggers a
browser download. Do not build a server-side download URL unless the dataset
is large enough to require streaming (>50k rows).

---

### Permissions

Does this feature introduce a new action that not all roles should perform?
Add the permission entry to `@leadwolf/permissions` (the role-logic source of truth)
before or alongside the
feature — never after. Shipping without a gate means every role has access
until the gate is retrofitted.

```ts
// packages/permissions/src/policies/lists.ts
export const listsPolicies = {
  'list.prospect.add':  ['admin', 'staff'],
  'list.export':        ['admin', 'staff'],
  'list.delete':        ['admin'],
}
```

Every action in the UI that mutates data must go through `canDo(role, action)`
before it fires. The check belongs in the hook, not in the component.

The UI check is UX; the security boundary is the server. The same permission must
be enforced server-side on the API route, paired with tenant scoping on the
query — a hidden button protects nothing if the endpoint still serves the data.
See the `truepoint-security` skill (`access-control.md`) for the enforcement
discipline.

---

### Notifications

Does completing this action need to inform another user or team? Wire the
notification at the service layer. Use an event or queue — never block the
UI response on notification delivery.

Common cases: a prospect is added to a list owned by someone else; a task is
assigned; an export is ready; an enrichment job completes.

---

### Activity Feed / History

Does the product have an activity timeline for the entity this feature
modifies? Wire the activity entry at the same time as the mutation. Same
pattern as audit — service layer, typed event, immediately post-mutation.

```ts
await activityFeed.push({
  verb:       'prospect_added',
  subjectId:  list.id,
  actorId:    session.userId,
  objectId:   prospectId,
  timestamp:  new Date()
})
```

---

### Search and Indexing

Does this feature create records users will search or filter later? If the
product has a search index (Elasticsearch, Typesense, Postgres full-text),
wire the index write at creation time and the de-index at deletion time.
Never rely on background re-indexing as the primary mechanism — records must
be searchable immediately after creation.

---

### Optimistic UI

Does this mutation have latency the user will notice (>300ms typical)? Wire
optimistic updates in the hook at build time — not as a follow-up. The pattern:

```ts
// hooks/useAddProspect.ts
const mutation = useMutation({
  mutationFn: addProspect,
  onMutate: async (variables) => {
    await queryClient.cancelQueries({ queryKey: listKeys.members(listId) })
    const previous = queryClient.getQueryData(listKeys.members(listId))
    queryClient.setQueryData(listKeys.members(listId), (old) =>
      optimisticallyAdd(old, variables)
    )
    return { previous }
  },
  onError: (_err, _vars, context) => {
    queryClient.setQueryData(listKeys.members(listId), context?.previous)
  },
  onSettled: () => {
    queryClient.invalidateQueries({ queryKey: listKeys.members(listId) })
  }
})
```

---

### Webhooks and Integrations

Does the product emit webhooks? A new create/update/delete event type must be
registered and documented at the same time the feature lands — not when a
customer asks for it. Retrofitting webhooks after the fact means auditing
every call site to find where the event should have been emitted.

---

## The Prospect-to-List Example

A common failure: an agent builds "add prospect to list" and delivers:

```
✅ UI: button + confirmation modal
✅ API call: POST /lists/:id/prospects
✅ Hook: useAddProspectToList
✅ Success toast
```

What it left unwired:

```
❌ Audit trail   — no record of who added which prospect, when
❌ Export        — list detail has no way to download members
❌ Activity feed — list history shows no additions
❌ Permissions   — any role can add prospects to any list
❌ Optimistic UI — table reloads on mutation instead of updating inline
❌ Notification  — list owner not informed when someone else adds a prospect
```

The correct feature folder for this work:

```
features/prospect-lists/
├── components/
│   ├── ProspectListPage.tsx
│   ├── AddProspectModal.tsx
│   └── ExportListButton.tsx          ← wired at build time
├── hooks/
│   ├── useProspectList.ts
│   ├── useAddProspect.ts             ← includes optimistic update
│   └── useExportList.ts              ← wired at build time
├── api/
│   ├── fetch.ts
│   ├── mutate.ts                     ← emits audit + activity post-mutation
│   └── export.ts                     ← wired at build time
└── types/
    └── prospectList.types.ts
```

And in `packages/permissions/src/policies/lists.ts`:

```ts
'list.prospect.add': ['admin', 'staff'],
'list.export':       ['admin', 'staff'],
```

---

## Stub Pattern for Unbuilt Dependencies

If a dependency (e.g. the audit service, notification queue) does not exist
yet, stub it with a typed no-op and mark it for wiring:

```ts
// WIRE: replace with real auditLog call once audit service is built (see ticket #412)
// biome-ignore lint/correctness/noUnusedFunctionParameters: stub awaiting wiring
async function recordAudit(_event: AuditEvent): Promise<void> {}
```

The stub keeps the call site in place. When the audit service is built, one
grep for `// WIRE:` surfaces every place to connect it.

---

## Dependency Map by Feature Type

Use this as a quick reference. Every cell marked ✓ is required — not optional.

| Feature type | Audit | Export | Permissions | Notifications | Activity | Optimistic UI |
|---|---|---|---|---|---|---|
| Creates a record | ✓ | — | ✓ | maybe | ✓ | ✓ |
| Modifies a record | ✓ | — | ✓ | maybe | ✓ | ✓ |
| Deletes a record | ✓ | — | ✓ | maybe | ✓ | ✓ |
| Produces a collection | — | ✓ | ✓ | — | — | — |
| Assigns ownership | ✓ | — | ✓ | ✓ | ✓ | ✓ |
| Bulk operation | ✓ | ✓ | ✓ | maybe | ✓ | — |
| Background job / async | — | maybe | ✓ | ✓ | ✓ | — |
