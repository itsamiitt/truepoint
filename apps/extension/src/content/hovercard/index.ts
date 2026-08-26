// HoverCard — the in-page surface, rendered in a Shadow DOM so host-page CSS can't bleed in and our
// --tp-* tokens can't leak out (08 §3.1, 03 §1.7). Vanilla DOM (no framework) to keep the injected
// bundle tiny. Token-driven styles only; user data is set via textContent (never innerHTML — 03 §1.10).
import tokens from "@leadwolf/ui/tokens.css?inline";
import { t } from "../../i18n/index.ts";
import { send } from "../../shared/client.ts";
import { ENV } from "../../shared/env.ts";
import type { CapturedRecord, SubjectStatus } from "../../shared/types.ts";

/**
 * The DS tokens are declared on `:root` — and `:root` matches the document ELEMENT, which a ShadowRoot is
 * not (it is a DocumentFragment). So importing tokens.css into the shadow tree shipped the whole stylesheet
 * into every LinkedIn page for ZERO effect: every var() below silently fell through to its inline fallback,
 * the card rendered in the host page's font with a heavier, colder shadow than any other TruePoint popover,
 * and — worst — tokens.css's `:focus-visible { outline: 2px solid var(--focus-ring) }` DID match in here
 * (a plain selector, unlike :root) with `--focus-ring` undefined, making the declaration invalid at
 * computed-value time. An invalid `outline` unsets to `outline-style: none`, so the rule intended to
 * GUARANTEE a focus ring destroyed the UA's default one on the card's primary action.
 *
 * Re-scoping the selector to `:host` puts the same tokens on the shadow host, where the card can see them.
 */
export function scopeTokensToShadowHost(css: string): string {
  // `(?![\w-])`, not `\b`: a word boundary sits between "t" and "-", so `\b` would rewrite a selector like
  // `:root-panel` into `:host-panel`. Caught by its own test rather than by a mangled page.
  return css.replace(/:root(?![\w-])/g, ":host");
}

const shadowTokens = scopeTokensToShadowHost(tokens);

const baseCss = `
:host { all: initial; }
.card {
  position: fixed; top: 84px; inset-inline-end: 24px; width: 320px;
  /* An explicit stack, NOT var(--font-sans): that token resolves through --font-geist-sans, which next/font
     defines on the app's documents and never on a LinkedIn page — the substitution fails and font-family
     falls all the way back to the initial value (a serif, under all:initial). No @font-face reaches a
     content script either, so the system stack is the honest choice here. */
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--tp-ink, #111827);
  background: var(--tp-surface, #fff); border: 1px solid var(--tp-hairline-2, #e5e7eb);
  border-radius: var(--tp-radius-card, 14px);
  /* Fallback matches the DS token it stands in for — it used to be a single heavier, colder shadow, so on
     the one surface where the fallback actually fired the card did not look like a TruePoint popover. */
  box-shadow: var(--tp-shadow-popover, 0 4px 16px rgba(17,24,39,.08), 0 1px 3px rgba(17,24,39,.06));
  padding: var(--tp-space-4, 16px); z-index: 2147483647;
}
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.name { font-size: 15px; font-weight: 600; }
.close {
  border: 0; background: transparent; padding: 0; margin: -2px -2px 0 0; cursor: pointer;
  font: inherit; font-size: 13px; line-height: 1; color: var(--tp-ink-3, #6b7280);
}
.close:hover { color: var(--tp-ink, #111827); }
.sub { font-size: 12px; color: var(--tp-ink-3, #6b7280); margin-top: 2px; }
.row { display: flex; align-items: center; justify-content: space-between; margin-top: 12px;
  font-size: 13px; color: var(--tp-ink-2, #374151); }
.pill { font-size: 11px; border-radius: var(--tp-radius-sm, 6px); padding: 2px 8px;
  border: 1px solid var(--tp-hairline-2, #e5e7eb); color: var(--tp-ink-3, #6b7280); }
.divider { height: 1px; background: var(--tp-hairline, #f0f0f0); margin: 12px 0; }
.btn { width: 100%; border: 0; border-radius: var(--radius, 8px); padding: 8px 12px; cursor: pointer;
  font-size: 13px; font-weight: 600; color: var(--tp-on-fill, #fff); background: var(--tp-btn, #111827);
  font-family: inherit; }
.btn[disabled] { opacity: .6; cursor: default; }
.reveal { font-size: 13px; color: var(--tp-ink, #111827); margin-top: 8px; }
`;

export class HoverCard {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly nameEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly pillEl: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly revealEl: HTMLElement;
  private record: CapturedRecord | null = null;
  private reExtract: (() => CapturedRecord | null) | null = null;
  private status: SubjectStatus | null = null;

