// HoverCard — the in-page surface, rendered in a Shadow DOM so host-page CSS can't bleed in and our
// --tp-* tokens can't leak out (08 §3.1, 03 §1.7). Vanilla DOM (no framework) to keep the injected
// bundle tiny. Token-driven styles only; user data is set via textContent (never innerHTML — 03 §1.10).
import tokens from "@leadwolf/ui/tokens.css?inline";
import { t } from "../../i18n/index.ts";
import { send } from "../../shared/client.ts";
import { ENV } from "../../shared/env.ts";
import type { CapturedRecord, SubjectStatus } from "../../shared/types.ts";

const baseCss = `
:host { all: initial; }
.card {
  position: fixed; top: 84px; inset-inline-end: 24px; width: 320px;
  font-family: var(--font-sans, system-ui); color: var(--tp-ink, #111827);
  background: var(--tp-surface, #fff); border: 1px solid var(--tp-hairline-2, #e5e7eb);
  border-radius: var(--tp-radius-card, 14px); box-shadow: var(--tp-shadow-popover, 0 8px 24px rgba(0,0,0,.12));
  padding: var(--tp-space-4, 16px); z-index: 2147483647;
}
.name { font-size: 15px; font-weight: 600; }
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
  private readonly revealEl: HTMLElement;
  private record: CapturedRecord | null = null;
  private status: SubjectStatus | null = null;

  constructor() {
    this.host = document.createElement("div");
    this.host.id = "truepoint-hovercard-host";
    this.host.style.display = "none";
    this.root = this.host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = tokens + baseCss;
    this.root.appendChild(style);

    const card = el("div", "card");
    const header = el("div");
    this.nameEl = el("div", "name");
    this.subEl = el("div", "sub");
    header.append(this.nameEl, this.subEl);

    const row = el("div", "row");
    const brand = el("span");
    brand.textContent = t("app.name");
    this.pillEl = el("span", "pill");
    row.append(brand, this.pillEl);

    this.revealEl = el("div", "reveal");
    this.button = document.createElement("button");
    this.button.className = "btn";
    this.button.addEventListener("click", () => void this.onPrimary());

    card.append(header, row, el("div", "divider"), this.revealEl, this.button);
    this.root.appendChild(card);
    document.documentElement.appendChild(this.host);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.hide();
      }
    });
  }

  showForRecord(record: CapturedRecord): void {
    this.record = record;
    this.status = null;
    this.nameEl.textContent = record.fields.fullName ?? record.subjectKey;
    const parts = [record.fields.jobTitle, record.fields.company].filter(Boolean);
    this.subEl.textContent = parts.join(" · ");
    this.revealEl.textContent = "";
    this.renderPrimary();
    this.host.style.display = "block";
  }

  setStatus(status: SubjectStatus): void {
    this.status = status;
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
      window.open(`${ENV.appOrigin}/prospect`, "_blank", "noopener,noreferrer");
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

    // Capture path.
    this.button.disabled = true;
    const res = await send({ type: "CAPTURE", record: this.record });
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
