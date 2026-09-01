// HoverCard — the in-page surface, rendered in a Shadow DOM so host-page CSS can't bleed in and our
// --tp-* tokens can't leak out (08 §3.1, 03 §1.7). Vanilla DOM (no framework) to keep the injected
// bundle tiny. Token-driven styles only; user data is set via textContent (never innerHTML — 03 §1.10).
//
// The card is the summary + money surface; the Side Panel stays the deep workspace. It renders the
// LOOKUP ladder first (thin, as before), then upgrades in place when the INTEL read lands — and falls
// back to the thin card when that read fails, so the deep read is an enhancement, never a dependency.
// State lives here; what to show is derived in viewModel.ts (pure, tested); painting is renderPerson /
// renderCompany. Stale async answers are dropped by a sequence guard: every show*() bumps `seq`, and a
// response tagged with an older seq never paints.
import { t } from "../../i18n/index.ts";
import { send } from "../../shared/client.ts";
import { ENV } from "../../shared/env.ts";
import type { ViewedSubject } from "../../shared/linkedinUrl.ts";
import type { IntelPayload } from "../../shared/messages.ts";
import type { CapturedRecord, RevealType, SubjectStatus } from "../../shared/types.ts";
import { type CardHandlers, type CardRegions, el } from "./dom.ts";
import { renderCompany } from "./renderCompany.ts";
import { renderPerson } from "./renderPerson.ts";
import { shadowTokens } from "./shadowTokens.ts";
import { baseCss } from "./styles.ts";
import {
  type IntelState,
  type RevealedNow,
  deriveCompanyVm,
  derivePersonVm,
  errorMessage,
} from "./viewModel.ts";

// Re-exported so the transform's own test (shadowTokens.test.ts) and any external caller keep one import
// site through the split.
export { scopeTokensToShadowHost } from "./shadowTokens.ts";

export class HoverCard {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly regions: CardRegions;
  private readonly closeButton: HTMLButtonElement;
  private readonly handlers: CardHandlers;

  private mode: "person" | "company" = "person";
  private record: CapturedRecord | null = null;
  private reExtract: (() => CapturedRecord | null) | null = null;
  private status: SubjectStatus | null = null;
  private subject: ViewedSubject | null = null;
  private intel: IntelPayload | null = null;
  private intelState: IntelState = "idle";
  private credits: number | null = null;
  private busy: RevealType | null = null;
  private justRevealed: RevealedNow | null = null;
  private copied: "email" | "phone" | null = null;
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;
  private revealError: string | null = null;
  /** Bumped by every show*(); async answers tagged with an older value are stale and never paint. */
  private seq = 0;

