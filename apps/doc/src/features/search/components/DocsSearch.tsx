"use client";

// DocsSearch.tsx — site search in the masthead.
//
// The WAI-ARIA 1.2 combobox-with-listbox pattern, and specifically the aria-activedescendant flavour of it:
// DOM focus never leaves the text input, and the "active" option is named by id instead. That is the right
// shape here for a reason that just cost this app a bug — the alternative, roving tabindex, moves real focus
// onto each option and therefore obliges you to implement the whole key set or the control becomes
// unreachable. apps/doc's playground shipped exactly that mistake one commit ago (radiogroup with
// tabIndex={-1} and no key handler; scripts/lint-roving-tabindex.mjs now gates it). With
// aria-activedescendant the options are never in the tab order to begin with, so there is no half-state to
// ship: the input keeps focus, keeps receiving every keystroke, and Escape always returns the reader to
// exactly where they were.
//
// Everything it searches is compiled in (content/searchIndex.ts) — no fetch, no service, no query leaving the
// browser. See that file for why.

// Type-only, so the corpus itself stays out of this chunk — see `load` below.
import type { searchDocs as SearchFn, SearchHit } from "@/content/searchIndex.ts";
import { useRouter } from "next/navigation";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import styles from "./docs-search.module.css";

const LIMIT = 8;

