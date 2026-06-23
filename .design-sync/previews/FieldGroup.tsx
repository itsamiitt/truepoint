import { FieldGroup, TpInput, TpSelect } from "@leadwolf/ui";

function Panel({ children, width = 420 }: { children: import("react").ReactNode; width?: number }) {
  return (
    <div
      style={{
        width,
        padding: 24,
        border: "1px solid var(--tp-hairline)",
        borderRadius: "var(--radius)",
        background: "var(--tp-surface)",
        display: "flex",
        flexDirection: "column",
        gap: 18,
      }}
    >
      {children}
    </div>
  );
}

export function WithHint() {
  return (
    <Panel>
      <FieldGroup
        label="Company domain"
        htmlFor="fg-domain"
        hint="We use this to auto-enrich new contacts."
      >
        <TpInput id="fg-domain" defaultValue="acme.com" />
      </FieldGroup>
    </Panel>
  );
}

export function WithError() {
  return (
    <Panel>
      <FieldGroup
        label="Work email"
        htmlFor="fg-email"
        error="Enter a valid email address."
      >
        <TpInput id="fg-email" defaultValue="dana@acme" invalid />
      </FieldGroup>
    </Panel>
  );
}

export function Stacked() {
  return (
    <Panel>
      <FieldGroup label="First name" htmlFor="fg-first">
        <TpInput id="fg-first" defaultValue="Dana" />
      </FieldGroup>
      <FieldGroup label="Lead source" htmlFor="fg-source" hint="Where this contact came from.">
        <TpSelect id="fg-source" defaultValue="referral">
          <option value="referral">Referral</option>
          <option value="webinar">Webinar</option>
          <option value="cold">Cold outbound</option>
        </TpSelect>
      </FieldGroup>
    </Panel>
  );
}