  constructor() {
    this.host = document.createElement("div");
    this.host.id = "truepoint-hovercard-host";
    this.host.style.display = "none";
    // Closed, deliberately: revealed values render inside a page we do not own, and a closed root at least
    // keeps them off `element.shadowRoot`. Isolation, not security — the page could still observe layout —
    // but there is no reason to hand LinkedIn's scripts a live reference to our tree.
    this.root = this.host.attachShadow({ mode: "closed" });

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
    const idrow = el("div", "idrow");
    const avatarEl = el("div", "avatar");
    const identity = el("div", "identity");
    const nameEl = el("div", "name");
    const subEl = el("div", "sub");
    const metaEl = el("div", "meta");
    identity.append(nameEl, subEl, metaEl);
    idrow.append(avatarEl, identity);
    this.closeButton = document.createElement("button");
    this.closeButton.type = "button";
    this.closeButton.className = "close";
    this.closeButton.textContent = "✕";
    this.closeButton.setAttribute("aria-label", t("card.dismiss"));
    this.closeButton.addEventListener("click", () => this.hide());
    header.append(idrow, this.closeButton);

    const row = el("div", "row");
    const brand = el("span");
    brand.textContent = t("app.name");
    const pillEl = el("span", "pill");
    // The pill is the status: it moves from "checking" to found/queued/not-found on its own, and without a
    // live region a screen-reader user is never told the answer arrived.
    pillEl.setAttribute("aria-live", "polite");
    row.append(brand, pillEl);

    const bodyEl = el("div", "body");
    bodyEl.setAttribute("aria-live", "polite");
    const footerEl = el("div", "footer");

    card.append(header, row, el("div", "divider"), bodyEl, footerEl);
    this.root.appendChild(card);
    document.documentElement.appendChild(this.host);

    this.regions = { avatarEl, nameEl, subEl, metaEl, pillEl, bodyEl, footerEl };
    this.handlers = {
      onAction: (id) => void this.onAction(id),
      onCopy: (channel, value) => this.copy(channel, value),
      onOpenPanel: () => void send({ type: "OPEN_PANEL" }).catch(() => undefined),
    };

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

  hide(): void {
    this.host.style.display = "none";
  }

  /** Show the card for a freshly detected profile. `reExtract` (optional) re-reads the DOM at Save time so
   *  the capture carries the rendered header, not the nav-time snapshot (slice 5e). */
  showForRecord(record: CapturedRecord, reExtract?: () => CapturedRecord | null): void {
    this.seq += 1;
    this.mode = "person";
    this.record = record;
    this.reExtract = reExtract ?? null;
    this.subject = null;
    this.resetSubjectState();
    this.paint();
    this.host.style.display = "block";
    this.refreshCredits();
  }

  /** Show the card for a company page. URL-derived subject only — no DOM is read (X07 stays deferred);
   *  INTEL is the company card's one read, so it starts immediately. */
  showForCompany(subject: ViewedSubject): void {
    this.seq += 1;
    this.mode = "company";
    this.subject = subject;
    this.record = null;
    this.reExtract = null;
    this.resetSubjectState();
    this.paint();
    this.host.style.display = "block";
    this.fetchIntel(subject.subjectKey, subject.sourceUrl);
    this.refreshCredits();
  }

  private resetSubjectState(): void {
    this.status = null;
    this.intel = null;
    this.intelState = "idle";
    this.busy = null;
    this.justRevealed = null;
    this.copied = null;
    this.revealError = null;
  }

  /** A later DOM settle: refresh the DOM-derived identity if the header rendered after the first pass. Never
   *  overrides a server-resolved identity (the lookup's or the intel read's — both outrank the DOM). */
  refreshFromDom(reExtract: () => CapturedRecord | null): void {
    if (this.mode !== "person" || !this.record) return;
    if (this.status?.identity || this.intel?.intel.person || this.intel?.intel.contact) return;
    const fresh = reExtract();
    if (!fresh || fresh.subjectKey !== this.record.subjectKey) return;
    if (fresh.fields.fullName && fresh.fields.fullName !== this.record.fields.fullName) {
      this.record = fresh;
      this.paint();
    }
  }

  setStatus(status: SubjectStatus): void {
    if (this.mode !== "person" || !this.record) return;
    this.status = status;
    // The deep read is worth a round trip only when the platform holds the person; every other outcome is
    // fully described by the status itself. Never `force` — the SW's warm cache makes a page view plus a
    // panel open cost one fetch.
    if (
      (status.outcome === "found" || status.outcome === "in_database") &&
      this.intelState === "idle"
    ) {
      this.fetchIntel(this.record.subjectKey, this.record.sourceUrl);
    }
    this.paint();
  }

  private fetchIntel(subjectKey: string, sourceUrl: string): void {
    const seq = this.seq;
    this.intelState = "loading";
    void send({ type: "INTEL", subjectKey, sourceUrl })
      .then((res) => {
        if (seq !== this.seq) return; // navigated away — stale
        if (res.ok) {
          this.intel = res.payload;
          this.intelState = "ready";
        } else {
          this.intelState = "error";
        }
        this.paint();
      })
      .catch(() => {
        if (seq !== this.seq) return;
        this.intelState = "error";
        this.paint();
      });
  }

  /** Credits ride GET_STATE (answered from the SW cache). Pulled, not subscribed: runtime broadcasts never
   *  reach content scripts, so the card re-asks after anything that spends. */
  private refreshCredits(): void {
    const seq = this.seq;
    void send({ type: "GET_STATE" })
      .then((state) => {
        if (seq !== this.seq) return;
        this.credits = state.auth.credits;
        this.paint();
      })
      .catch(() => undefined);
  }

  private paint(): void {
    if (this.mode === "company") {
      if (!this.subject) return;
      renderCompany(
        this.regions,
        deriveCompanyVm({
          subject: this.subject,
          intel: this.intel,
          intelState: this.intelState,
        }),
        this.handlers,
      );
      return;
    }
    if (!this.record) return;
    renderPerson(
      this.regions,
      derivePersonVm({
        record: this.record,
        status: this.status,
        intel: this.intel,
        intelState: this.intelState,
        credits: this.credits,
        busy: this.busy,
        justRevealed: this.justRevealed,
        copied: this.copied,
        revealError: this.revealError,
      }),
      this.handlers,
    );
  }

  private copy(channel: "email" | "phone", value: string): void {
    void navigator.clipboard?.writeText(value).then(() => {
      this.copied = channel;
      if (this.copiedTimer) clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => {
        this.copied = null;
        this.paint();
      }, 1400);
      this.paint();
    });
  }

