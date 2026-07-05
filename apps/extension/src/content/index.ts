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
  if (!adapter || adapter.pageType(url) !== "profile") {
    card.hide();
    return;
  }
  const record = adapter.extract(url, document);
  if (!record) {
    card.hide();
    return;
  }
  card.showForRecord(record);
  void send({ type: "LOOKUP", subjectKey: record.subjectKey, sourceUrl: record.sourceUrl })
    .then((res) => card.setStatus(res.status))
    .catch(() => undefined);
}

const observer = new NavigationObserver((url) => evaluate(url));
observer.start();
