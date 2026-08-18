// NavigationObserver — detects SPA route changes on a single-page host (LinkedIn) without touching the
// network (02 §5). Relies on `popstate` + a debounced, scoped MutationObserver + a location compare —
// NOT on patching fetch/XHR.
//
// Two signals (Layer-0-as-database plan, slice 5a):
//   • onChange(url)  — the navigation KEY changed. The key is pathname + search: on a Sales-Nav search page
//                      applying a filter or paging mutates ONLY the query string, and the previous
//                      pathname-only compare made every filter/page change invisible (one harvest per
//                      pathname visit, then silence).
//   • onSettle(url)  — the DOM mutated and went quiet WITHOUT a key change (lazy-rendered result rows,
//                      infinite scroll). Throttled so a busy page cannot fire it more than once per
//                      SETTLE_THROTTLE_MS. Consumers dedup by URL, so a re-fire is cheap.
// The scheduling logic lives in NavigationKeyTracker (pure, testable — no window/document access).
const DEBOUNCE_MS = 400;
const SETTLE_THROTTLE_MS = 1500;

export type NavigationSignal = "change" | "settle" | null;

/** Pure key/throttle state: given the current URL + timestamp on a settle tick, which signal fires? */
export class NavigationKeyTracker {
  private lastKey = "";
  private lastSettleAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly settleThrottleMs = SETTLE_THROTTLE_MS) {}

  static keyOf(url: URL): string {
    return url.pathname + url.search;
  }

  /** Called when the debounce elapses. Returns the signal to emit for `url` at time `now`. */
  tick(url: URL, now: number): NavigationSignal {
    const key = NavigationKeyTracker.keyOf(url);
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.lastSettleAt = now;
      return "change";
    }
    if (now - this.lastSettleAt >= this.settleThrottleMs) {
      this.lastSettleAt = now;
      return "settle";
    }
    return null;
  }
}

export class NavigationObserver {
  private readonly tracker = new NavigationKeyTracker();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private mo: MutationObserver | undefined;

  constructor(
    private readonly onChange: (url: URL) => void,
    private readonly onSettle?: (url: URL) => void,
  ) {}

  start(): void {
    window.addEventListener("popstate", () => this.schedule());
    this.mo = new MutationObserver(() => this.schedule());
    const target = document.querySelector("main") ?? document.body;
    this.mo.observe(target, { childList: true, subtree: true });
    this.schedule();
  }

  stop(): void {
    this.mo?.disconnect();
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      const url = new URL(location.href);
      const signal = this.tracker.tick(url, Date.now());
      if (signal === "change") this.onChange(url);
      else if (signal === "settle") this.onSettle?.(url);
    }, DEBOUNCE_MS);
  }
}