  private async onAction(id: string): Promise<void> {
    switch (id) {
      case "openApp": {
        // The app has no per-contact detail route yet, so open the prospect workspace (a deep link is a
        // future apps/web route). A content-script click is a user gesture, so window.open is allowed.
        window.open(`${ENV.appOrigin}/search`, "_blank", "noopener,noreferrer");
        return;
      }
      case "retryLookup": {
        if (!this.record) return;
        const seq = this.seq;
        this.status = null;
        this.paint();
        const record = this.record;
        void send({ type: "LOOKUP", subjectKey: record.subjectKey, sourceUrl: record.sourceUrl })
          .then((res) => {
            if (seq === this.seq) this.setStatus(res.status);
          })
          .catch(() => undefined);
        return;
      }
      case "retryIntel": {
        if (this.mode === "company" && this.subject) {
          this.fetchIntel(this.subject.subjectKey, this.subject.sourceUrl);
        } else if (this.record) {
          this.fetchIntel(this.record.subjectKey, this.record.sourceUrl);
        }
        this.paint();
        return;
      }
      case "revealEmail":
      case "revealPhone":
        return this.reveal(id === "revealEmail" ? "email" : "phone");
      case "add":
        return this.addFromDatabase();
      case "save":
        return this.save();
      default:
        return;
    }
  }

  private async reveal(revealType: RevealType): Promise<void> {
    const contactId = this.intel?.intel.contactId ?? this.status?.contactId;
    if (!contactId || this.busy) return;
    const seq = this.seq;
    this.busy = revealType;
    this.revealError = null;
    this.paint();
    const res = await send({ type: "REVEAL", contactId, revealType }).catch(() => null);
    if (seq !== this.seq) return;
    this.busy = null;
    if (!res || !res.ok) {
      this.revealError = errorMessage(res?.errorClass);
      this.paint();
      return;
    }
    this.justRevealed = {
      ...this.justRevealed,
      ...(res.email !== undefined ? { email: res.email } : null),
      ...(res.phone !== undefined ? { phone: res.phone } : null),
      ...(res.nothingToReveal !== undefined ? { nothing: res.nothingToReveal } : null),
      ...(res.verification !== undefined ? { verification: res.verification } : null),
    };
    this.paint();
    this.refreshCredits(); // the reveal charged — re-pull the balance (no broadcast reaches this context)
  }

  /** Database hit: materialize the person the platform already holds — the workspace contact is built
   *  from the LICENSED document, not the DOM (Layer-0-as-database slice 4). A user gesture per row. */
  private async addFromDatabase(): Promise<void> {
    const sourceUrl = this.record?.sourceUrl;
    if (!sourceUrl || this.busy) return;
    const seq = this.seq;
    this.revealError = null;
    const res = await send({ type: "ADD_FROM_DATABASE", url: sourceUrl }).catch(() => null);
    if (seq !== this.seq || !res) return;
    // The person is now (or is becoming) a workspace contact — the cached intel describes the pre-add
    // world, so drop it and re-resolve from the new status.
    this.intel = null;
    this.intelState = "idle";
    this.setStatus(res.status);
  }

  /** Capture path — re-extract NOW (the header has certainly rendered by the time a user clicks Save) so
   *  the landed contact carries the real name/title, not the nav-time snapshot (slice 5e). */
  private async save(): Promise<void> {
    if (!this.record) return;
    const seq = this.seq;
    const fresh = this.reExtract?.() ?? null;
    const record =
      fresh && fresh.subjectKey === this.record.subjectKey && fresh.fields.fullName
        ? fresh
        : this.record;
    this.record = record;
    const res = await send({ type: "CAPTURE", record }).catch(() => null);
    if (seq !== this.seq || !res) return;
    this.setStatus(res.status);
  }
}
