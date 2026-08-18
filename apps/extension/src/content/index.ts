// Content-script entry (isolated world). Bootstraps the adapter registry + navigation observer +
// hover-card. On a supported profile it extracts the visible record and offers capture/reveal; it does
// a best-effort LOOKUP so an already-owned subject shows the right action. No network patching.
import { send } from "../shared/client.ts";
import type { CapturedLink } from "../shared/types.ts";
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

const observer = new NavigationObserver(evaluate, settle);
observer.start();
