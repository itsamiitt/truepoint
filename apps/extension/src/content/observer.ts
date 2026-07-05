// NavigationObserver — detects SPA route changes on a single-page host (LinkedIn) without touching the
// network (02 §5). Relies on `popstate` + a debounced, scoped MutationObserver + a location compare —
// NOT on patching fetch/XHR. Fires `onChange(url)` only when the path (subject) actually changes.
const DEBOUNCE_MS = 400;

export class NavigationObserver {
  private lastPath = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private mo: MutationObserver | undefined;

  constructor(private readonly onChange: (url: URL) => void) {}

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
      if (url.pathname !== this.lastPath) {
        this.lastPath = url.pathname;
        this.onChange(url);
      }
    }, DEBOUNCE_MS);
  }
}
