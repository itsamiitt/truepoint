import { Popover, TpButton } from "@leadwolf/ui";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

// Popover owns its open state internally; the trigger render-prop exposes `toggle`. To show the
// open panel in a static screenshot we capture `toggle` and call it once on mount.
function useAutoOpen() {
  const toggleRef = useRef<() => void>(() => {});
  const openedRef = useRef(false);
  useEffect(() => {
    if (!openedRef.current) {
      openedRef.current = true;
      toggleRef.current();
    }
  }, []);
  return toggleRef;
}

// Floating layers anchor to the trigger and open downward — give the card room below the trigger.
function Stage({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: "24px 24px 200px", background: "var(--tp-surface)" }}>{children}</div>
  );
}

export function ColumnSettings() {
  const toggleRef = useAutoOpen();
  return (
    <Stage>
      <Popover
        align="start"
        trigger={({ toggle, open }) => {
          toggleRef.current = toggle;
          return (
            <TpButton variant="secondary" onClick={toggle} aria-expanded={open}>
              Columns ▾
            </TpButton>
          );
        }}
      >
        <div style={{ padding: 12, width: 220 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tp-ink-3)", marginBottom: 8 }}>
            Visible columns
          </div>
          {["Name", "Company", "Stage", "Owner", "Value"].map((c, i) => (
            <label
              key={c}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 14 }}
            >
              <input type="checkbox" defaultChecked={i < 4} />
              <span style={{ color: "var(--tp-ink)" }}>{c}</span>
            </label>
          ))}
        </div>
      </Popover>
    </Stage>
  );
}

export function SharePopover() {
  const toggleRef = useAutoOpen();
  return (
    <Stage>
      <Popover
        align="start"
        trigger={({ toggle, open }) => {
          toggleRef.current = toggle;
          return (
            <TpButton variant="primary" onClick={toggle} aria-expanded={open}>
              Share
            </TpButton>
          );
        }}
      >
        <div style={{ padding: 14, width: 260 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--tp-ink)", marginBottom: 4 }}>
            Share “Q2 Outbound”
          </div>
          <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--tp-ink-3)" }}>
            Anyone with the link can view this list.
          </p>
          <div
            style={{
              fontSize: 12,
              fontFamily: "monospace",
              color: "var(--tp-ink-2)",
              background: "var(--tp-surface-3)",
              borderRadius: "var(--radius)",
              padding: "6px 8px",
            }}
          >
            app.truepoint.io/l/q2-outbound
          </div>
        </div>
      </Popover>
    </Stage>
  );
}
