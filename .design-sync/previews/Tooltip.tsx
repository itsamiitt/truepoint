import { Tooltip, TpButton, TpIconButton } from "@leadwolf/ui";
import { useEffect, useRef } from "react";

// Tooltip opens on hover/focus (internal useState; no controlled `open` prop). To show the open tip in a
// static capture, focus the trigger on mount: React's onFocus is the bubbling `focusin` event, which DOES
// fire from a programmatic .focus() and reaches the Tooltip's anchor span. (A dispatched native
// `mouseenter` does NOT — React derives onMouseEnter from mouseover.) The tip opens upward → pad the top.
function useFocusTrigger() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
  }, []);
  return ref;
}

export function ButtonTip() {
  const ref = useFocusTrigger();
  return (
    <div ref={ref} style={{ padding: "150px 24px 32px", display: "flex", justifyContent: "center" }}>
      <Tooltip label="Permanently delete this list">
        <TpButton variant="danger">Delete</TpButton>
      </Tooltip>
    </div>
  );
}

export function IconTip() {
  const ref = useFocusTrigger();
  return (
    <div ref={ref} style={{ padding: "150px 24px 32px", display: "flex", justifyContent: "center" }}>
      <Tooltip label="Auto-enrich fills missing company + title from email">
        <TpIconButton label="About auto-enrich">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </TpIconButton>
      </Tooltip>
    </div>
  );
}
