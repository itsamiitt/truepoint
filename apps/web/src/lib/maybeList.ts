// maybeList.ts — the {items, available} envelope for panels whose backend may not be wired yet (audit 32 · F4).
//
// WHY THIS IS NOT IN @leadwolf/types: it is not an API contract. No endpoint returns {items, available} — the
// server returns a list, or a 404/501 because that slice is dark or unbuilt. `available` is synthesized on the
// client from the response status. Putting this shape in the shared contract package would assert something
// about the wire format that is not true, and would invite a backend author to "implement" it.
//
// WHY IT IS SHARED: both halves were duplicated verbatim in features/sequences and features/settings-mailboxes,
// and the predicate is the load-bearing half. Which statuses mean "not wired yet" is a product decision — a
// panel that treats 501 as unavailable while another treats it as an error gives users two different stories
// about the same dark feature. One definition keeps that answer consistent as more panels adopt the pattern.

/** A list payload plus whether its backend exists yet (false → the panel shows a "connect …" empty state). */
export interface MaybeList<T> {
  items: T[];
  available: boolean;
}

/**
 * Does this status mean the endpoint isn't wired yet, rather than that the request failed?
 *
 * 404 — the route is not mounted (a dark feature-flagged slice).
 * 501 — mounted but deliberately unimplemented.
 *
 * Anything else is a real error and must keep propagating: a 403 means the caller lacks a role and a 500 means
 * the backend broke, and rendering either as a friendly "connect your mailbox" empty state would hide a fault.
 */
export function isUnavailable(status: number): boolean {
  return status === 404 || status === 501;
}