  constructor() {
    this.host = document.createElement("div");
    this.host.id = "truepoint-hovercard-host";
    this.host.style.display = "none";
    this.root = this.host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = shadowTokens + baseCss;
    this.root.appendChild(style);

    const card = el("div", "card");
    // The card appears over someone else's page with its own controls, so it needs to announce itself as a
    // region and carry a name — it had no role, no accessible name and no dismiss control at all.
    // Deliberately NOT a modal and deliberately NOT auto-focused: it appears on profile detection, not on a
    // user action, and stealing focus mid-browse would be hostile.
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", t("app.name"));
    card.tabIndex = -1;

    const header = el("div", "head");
    const identity = el("div");
    this.nameEl = el("div", "name");
    this.subEl = el("div", "sub");
    identity.append(this.nameEl, this.subEl);
    this.closeButton = document.createElement("button");
    this.closeButton.type = "button";
    this.closeButton.className = "close";
    this.closeButton.textContent = "✕";
    this.closeButton.setAttribute("aria-label", t("card.dismiss"));
    this.closeButton.addEventListener("click", () => this.hide());
    header.append(identity, this.closeButton);

    const row = el("div", "row");
    const brand = el("span");
    brand.textContent = t("app.name");
    this.pillEl = el("span", "pill");
    // The pill is the status: it moves from "checking" to found/queued/not-found on its own, and without a
    // live region a screen-reader user is never told the answer arrived.
    this.pillEl.setAttribute("aria-live", "polite");
    row.append(brand, this.pillEl);

    this.revealEl = el("div", "reveal");
    this.revealEl.setAttribute("aria-live", "polite");
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "btn";
    this.button.addEventListener("click", () => void this.onPrimary());

    card.append(header, row, el("div", "divider"), this.revealEl, this.button);
    this.root.appendChild(card);
    document.documentElement.appendChild(this.host);

    document.addEventListener("keydown", this.onKeyDown);
  }

