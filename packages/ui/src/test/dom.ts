// dom.ts — the DOM environment for this package's behavioural tests. Import it FIRST in every .domtest.tsx:
//
//   import "../test/dom.ts";
//   import { render } from "@testing-library/react";
//
// ── Why these files are named `.domtest.tsx` and not `.test.tsx` ─────────────────────────────────────────
// Registering happy-dom REPLACES a set of globals — including ReadableStream, Request and Response — and bun
// loads every test module in a run into ONE process before executing any of them. So a `.test.tsx` here does
// not just give ITSELF a DOM: it hands one to the whole monorepo. Measured, not theorised — with these files
// named `.test.tsx`, ten apps/api tests failed with `TypeError: readable should be ReadableStream` from
// `req.body.pipeThrough`, and passed again the moment they ran alone.
//
// bun only auto-discovers `.test.` / `_test_` / `.spec.` / `_spec_`, so the `.domtest.tsx` suffix keeps these
// out of the default `bun test` and they run explicitly via `bun run test:dom` — the same split the repo
// already uses for `*.itest.ts`. Adding a DOM test means naming it `.domtest.tsx`; naming it `.test.tsx`
// will look fine locally in isolation and break unrelated suites in CI.
//
// (A bunfig preload was the other option and is worse: bunfig.toml preloads test/setup.ts for the WHOLE
// monorepo, so the DOM would leak into every server-side test — code branching on
// `typeof window !== "undefined"` would silently take the browser path.)
//
// ESM evaluates imports in source order, so importing this before react-dom is enough to have the globals in
// place when React looks for them.
//
// These tests exist because the package had none. The contrast tests were rigorous and covered exactly one
// dimension — colour — while 42 components' worth of behaviour (focus traps, keyboard models, ARIA wiring)
// had no coverage at all, which is how a Dialog shipped with `aria-modal` and no focus trap while the skill
// docs promised the opposite. Anything asserted here is a contract an app is allowed to rely on.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof globalThis.document === "undefined") {
  GlobalRegistrator.register();
}

/** The element that currently has focus, as an HTMLElement (or null). */
export function active(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

/** Dispatch a keydown on `target` (default: document) the way a real key press would — bubbling and
 *  cancelable, so capture-phase document listeners and React's delegated handlers both see it. */
export function press(
  key: string,
  target: EventTarget = document,
  init: KeyboardEventInit = {},
): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
  );
}
