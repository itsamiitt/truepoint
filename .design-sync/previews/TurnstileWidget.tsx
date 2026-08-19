// TurnstileWidget — the Cloudflare Turnstile challenge at the identifier step (ADR-0020).
//
// HONEST EMPTY CARD, on purpose. The widget returns null when NEXT_PUBLIC_TURNSTILE_SITE_KEY is unset —
// that is the component's real behaviour and the reason local sign-in works without a Turnstile key. A
// preview has no site key and must not reach a third-party challenge host, so the rendered output is
// nothing. The cell therefore shows the slot the widget occupies on the form, labelled, rather than
// pretending to render a challenge it cannot legitimately produce.
import { TurnstileWidget } from "@leadwolf/ui";

/** The widget in its unconfigured state — renders nothing, and the form below it still works. */
export const Unconfigured = () => (
  <form
    style={{
      display: "grid",
      gap: 12,
      maxWidth: 360,
      padding: 20,
      background: "var(--tp-surface, #fff)",
      border: "1px solid var(--tp-hairline-2, #eceef1)",
      borderRadius: 10,
    }}
  >
    <div
      style={{
        border: "1px dashed var(--tp-hairline, #e5e7eb)",
        borderRadius: 8,
        padding: "14px 12px",
        fontSize: 12,
        color: "var(--tp-ink-3, #6b7280)",
        textAlign: "center",
      }}
    >
      Turnstile slot — the widget renders here when a site key is configured
      <TurnstileWidget />
    </div>
  </form>
);
