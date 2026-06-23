import { FieldGroup, FormSection, TpInput, TpSelect, TpTextarea } from "@leadwolf/ui";

function Panel({ children, width = 480 }: { children: import("react").ReactNode; width?: number }) {
  return (
    <div
      style={{
        width,
        padding: 24,
        border: "1px solid var(--tp-hairline)",
        borderRadius: "var(--radius)",
        background: "var(--tp-surface)",
      }}
    >
      {children}
    </div>
  );
}

export function ProfileSettings() {
  return (
    <Panel>
      <FormSection
        title="Profile"
        description="This information appears on your contact records and outbound email signature."
      >
        <FieldGroup label="Full name" htmlFor="ps-name">
          <TpInput id="ps-name" defaultValue="Dana Whitfield" />
        </FieldGroup>
        <FieldGroup label="Work email" htmlFor="ps-email" hint="Used for sign-in and notifications.">
          <TpInput id="ps-email" type="email" defaultValue="dana@acme.com" />
        </FieldGroup>
        <FieldGroup label="Bio" htmlFor="ps-bio">
          <TpTextarea id="ps-bio" rows={3} defaultValue="Head of revenue ops at Acme." />
        </FieldGroup>
      </FormSection>
    </Panel>
  );
}

export function StackedSections() {
  return (
    <Panel>
      <FormSection title="Workspace" description="Visible to everyone on your team.">
        <FieldGroup label="Workspace name" htmlFor="ss-ws">
          <TpInput id="ss-ws" defaultValue="Acme Revenue" />
        </FieldGroup>
        <FieldGroup label="Time zone" htmlFor="ss-tz">
          <TpSelect id="ss-tz" defaultValue="us-east">
            <option value="us-east">Eastern (US & Canada)</option>
            <option value="us-pacific">Pacific (US & Canada)</option>
            <option value="utc">UTC</option>
          </TpSelect>
        </FieldGroup>
      </FormSection>
      <FormSection title="Notifications" description="Choose what lands in your inbox.">
        <FieldGroup label="Daily digest email" htmlFor="ss-digest">
          <TpSelect id="ss-digest" defaultValue="weekday">
            <option value="weekday">Weekdays at 8am</option>
            <option value="off">Off</option>
          </TpSelect>
        </FieldGroup>
      </FormSection>
    </Panel>
  );
}