export function DocsSearch() {
  const router = useRouter();
  const listboxId = useId();
  const optionId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [search, setSearch] = useState<typeof SearchFn | null>(null);

  // The corpus is ~37 kB of prose — every guide, endpoint table and trust section, flattened. Statically
  // imported it lands in the chunk the root layout shares with EVERY page, so the landing page would pay for
  // a control most visitors never open. Loading it on first focus moves it to its own chunk, fetched at the
  // moment someone shows intent to search and cached for the rest of the session. Focus always precedes
  // typing (including via the "/" shortcut, which focuses), so in practice it has arrived before the first
  // keystroke; the panel says "Loading…" rather than "no matches" for the case where it has not.
  const load = useCallback(() => {
    if (search) return;
    void import("@/content/searchIndex.ts").then((module_) => setSearch(() => module_.searchDocs));
  }, [search]);

  const hits = useMemo(() => (open && search ? search(query, LIMIT) : []), [open, search, query]);
  // A stale index survives a shrinking result set: type "search", arrow to the 6th hit, then add a letter and
  // the list is 2 long. Clamping at render keeps the active row inside the list without an effect.
  const activeIndex = hits.length === 0 ? -1 : Math.min(active, hits.length - 1);
  const activeHit = activeIndex >= 0 ? hits[activeIndex] : undefined;

  const close = useCallback(() => {
    setOpen(false);
    setActive(0);
  }, []);

  const go = useCallback(
    (hit: SearchHit) => {
      close();
      setQuery("");
      inputRef.current?.blur();
      router.push(hit.href);
    },
    [close, router],
  );

  // "/" focuses search — the convention on every developer-docs site, and the reason it is worth having is
  // that it is the shortcut a reader tries WITHOUT being told. It must never steal a keystroke from someone
  // typing, so it stands down for any editable target: the playground on this same site has a domain field,
  // and a "/" that ate the slash in a URL would be a worse bug than having no shortcut at all.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
      }
      event.preventDefault();
      inputRef.current?.focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      // First Escape closes the list, a second clears the box. Closing and clearing at once loses the query
      // of anyone who hit Escape to dismiss an overlay they had already read.
      if (open && hits.length > 0) close();
      else setQuery("");
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (hits.length === 0) return;
      event.preventDefault(); // or the caret jumps to the ends of the input and the page scrolls
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => {
        const from = Math.min(current, hits.length - 1);
        return (from + delta + hits.length) % hits.length;
      });
      setOpen(true);
      return;
    }

    if (event.key === "Home" || event.key === "End") {
      if (hits.length === 0) return;
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : hits.length - 1);
      return;
    }

    if (event.key === "Enter" && activeHit) {
      event.preventDefault();
      go(activeHit);
    }
  }

  return (
    <div
      ref={containerRef}
      className={styles.search}
      // Closing on blur has to survive the click that caused it: mousedown blurs the input before the option's
      // click fires, so a naive onBlur close unmounts the row out from under the pointer. Checking whether
      // focus landed anywhere inside this component keeps the option alive long enough to be clicked.
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
      }}
    >
      <input
        ref={inputRef}
        // type="text", not type="search". Chromium gives a search input its own Escape handling that clears
        // the value, which pre-empted the two-stage Escape below — verified in a browser, where one press both
        // closed the list and emptied the box. The native clear button was already being hidden in CSS; that
        // was the same fight, one round earlier.
        type="text"
        role="combobox"
        className={styles.input}
        placeholder="Search docs"
        aria-label="Search documentation"
        aria-expanded={open && hits.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeHit ? `${optionId}-${activeIndex}` : undefined}
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
          load(); // belt and braces: a value can arrive without focus (autofill, paste into a restored field)
        }}
        onFocus={() => {
          setOpen(true);
          load();
        }}
        onKeyDown={onKeyDown}
      />

      {/* The "/" shortcut is worth having precisely because a reader tries it without being told — but only
          if they know it is there. Shown while the box is idle and hidden the moment it is focused or has a
          value, so it never sits behind typed text. Decorative and aria-hidden: the input already has an
          accessible name, and a screen-reader user reaching this control has not used the shortcut. */}
      {!open && query === "" ? (
        // A <kbd> has no tabindex and no interactive role, so it is not focusable — the rule below matches
        // conservatively on any element carrying aria-hidden. The attribute is the correct semantic here: a
        // decorative duplicate of a shortcut, and a reader who has already reached the input does not need
        // "slash" read out after its accessible name. (The directive has to be the LAST line before the
        // element — a wrapped comment between them makes it bind to nothing and report suppressions/unused.)
        // biome-ignore lint/a11y/noAriaHiddenOnFocusable: <kbd> is not focusable; see above.
        <kbd className={styles.shortcut} aria-hidden="true">
          /
        </kbd>
      ) : null}

      {/* The result count, for a reader who cannot see the list appear. Assertive would interrupt their own
          typing, so this is polite and deliberately terse. aria-live rather than role="status" — the role is
          only sugar for exactly this pair of attributes, and spelling it out keeps the element a plain span
          with no ARIA role to reconcile against its markup. */}
      <span className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {open && query.trim().length > 0 && search
          ? `${hits.length} result${hits.length === 1 ? "" : "s"}`
          : ""}
      </span>

      {open && query.trim().length > 0 ? (
        <div className={styles.panel}>
          {search === null ? (
            <p className={styles.empty}>Loading…</p>
          ) : hits.length === 0 ? (
            <p className={styles.empty}>
              No matches for “{query.trim()}”. Try an endpoint name, a field name, or an error code.
            </p>
          ) : (
            <div
              className={styles.list}
              // biome-ignore lint/a11y/useSemanticElements: an ARIA combobox popup, not a native <select>.
              role="listbox"
              id={listboxId}
              aria-label="Search results"
              tabIndex={-1}
            >
              {hits.map((hit, index) => (
                // Options in the aria-activedescendant flavour of this pattern are deliberately NOT focusable:
                // DOM focus stays on the input for the whole interaction and the active row is named by id.
                // tabIndex={-1} makes each row programmatically focusable without putting it in the tab order,
                // which is what "an interactive role must be focusable" actually asks for; Tab still leaves the
                // whole component in one press. It is NOT the roving-tabindex pattern — that one MOVES focus
                // and owes a much larger key contract, and it is the one that shipped broken here (file header).
                <div
                  key={hit.id}
                  id={`${optionId}-${index}`}
                  // biome-ignore lint/a11y/useSemanticElements: a native <option> is only valid inside a
                  // <select>/<datalist>, and this popup is neither.
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === activeIndex}
                  className={index === activeIndex ? styles.optionActive : styles.option}
                  // Pointer users get the same active row as keyboard users, so the two never disagree about
                  // what Enter would open.
                  onMouseMove={() => setActive(index)}
                  // mousedown, not click: click fires after blur, and blur closes the panel.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    go(hit);
                  }}
                >
                  <span className={styles.optionTitle}>{hit.title}</span>
                  <span className={styles.optionSection}>{hit.section}</span>
                  <span className={styles.optionSummary}>{hit.summary}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
