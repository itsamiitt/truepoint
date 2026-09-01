// Content-script entry (isolated world). Bootstraps the adapter registry + navigation observer +
// hover-card. On a supported profile it extracts the visible record and offers capture/reveal; it does
// a best-effort LOOKUP so an already-owned subject shows the right action. No network patching.
import { send } from "../shared/client.ts";
import { subjectFromUrl } from "../shared/linkedinUrl.ts";
import { type CapturedLink, subjectStatus } from "../shared/types.ts";
import { linkedinAdapter } from "./adapters/linkedin/index.ts";
import { AdapterRegistry } from "./adapters/registry.ts";
import { HoverCard } from "./hovercard/index.ts";
import { NavigationKeyTracker, NavigationObserver } from "./observer.ts";

const registry = new AdapterRegistry();
registry.register(linkedinAdapter);

const card = new HoverCard();

/** Per-page dedup for the Sales-Nav harvest: the (pathname+search) key + the URLs already sent for it.
 *  A settle re-harvest (lazy rows, scroll) sends ONLY new URLs; a key change starts a fresh set. The
 *  server-side registerUrl is idempotent, so a duplicate would be harmless — this just keeps the batches
 *  small and honest. */
const HARVEST_BATCH = 200;
let harvestKey = "";
let harvested = new Set<string>();

function harvest(url: URL): void {
  const adapter = registry.match(url);
  if (!adapter?.harvestLinks) return;
  const key = NavigationKeyTracker.keyOf(url);
  if (key !== harvestKey) {
    harvestKey = key;
    harvested = new Set();
  }
  const fresh: CapturedLink[] = [];
  for (const link of adapter.harvestLinks(url, document)) {
    if (harvested.has(link.url)) continue;
    harvested.add(link.url);
    fresh.push(link);
  }
  for (let i = 0; i < fresh.length; i += HARVEST_BATCH) {
    const links = fresh.slice(i, i + HARVEST_BATCH);
    void send({ type: "LINKS_CAPTURED", links, sourceUrl: url.href }).catch(() => undefined);
  }
}

function evaluate(url: URL): void {
  const adapter = registry.match(url);
  if (!adapter) {
    card.hide();
    return;
  }
  const kind = adapter.pageType(url);

  // Sales-Nav search/list: harvest the visible result URLs (URLs only) and register them. No card.
  if (kind === "sales_search") {
    card.hide();
    harvest(url);
    return;
  }

  if (kind !== "profile" && kind !== "company") {
    card.hide();
    return;
  }

  // Fetch-on-view: ensure the licensed document for the viewed entity is fresh, then read the intel back.
  const entityKind = kind === "company" ? "company" : "person";
  void send({ type: "VIEW_FETCH", entityKind, url: url.href }).catch(() => undefined);

  // Company pages get the in-page card WITHOUT any DOM extraction: the subject key comes from the URL
  // alone (same derivation the side panel uses) and the server resolves the rest. The content-script
  // company adapter (X07) stays deferred — `adapter.extract` is never called on this branch.
  if (kind === "company") {
    const subject = subjectFromUrl(url.href);
    if (subject?.kind === "company") card.showForCompany(subject);
    else card.hide();
    return;
  }

  const record = adapter.extract(url, document);
  if (record) {
    // The card re-extracts on Save (fresh DOM), so a header that rendered after this first pass — the
    // usual SPA case — is captured correctly instead of the nav-time snapshot.
    card.showForRecord(record, () => adapter.extract(new URL(location.href), document));
    void send({ type: "LOOKUP", subjectKey: record.subjectKey, sourceUrl: record.sourceUrl })
      .then((res) => card.setStatus(res.status))
      .catch(() => undefined);
  } else {
    card.hide();
  }
}

/** Settle (DOM quiet, same key): re-harvest a search page; re-extract a profile whose header may have
 *  rendered late (the card only updates its identity from the DOM if the lookup gave nothing better). */
function settle(url: URL): void {
  const adapter = registry.match(url);
  if (!adapter) return;
  const kind = adapter.pageType(url);
  if (kind === "sales_search") harvest(url);
  else if (kind === "profile") card.refreshFromDom(() => adapter.extract(url, document));
}

/**
 * Answer the service worker's EXTRACT_CURRENT with the visible header of the page this script is running on.
 *
 * The side panel has no DOM of its own, so its Save button cannot extract anything — it asks the SW, which
 * asks the content script that is already on the page. The capture itself is unchanged: the SAME adapter,
 * the SAME visible-DOM-only extraction the hover card's Save uses, on the page the user opened, triggered by
 * an explicit click (hard constraint 4). Nothing here reads more than it did before; a different button
 * reaches it.
 *
 * Re-extracts live rather than replaying the nav-time snapshot, because a LinkedIn header often renders
 * after the navigation settles — the same reason `card.showForRecord` takes a re-extract callback.
 */
chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  if (!raw || typeof raw !== "object") return false;
  const type = (raw as { type?: unknown }).type;

  if (type === "EXTRACT_CURRENT") {
    try {
      const url = new URL(location.href);
      const adapter = registry.match(url);
      sendResponse(adapter?.extract(url, document) ?? null);
    } catch {
      // Fail soft: a selector miss or a foreign page yields "nothing to capture", never a thrown error in a
      // page we do not own.
      sendResponse(null);
    }
    return false;
  }

  // The SW pushes SUBJECT_STATUS here because runtime broadcasts never reach a content script — without
  // this, a queued capture read "Queued — sending" forever (the drain's real outcome only ever reached the
  // panel). Validated like any boundary crossing; the card ignores a status for a subject it isn't showing.
  if (type === "SUBJECT_STATUS") {
    const push = raw as { subjectKey?: unknown; status?: unknown };
    const parsed = subjectStatus.safeParse(push.status);
    if (typeof push.subjectKey === "string" && parsed.success) {
      card.applyPushedStatus(push.subjectKey, parsed.data);
    }
    return false;
  }

  return false;
});

const observer = new NavigationObserver(evaluate, settle);
observer.start();
