import { ToastProvider, useToast } from "@leadwolf/ui";
import type { ReactNode } from "react";
import { useEffect } from "react";

// The toaster is position:fixed (bottom-right). Give it a sized, transformed stage so the fixed
// layer anchors to the card instead of escaping it.
function Stage({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: "relative",
        height: 400,
        transform: "translateZ(0)",
        overflow: "hidden",
        borderRadius: 8,
        background: "var(--tp-surface-2)",
      }}
    >
      <div style={{ padding: 24, color: "var(--tp-ink-4)", fontSize: 13 }}>
        Toasts stack bottom-right and auto-dismiss.
      </div>
      {children}
    </div>
  );
}

// Fires representative toasts on mount via useToast(); duration:0 keeps them visible for the shot.
function Emit() {
  const { toast } = useToast();
  useEffect(() => {
    toast({
      tone: "success",
      title: "List imported",
      description: "412 contacts added to “Q2 Outbound”.",
      duration: 0,
    });
    toast({ title: "Sequence scheduled", description: "Starts tomorrow at 9:00 AM.", duration: 0 });
    toast({
      tone: "error",
      title: "Sync failed",
      description: "Reconnect Salesforce to resume.",
      duration: 0,
    });
  }, [toast]);
  return null;
}

export function Stack() {
  return (
    <Stage>
      <ToastProvider>
        <Emit />
      </ToastProvider>
    </Stage>
  );
}
