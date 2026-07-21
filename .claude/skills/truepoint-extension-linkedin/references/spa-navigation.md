# SPA navigation detection

LinkedIn is a single-page app: clicking from one profile to another **does not reload the page**, so the
content script's top-level code runs once and `document_idle` fires once. You must detect in-app navigation
yourself and re-run the adapter, or the panel/hover card goes stale on the second profile.

## The as-built approach (`src/content/observer.ts`)

A composed detector, debounced, comparing the path:

- **`popstate`** — catches back/forward.
- **A scoped `MutationObserver`** (`childList`) on the app container — catches client-rendered view swaps that
  don't fire `popstate`.
- **Path compare** — on any signal, compare `location.pathname` to the last handled path; only act on a real
  change (debounced) to avoid thrashing on every DOM mutation.

To also catch programmatic `history.pushState`/`replaceState` (which fire no event), patch them once to emit a
custom event the observer listens for — the standard SPA-detection completion of the above.

## Rules

- **Debounce.** LinkedIn mutates the DOM constantly; act on *path change*, not on every mutation. Scope the
  observer to the smallest stable container, not `document.body` unfiltered.
- **Idempotent re-entry.** Re-running the adapter for the same path must be a no-op; tear down the previous
  hover card before mounting a new one.
- **No XHR/fetch patching to detect data loads.** Detecting navigation is a DOM/History concern; patching
  network calls is the MAIN-world interception ADR-0043 §4 forbids (and `anti-fingerprint-and-tos.md` warns
  is detected). Path + DOM signals are sufficient.
- **Clean up on unload** to avoid leaked observers across the SPA's lifetime.
