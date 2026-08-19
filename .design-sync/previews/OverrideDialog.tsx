// OverrideDialog - manage a flag's per-tenant overrides: force it on or off for one tenant, independently
// of the global switch.
import { OverrideDialog } from "@leadwolf/ui";
import { FLAG } from "./_adminFixtures";
import { Stage } from "./_appPage";

/** A flag with two existing overrides - one forcing on, one forcing off. */
export const WithOverrides = () => (
  <Stage height={560}>
    <OverrideDialog flag={FLAG} onClose={() => {}} onChanged={() => {}} />
  </Stage>
);

/** A flag nobody has overridden yet. */
export const NoOverrides = () => (
  <Stage height={520}>
    <OverrideDialog
      flag={{ ...FLAG, key: "chrome_extension_enabled", overrides: [] }}
      onClose={() => {}}
      onChanged={() => {}}
    />
  </Stage>
);
