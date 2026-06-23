import { Dialog, TpButton } from "@leadwolf/ui";

// Dialog renders a position:fixed scrim + centered card. In a preview card we give it a sized,
// transformed stage so the fixed layer's containing block has real height (otherwise the centered
// card clips at the top) and the scrim is clipped to the card instead of escaping.
function Stage({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "relative",
        height: 460,
        transform: "translateZ(0)",
        overflow: "hidden",
        borderRadius: 8,
        background: "var(--tp-surface)",
      }}
    >
      {children}
    </div>
  );
}

export function ConfirmDestructive() {
  return (
    <Stage>
      <Dialog
        open
        onClose={() => {}}
        title="Delete this list?"
        description="This permanently removes “Q2 Outbound” and its 412 contacts. This can't be undone."
        footer={
          <>
            <TpButton variant="ghost" onClick={() => {}}>
              Cancel
            </TpButton>
            <TpButton variant="danger" onClick={() => {}}>
              Delete list
            </TpButton>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 14, color: "var(--tp-ink-2)", lineHeight: 1.5 }}>
          Contacts already exported to a campaign keep their copy — only the list grouping is removed.
        </p>
      </Dialog>
    </Stage>
  );
}
