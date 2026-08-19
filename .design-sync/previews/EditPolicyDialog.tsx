// EditPolicyDialog - edit one retention policy: a data class's time-to-live and its mode.
//
// `mode` is the arming switch and the only thing here that deletes data. `shadow` counts candidates and
// audits them but purges nothing — the shadow evidence staff review BEFORE arming. `enforce` permanently
// deletes aged rows, which is why the server gates that flip super_admin-only and audits it.
//
// The policy prop is the retention ENGINE's shape ({dataClass, ttlDays, mode}), not the compliance
// surface's ({entity, retentionDays, reason}). They are easy to confuse and the wrong one renders
// "Global policy for undefined" with an empty TTL.
import { EditPolicyDialog } from "@leadwolf/ui";
import { RETENTION_POLICY } from "./_adminFixtures";
import { Stage } from "./_appPage";

/** An armed class: provider calls, 90-day TTL, enforce — deletion is live for this one. */
export const Enforcing = () => (
  <Stage height={520}>
    <EditPolicyDialog policy={RETENTION_POLICY} onClose={() => {}} onSaved={() => {}} />
  </Stage>
);

/** A class still in shadow mode - counted and audited, nothing purged. */
export const Observing = () => (
  <Stage height={520}>
    <EditPolicyDialog
      policy={{ dataClass: "activities", ttlDays: 365, mode: "shadow" }}
      onClose={() => {}}
      onSaved={() => {}}
    />
  </Stage>
);

/** No TTL at all: this class is never auto-deleted, which the field has to say rather than show a blank. */
export const NeverExpires = () => (
  <Stage height={520}>
    <EditPolicyDialog
      policy={{ dataClass: "contact_reveals", ttlDays: null, mode: "shadow" }}
      onClose={() => {}}
      onSaved={() => {}}
    />
  </Stage>
);
