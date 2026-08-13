// listCaps.ts — the safety ceiling for workspace-configuration list reads (audit 32 · C6).
//
// WHAT THIS IS NOT: a page size. These lists (tags, pipeline stages, saved searches, custom-field
// definitions, workspaces, CRM connections) are CONFIGURATION — a workspace has tens of them, not
// thousands, and the UI renders them whole because that is the right shape for a picker or a settings
// screen. Paginating them would be worse UX for no benefit.
//
// WHAT IT IS: a bound on the blast radius when an assumption turns out to be false. Every one of these reads
// previously returned the entire table for the workspace with no LIMIT at all, so the cost of a runaway —
// an import that mints a tag per row, a script looping on stage creation — was an unbounded result set
// serialized into a JSON response, on a request path.
//
// 1000 is chosen to be far above any legitimate use and far below "hurts". If a real workspace ever hits it,
// the truncation is the SIGNAL: that list has stopped being configuration and needs a real paginated surface,
// which is a product decision rather than a number to raise.
export const LIST_SAFETY_CAP = 1000;
