// ShortcutsDialog.tsx — the keyboard-shortcuts help overlay. Opens on "?" (when not typing) or a window
// "command:shortcuts" event (the top-bar button); closes on Esc. Static content over the shared Dialog.
"use client";

import { Dialog } from "@leadwolf/ui";
import { useEffect, useState } from "react";

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "⌘ / Ctrl + K", action: "Open the command palette" },
  { keys: "?", action: "Show this shortcuts help" },
  { keys: "Esc", action: "Close a dialog, drawer, or menu" },
];

export function ShortcutsDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onEvent = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "?" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("command:shortcuts", onEvent);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("command:shortcuts", onEvent);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts">
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {SHORTCUTS.map((s) => (
          <div
            key={s.action}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--tp-space-4)",
            }}
          >
            <span style={{ fontSize: "var(--tp-text-label)", color: "var(--tp-ink-2)" }}>
              {s.action}
            </span>
            <kbd
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--tp-text-caption)",
                color: "var(--tp-ink-3)",
                background: "var(--tp-surface-3)",
                border: "1px solid var(--tp-hairline-2)",
                borderRadius: 6,
                padding: "2px 6px",
              }}
            >
              {s.keys}
            </kbd>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
