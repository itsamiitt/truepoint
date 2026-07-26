// AiSearchBox — the natural-language search box (23, ADR-0023). Typing a description and pressing Ask
// compiles it server-side into a VALIDATED contactQuery, which opens in a confirmation Dialog; nothing is
// applied until the user confirms. The backend owns the per-tenant budget and the prompt-injection guard.
import { AiSearchBox } from "@leadwolf/ui";
import { useEffect, useRef } from "react";
import { Shell, Stage, pad } from "./_prospectShell";

/**
 * Drive the box through its own UI on mount: set the input via React's value setter (a bare `.value =`
 * assignment doesn't notify React), then click Ask. Same force-open family as the Combobox/Popover
 * patterns in NOTES.md — the compiled-preview Dialog is the state worth showing, and it is only reachable
 * through the component's real flow.
 */
function useAsk(text: string) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const input = el?.querySelector("input");
    const ask = [...(el?.querySelectorAll("button") ?? [])].find((b) => /ask/i.test(b.textContent ?? ""));
    if (!input || !ask) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const id = setTimeout(() => ask.click(), 0);
    return () => clearTimeout(id);
  }, [text]);
  return ref;
}

/** The resting box: prompt input plus the Ask action. */
export const Resting = () => (
  <Shell>
    <div style={pad}>
      <AiSearchBox onApply={() => {}} />
    </div>
  </Shell>
);

/** After Ask — the confirmation Dialog holding the compiled filter for the user to accept or discard. */
export const Compiled = () => {
  const ref = useAsk("senior engineering leaders at US companies with a verified email");
  return (
    <Shell>
      <Stage height={420}>
        <div ref={ref} style={pad}>
          <AiSearchBox onApply={() => {}} />
        </div>
      </Stage>
    </Shell>
  );
};