  /** Bound so it can be REMOVED — the old inline listener stayed on `document` for the page's lifetime, and
   *  fired on every Escape whether the card was showing or not. */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.host.style.display !== "none") this.hide();
  };

  /** Tear down the injected host and its document listener (SPA teardown / extension disable). */
  destroy(): void {
    document.removeEventListener("keydown", this.onKeyDown);
    this.host.remove();
  }

  /** Show the card for a freshly detected profile. `reExtract` (optional) re-reads the DOM at Save time so
   *  the capture carries the rendered header, not the nav-time snapshot (slice 5e). */
  showForRecord(record: CapturedRecord, reExtract?: () => CapturedRecord | null): void {
    this.record = record;
    this.reExtract = reExtract ?? null;
    this.status = null;
    this.renderIdentityFromRecord(record);
    this.revealEl.textContent = "";
    // Honest initial state: the LOOKUP is in flight — say so instead of pre-rendering "Not revealed"
    // and swapping (the reader can't tell a pending answer from a miss).
    this.pillEl.textContent = t("card.checking");
    this.button.style.display = "none";
    this.host.style.display = "block";
  }

  /** A later DOM settle: refresh the DOM-derived identity if the header rendered after the first pass. Never
   *  overrides a server-resolved identity (setStatus wins). */
  refreshFromDom(reExtract: () => CapturedRecord | null): void {
    if (!this.record || this.status?.identity) return;
    const fresh = reExtract();
    if (!fresh || fresh.subjectKey !== this.record.subjectKey) return;
    if (fresh.fields.fullName && fresh.fields.fullName !== this.record.fields.fullName) {
      this.record = fresh;
      this.renderIdentityFromRecord(fresh);
    }
  }

  private renderIdentityFromRecord(record: CapturedRecord): void {
    this.nameEl.textContent = record.fields.fullName ?? record.subjectKey;
    const parts = [record.fields.jobTitle, record.fields.company].filter(Boolean);
    this.subEl.textContent = parts.join(" · ");
  }

  setStatus(status: SubjectStatus): void {
    this.status = status;
    // Prefer the RESOLVED masked identity (richer + server-authoritative) over the DOM capture when present.
    if (status.identity?.fullName) {
      this.nameEl.textContent = status.identity.fullName;
    }
    if (status.identity) {
      const parts = [
        status.identity.jobTitle,
        status.identity.company ?? status.identity.location,
      ].filter(Boolean);
      if (parts.length > 0) this.subEl.textContent = parts.join(" · ");
    }
    this.renderPrimary();
  }

  hide(): void {
    this.host.style.display = "none";
  }

  private renderPrimary(): void {
    this.button.disabled = false;
    if (this.status?.outcome === "suppressed") {
      this.pillEl.textContent = t("card.suppressed");
      this.button.style.display = "none";
      return;
    }
    this.button.style.display = "block";
    // Queued: durably buffered locally, not yet acknowledged by the server. Say so rather than falling through
    // to "Not revealed", which reads as though nothing happened. The pill is replaced when the drain reports
    // the real outcome via SUBJECT_STATUS.
    if (this.status?.outcome === "queued") {
      this.pillEl.textContent = t("card.queued");
      this.button.textContent = t("card.save");
      return;
    }
    // The lookup ladder (extension-intelligence-loop): found-in-workspace shows freshness; a vendor fetch
    // or a miss both offer Save (the fetched intel LINKs into the saved contact's master bridge).
    if (this.status?.outcome === "found" && this.status.contactId) {
      this.pillEl.textContent = freshnessLabel(this.status.lastUpdatedAt ?? null);
      this.button.textContent = this.status.owned ? t("card.openInApp") : t("card.reveal");
      return;
    }
    if (this.status?.outcome === "in_database") {
      this.pillEl.textContent = t("card.inDatabasePill");
      this.revealEl.textContent = t("card.inDatabaseHint");
      this.button.textContent = t("card.addToWorkspace");
      return;
    }
    if (this.status?.outcome === "not_found") {
      this.pillEl.textContent = t("card.notFoundPill");
      this.button.textContent = t("card.save");
      return;
    }
    if (this.status?.outcome === "unavailable") {
      this.pillEl.textContent = t("card.unavailablePill");
      this.revealEl.textContent = t("card.unavailableHint");
      this.button.textContent = t("card.save");
      return;
    }
    if (this.status?.contactId && !this.status.owned) {
      this.pillEl.textContent = t("card.notRevealed");
      this.button.textContent = t("card.reveal");
    } else if (this.status?.owned) {
      this.pillEl.textContent = t("card.revealed");
      this.button.textContent = t("card.openInApp");
    } else {
      this.pillEl.textContent = t("card.notRevealed");
      this.button.textContent = t("card.save");
    }
  }

  private async onPrimary(): Promise<void> {
    if (!this.record) {
      return;
    }
    const contactId = this.status?.contactId ?? null;

    // Owned → open the prospect in the full app. Previously this fell through to the capture path (the
    // chrome-extension/14 X06 miswire): the "Open in TruePoint" button re-captured instead of navigating.
    // The app has no per-contact detail route yet, so open the prospect workspace (a deep link is a future
    // apps/web route). A content-script click is a user gesture, so window.open is allowed.
    if (contactId && this.status?.owned) {
      window.open(`${ENV.appOrigin}/search`, "_blank", "noopener,noreferrer");
      return;
    }

    if (contactId && !this.status?.owned) {
      this.button.disabled = true;
      this.button.textContent = t("card.revealing");
      const res = await send({ type: "REVEAL", contactId, revealType: "email" });
      if (res.ok) {
        this.revealEl.textContent = res.email ?? res.phone ?? t("card.revealed");
        this.pillEl.textContent = t("card.revealed");
      } else {
        this.revealEl.textContent = errorMessage(res.errorClass);
      }
      this.renderPrimary();
      return;
    }

    // Database hit: materialize the person the platform already holds — the workspace contact is built
    // from the LICENSED document, not the DOM (Layer-0-as-database slice 4). A user gesture per row.
    if (this.status?.outcome === "in_database") {
      this.button.disabled = true;
      this.button.textContent = t("card.adding");
      const res = await send({ type: "ADD_FROM_DATABASE", url: this.record.sourceUrl });
      this.setStatus(res.status);
      this.button.disabled = false;
      this.renderPrimary();
      return;
    }

    // Capture path — re-extract NOW (the header has certainly rendered by the time a user clicks Save) so
    // the landed contact carries the real name/title, not the nav-time snapshot (slice 5e).
    this.button.disabled = true;
    const fresh = this.reExtract?.() ?? null;
    const record =
      fresh && fresh.subjectKey === this.record.subjectKey && fresh.fields.fullName
        ? fresh
        : this.record;
    this.record = record;
    const res = await send({ type: "CAPTURE", record });
    this.setStatus(res.status);
    this.button.disabled = false;
  }
}

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  return node;
}

/** "Found in TruePoint · updated N days ago" from the workspace copy's freshness stamp. */
function freshnessLabel(lastUpdatedAt: string | null): string {
  if (!lastUpdatedAt) return t("card.inTruePoint");
  const days = Math.floor((Date.now() - new Date(lastUpdatedAt).getTime()) / 86_400_000);
  if (Number.isNaN(days) || days < 0) return t("card.inTruePoint");
  if (days === 0) return t("card.updatedToday");
  return t("card.updatedDaysAgo").replace("{n}", String(days));
}

function errorMessage(errorClass?: string): string {
  switch (errorClass) {
    case "auth":
      return t("error.auth");
    case "rate_limit":
      return t("error.rate_limit");
    case "transient":
      return t("error.transient");
    default:
      return t("error.unexpected");
  }
}
