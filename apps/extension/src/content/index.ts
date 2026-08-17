// Content-script entry (isolated world). Bootstraps the adapter registry + navigation observer +
// hover-card. On a supported profile it extracts the visible record and offers capture/reveal; it does
// a best-effort LOOKUP so an already-owned subject shows the right action. No network patching.
import { send } from "../shared/client.ts";
import { linkedinAdapter } from "./adapters/linkedin/index.ts";
import { AdapterRegistry } from "./adapters/registry.ts";
import { HoverCard } from "./hovercard/index.ts";
import { NavigationObserver } from "./observer.ts";

const registry = new AdapterRegistry();
registry.register(linkedinAdapter);

const card = new HoverCard();

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
    const links = adapter.harvestLinks?.(url, document) ?? [];
    if (links.length > 0) {
      void send({ type: "LINKS_CAPTURED", links, sourceUrl: url.href }).catch(() => undefined);
    }
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
    card.showForRecord(record);
    void send({ type: "LOOKUP", subjectKey: record.subjectKey, sourceUrl: record.sourceUrl })
      .then((res) => card.setStatus(res.status))
      .catch(() => undefined);
  } else {
    card.hide();
  }
}

const observer = new NavigationObserver((url) => evaluate(url));
observer.start();
