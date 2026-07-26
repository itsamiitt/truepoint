// CopyButton — the copy affordance beside a revealed value. It writes to the clipboard and toasts, so it
// only makes sense inside the ToastProvider the app's shell supplies.
import { CopyButton } from "@leadwolf/ui";
import { Shell, pad } from "./_prospectShell";

/** Beside the values it actually accompanies in the grid and the record detail. */
export const Values = () => (
  <Shell>
    <div style={{ ...pad, display: "flex", flexDirection: "column", gap: 10 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13 }}>priya.raghunathan@ramp.com</span>
        <CopyButton value="priya.raghunathan@ramp.com" label="Copy email" />
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13 }}>+1 415 555 0142</span>
        <CopyButton value="+1 415 555 0142" label="Copy phone" />
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13 }}>linkedin.com/in/priya-raghunathan</span>
        <CopyButton value="https://www.linkedin.com/in/priya-raghunathan" label="Copy LinkedIn URL" />
      </span>
    </div>
  </Shell>
);
