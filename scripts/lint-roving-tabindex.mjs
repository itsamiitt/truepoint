#!/usr/bin/env node
// lint-roving-tabindex.mjs — roving tabindex without arrow keys is a keyboard trap.
//
// The WAI-ARIA composite-widget pattern (radiogroup, tablist, listbox, menu) takes the unselected options OUT
// of the tab order — `tabIndex={-1}` — precisely BECAUSE arrow keys are supposed to reach them. Ship half the
// pattern and the other options become unreachable by keyboard entirely: Tab skips them, and nothing else
// selects them. That is a WCAG 2.2 SC 2.1.1 failure.
//
// This exists because it happened. apps/doc's playground shipped a `role="radiogroup"` with roving tabindex
// and no key handler, so the API endpoint could not be switched without a mouse. Nothing caught it:
// verify.mjs asserts the a11y SKELETON (landmarks, one h1, heading order, named navs) and the accessibility
// tree looked perfect — two radios, correct aria-checked. Structure was right, operability was not, and
// structure is all a static HTML check can see. It took driving the page in a browser and pressing
// ArrowRight to notice nothing moved.
//
// So the rule is source-level, where the missing half IS visible: an element carrying BOTH `tabIndex={-1}` and
// a composite ARIA role must also handle keys. It cannot prove the handler is CORRECT — only a browser can —
// but it catches the case where there is none at all, which is the one that ships silently.
//
// Escape hatch, on the line above or within the file's header:
//   // roving-tabindex-ok: <why this needs no key handler>
//
// Run: `node scripts/lint-roving-tabindex.mjs` (wired as `bun run lint:roving-tabindex`). Exit 0 = clean.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage", ".turbo"]);

/** Roles whose ARIA pattern moves selection with arrow keys rather than Tab. */
const COMPOSITE_ROLE = /role=["'](radio|tab|option|menuitem|menuitemradio|menuitemcheckbox|treeitem)["']/;

/** The roving part: an explicitly negative tabIndex, in JSX or HTML spelling. */
const ROVING = /tabIndex=\{[^}]*-\s*1[^}]*\}|tabindex=["']-1["']/;

/** Any key handling at all. Deliberately loose — proving the handler is CORRECT is a browser's job. */
const KEY_HANDLER = /onKeyDown|onKeyUp|onKeyPress|addEventListener\(\s*["']key/;

const ALLOW = /roving-tabindex-ok:/;

function sourceFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".tsx") || entry.endsWith(".jsx")) out.push(full);
  }
  return out;
}

/**
 * Both signals must sit on the SAME element.
 *
 * The first version of this check tested the whole FILE for a composite role and for `tabIndex={-1}`, and its
 * first run produced a false positive: apps/web's FacetTypeahead puts `tabIndex={-1}` on the listbox CONTAINER
 * — a popover made programmatically focusable without adding a tab stop, which is correct — while its
 * `role="option"` buttons carry no tabIndex at all and stay Tab-reachable. That is the opposite of a trap, and
 * flagging it would have taught the next reader that the way past this gate is to annotate working code.
 *
 * "Same element" is decided without a parser by taking the attribute block around the role: back to the `<`
 * that opens the tag, forward to the next `<`, which is where children begin. Deliberately not a `<…>` match —
 * JSX attribute values contain `>` inside arrow functions (`onClick={() => …}`), so a naive tag regex ends the
 * tag in the middle of a handler and misses everything after it.
 */
function findTrap(text) {
  const roles = new RegExp(COMPOSITE_ROLE.source, "g");
  for (const match of text.matchAll(roles)) {
    const start = text.lastIndexOf("<", match.index);
    if (start === -1) continue;
    const childStart = text.indexOf("<", match.index);
    const block = text.slice(start, childStart === -1 ? undefined : childStart);
    if (ROVING.test(block)) return { role: match[1], index: start };
  }
  return null;
}

const offenders = [];
let scanned = 0;

for (const root of ROOTS) {
  for (const file of sourceFiles(root)) {
    scanned += 1;
    const text = readFileSync(file, "utf8");

    // A key handler ANYWHERE in the file clears it. Deliberately permissive: a group container that handles
    // arrow keys and moves selection for its children is as correct as per-option handlers, and this check
    // cannot tell delegation from absence.
    if (KEY_HANDLER.test(text) || ALLOW.test(text)) continue;

    const trap = findTrap(text);
    if (!trap) continue;

    const line = text.slice(0, trap.index).split("\n").length;
    offenders.push(
      `${file.replace(/\\/g, "/")}:${line}: role="${trap.role}" and tabIndex={-1} on the same element, no key handler`,
    );
  }
}

if (offenders.length === 0) {
  process.stdout.write(`ok   ${scanned} component files, no roving tabindex without key handling\n`);
  process.exit(0);
}

process.stdout.write(
  `${offenders.length} keyboard trap(s):\n\n${offenders.join("\n")}\n\n` +
    "A composite ARIA role with tabIndex={-1} removes those options from the tab order, so arrow keys are the\n" +
    "ONLY way to reach them. Without a key handler they are unreachable by keyboard — WCAG 2.2 SC 2.1.1.\n\n" +
    "Add the pattern's other half: Arrow keys move (with wrap-around), Home/End jump to the ends,\n" +
    "preventDefault so ArrowUp/Down do not scroll the page, and focus follows selection.\n" +
    "apps/doc/src/features/playground/components/PlaygroundPage.tsx is a worked example.\n\n" +
    "If the element genuinely needs no key handling, say why:  // roving-tabindex-ok: <reason>\n",
);
process.exit(1);
