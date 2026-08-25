// overlay.test.tsx — the modal contract that references/accessibility.md promises callers ("the DS Drawer
// and Dialog handle this — do not hand-roll an overlay that skips it"). Before these tests the file promised
// focus-in, a trap, Escape and focus-return, and the implementation had only Escape.
import "../test/dom.ts";

import { describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { active } from "../test/dom.ts";
import { TpButton } from "./controls.tsx";
import { DropdownMenu } from "./floating.tsx";
import { Dialog, Drawer } from "./overlay.tsx";

/** Escape/Tab are handled by capture-phase listeners on `document`; fireEvent wraps the resulting state
 *  update in act() so React 19 flushes it before the assertion. */
const press = (key: string, target: Document | Element = document, init: object = {}) =>
  fireEvent.keyDown(target, { key, ...init });

/** A dialog owned by a real opener button, so focus-return has something to return TO. */
function Harness({ title }: { title?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" id="opener" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={title} description="Body copy">
        <input id="first" />
        <input id="last" />
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  test("moves focus into the dialog when it opens", () => {
    const { container } = render(<Harness title="Revoke key" />);
    fireEvent.click(container.querySelector("#opener") as HTMLElement);
    expect(active()?.id).toBe("first");
    cleanup();
  });

  test("returns focus to the element that opened it", () => {
    const { container } = render(<Harness title="Revoke key" />);
    const opener = container.querySelector("#opener") as HTMLElement;
    opener.focus();
    fireEvent.click(opener);
    press("Escape");
    expect(active()?.id).toBe("opener");
    cleanup();
  });

  test("Escape closes it", () => {
    const { container } = render(<Harness title="Revoke key" />);
    fireEvent.click(container.querySelector("#opener") as HTMLElement);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    press("Escape");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    cleanup();
  });

  test("names itself from `title` via aria-labelledby", () => {
    const { container } = render(<Harness title="Revoke key" />);
    fireEvent.click(container.querySelector("#opener") as HTMLElement);
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId as string)?.textContent).toBe("Revoke key");
    // The description is wired too — it used to render with no aria-describedby at all.
    const descId = dialog.getAttribute("aria-describedby");
    expect(document.getElementById(descId as string)?.textContent).toBe("Body copy");
    cleanup();
  });

  test("traps Tab at the last control and wraps to the first", () => {
    const { container } = render(<Harness title="Revoke key" />);
    fireEvent.click(container.querySelector("#opener") as HTMLElement);
    const last = document.querySelector("#last") as HTMLElement;
    last.focus();
    press("Tab", last);
    expect(active()?.id).toBe("first");
    cleanup();
  });

  test("Shift+Tab at the first control wraps to the last", () => {
    const { container } = render(<Harness title="Revoke key" />);
    fireEvent.click(container.querySelector("#opener") as HTMLElement);
    const first = document.querySelector("#first") as HTMLElement;
    first.focus();
    press("Tab", first, { shiftKey: true });
    expect(active()?.id).toBe("last");
    cleanup();
  });

  test("renders in a portal on document.body, not inside its parent", () => {
    // A `transform`/`filter` ancestor re-parents position:fixed, which would trap the modal inside a card.
    const { container } = render(<Harness title="Revoke key" />);
    fireEvent.click(container.querySelector("#opener") as HTMLElement);
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    cleanup();
  });

  test("locks body scroll while open and restores it on close", () => {
    const { container } = render(<Harness title="Revoke key" />);
    fireEvent.click(container.querySelector("#opener") as HTMLElement);
    expect(document.body.style.overflow).toBe("hidden");
    press("Escape");
    expect(document.body.style.overflow).not.toBe("hidden");
    cleanup();
  });
});

describe("Drawer", () => {
  test("is named by a non-string title through aria-labelledby", () => {
    // The old implementation only set aria-label when `title` was a string, so a ReactNode title — which the
    // prop type and the docs both allow — produced an unnamed dialog with no warning.
    render(
      <Drawer open onClose={() => {}} title={<span>Ada Lovelace</span>}>
        <button type="button">Save</button>
      </Drawer>,
    );
    const drawer = document.querySelector('[role="dialog"]') as HTMLElement;
    const labelId = drawer.getAttribute("aria-labelledby");
    expect(document.getElementById(labelId as string)?.textContent).toBe("Ada Lovelace");
    cleanup();
  });
});

describe("overlay stacking", () => {
  test("Escape closes only the top-most layer", () => {
    // A menu inside a dialog: one press closed BOTH before the shared stack existed, because overlay.tsx
    // listened on document, floating.tsx on window, and neither stopped propagation.
    function Nested() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onClose={() => setOpen(false)} title="Row actions">
          <DropdownMenu
            trigger={({ toggle, props }) => (
              <TpButton {...props} id="menu-trigger" onClick={toggle}>
                Actions
              </TpButton>
            )}
            items={[{ label: "Delete" }]}
          />
        </Dialog>
      );
    }
    render(<Nested />);
    fireEvent.click(document.querySelector("#menu-trigger") as HTMLElement);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    press("Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    press("Escape");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    cleanup();
  });
});
