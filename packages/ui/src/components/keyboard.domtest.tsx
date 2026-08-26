// keyboard.test.tsx — the composite-widget keyboard models. Every widget here shipped its ARIA roles with
// no key handling at all: a `role="menu"` whose arrows did nothing, tabs that were all in the tab order,
// a listbox that could not be walked, and a table whose sort and row-open were mouse-only. The roles made
// the accessibility tree look correct, which is precisely why nothing caught it — structure was right and
// operability was absent. These tests assert operability.
import "../test/dom.ts";

import { describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { active } from "../test/dom.ts";
import { Combobox } from "./Combobox.tsx";
import { DataTable } from "./DataTable.tsx";
import { SegmentedControl, Tabs } from "./Tabs.tsx";
import { ToastProvider, useToast } from "./Toast.tsx";
import { TpButton, TpCheckbox, TpChip, TpSwitch } from "./controls.tsx";
import { DropdownMenu, Tooltip } from "./floating.tsx";

const press = (key: string, target: Document | Element = document, init: object = {}) =>
  fireEvent.keyDown(target, { key, ...init });

const menuItems = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));

describe("DropdownMenu", () => {
  function Menu() {
    return (
      <DropdownMenu
        trigger={({ toggle, props }) => (
          <TpButton {...props} id="trigger" onClick={toggle}>
            Actions
          </TpButton>
        )}
        items={[{ label: "Rename" }, { label: "Duplicate" }, { label: "Delete", danger: true }]}
      />
    );
  }

  test("the trigger advertises the menu through the props it is handed", () => {
    // The DS wires this now. It used to be the caller's job at ~40 sites — 40 chances to forget.
    render(<Menu />);
    const trigger = document.querySelector("#trigger") as HTMLElement;
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe(
      (document.querySelector('[role="menu"]')?.parentElement as HTMLElement).id,
    );
    cleanup();
  });

  test("focus enters the menu on open", () => {
    render(<Menu />);
    fireEvent.click(document.querySelector("#trigger") as HTMLElement);
    expect(active()?.textContent).toBe("Rename");
    cleanup();
  });

  test("ArrowDown/ArrowUp walk the items and wrap", () => {
    render(<Menu />);
    fireEvent.click(document.querySelector("#trigger") as HTMLElement);
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    press("ArrowDown", menu);
    expect(active()?.textContent).toBe("Duplicate");
    press("ArrowDown", menu);
    expect(active()?.textContent).toBe("Delete");
    press("ArrowDown", menu); // wraps
    expect(active()?.textContent).toBe("Rename");
    press("ArrowUp", menu); // wraps backwards
    expect(active()?.textContent).toBe("Delete");
    cleanup();
  });

  test("Home and End jump to the ends", () => {
    render(<Menu />);
    fireEvent.click(document.querySelector("#trigger") as HTMLElement);
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    press("End", menu);
    expect(active()?.textContent).toBe("Delete");
    press("Home", menu);
    expect(active()?.textContent).toBe("Rename");
    cleanup();
  });

  test("selecting an item closes the menu and returns focus to the trigger", () => {
    // Focus used to be dropped on the unmounted item, landing on <body>.
    render(<Menu />);
    const trigger = document.querySelector("#trigger") as HTMLElement;
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(menuItems()[1] as HTMLElement);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(active()?.id).toBe("trigger");
    cleanup();
  });
});

describe("Tooltip", () => {
  test("describes the TRIGGER, not the wrapper", () => {
    // aria-describedby on the wrapper span meant the tooltip text was never announced: a screen reader
    // reads the describedby of the element that has focus, and the wrapper never does.
    render(
      <Tooltip label="Sorted by score">
        <button type="button" id="tip-trigger">
          Score
        </button>
      </Tooltip>,
    );
    const trigger = document.querySelector("#tip-trigger") as HTMLElement;
    fireEvent.focus(trigger);
    const describedBy = trigger.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe("Sorted by score");
    cleanup();
  });

  test("Escape dismisses it (WCAG 2.2 SC 1.4.13)", () => {
    render(
      <Tooltip label="Sorted by score">
        <button type="button" id="tip-trigger">
          Score
        </button>
      </Tooltip>,
    );
    fireEvent.focus(document.querySelector("#tip-trigger") as HTMLElement);
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    press("Escape");
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    cleanup();
  });
});

describe("Tabs", () => {
  function Bar() {
    const [value, setValue] = useState("overview");
    return (
      <Tabs
        aria-label="Contact detail"
        value={value}
        onChange={setValue}
        items={[
          { value: "overview", label: "Overview" },
          { value: "activity", label: "Activity" },
          { value: "notes", label: "Notes" },
        ]}
      />
    );
  }

  test("uses roving tabindex — one tab stop for the group", () => {
    render(<Bar />);
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    cleanup();
  });

  test("ArrowRight selects the next tab and moves focus with it", () => {
    render(<Bar />);
    const list = document.querySelector('[role="tablist"]') as HTMLElement;
    press("ArrowRight", list);
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    cleanup();
  });

  test("ArrowLeft from the first tab wraps to the last; Home returns", () => {
    render(<Bar />);
    const list = document.querySelector('[role="tablist"]') as HTMLElement;
    press("ArrowLeft", list);
    expect(document.querySelectorAll('[role="tab"]')[2]?.getAttribute("aria-selected")).toBe(
      "true",
    );
    press("Home", list);
    expect(document.querySelectorAll('[role="tab"]')[0]?.getAttribute("aria-selected")).toBe(
      "true",
    );
    cleanup();
  });
});

describe("SegmentedControl", () => {
  test("is a radiogroup, not a tablist", () => {
    // It picks a VALUE (a period, a scope). Calling it a tablist told screen-reader users to expect a
    // panel that never existed.
    function Picker() {
      const [value, setValue] = useState("7d");
      return (
        <SegmentedControl
          aria-label="Period"
          value={value}
          onChange={setValue}
          items={[
            { value: "7d", label: "7 days" },
            { value: "30d", label: "30 days" },
          ]}
        />
      );
    }
    render(<Picker />);
    expect(document.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    const group = document.querySelector('[role="radiogroup"]') as HTMLElement;
    press("ArrowRight", group);
    const radios = Array.from(document.querySelectorAll<HTMLElement>('[role="radio"]'));
    expect(radios[1]?.getAttribute("aria-checked")).toBe("true");
    cleanup();
  });
});

describe("Combobox", () => {
  function Picker() {
    const [value, setValue] = useState<string | null>(null);
    return (
      <Combobox
        value={value}
        onChange={setValue}
        options={[
          { value: "a", label: "Acme" },
          { value: "b", label: "Bolt" },
          { value: "c", label: "Cogent" },
        ]}
      />
    );
  }
  const openIt = () => {
    render(<Picker />);
    fireEvent.click(document.querySelector('[aria-haspopup="listbox"]') as HTMLElement);
    return document.querySelector('[role="combobox"]') as HTMLElement;
  };

  test("the listbox holds only options — the search input is the combobox", () => {
    // role="listbox" used to wrap the input too, which is invalid: a listbox may only contain options.
    const input = openIt();
    expect(input.tagName).toBe("INPUT");
    const listbox = document.querySelector('[role="listbox"]') as HTMLElement;
    expect(listbox.contains(input)).toBe(false);
    cleanup();
  });

  test("ArrowDown moves the active option and Enter selects it", () => {
    const input = openIt();
    const first = input.getAttribute("aria-activedescendant");
    expect(document.getElementById(first as string)?.textContent).toContain("Acme");
    press("ArrowDown", input);
    const second = input.getAttribute("aria-activedescendant");
    expect(document.getElementById(second as string)?.textContent).toContain("Bolt");
    press("Enter", input);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(
      (document.querySelector('[aria-haspopup="listbox"]') as HTMLElement).textContent,
    ).toContain("Bolt");
    cleanup();
  });

  test("Escape closes it and returns focus to the trigger", () => {
    const input = openIt();
    press("Escape", input);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(active()?.getAttribute("aria-haspopup")).toBe("listbox");
    cleanup();
  });
});

describe("DataTable", () => {
  const rows = [
    { id: "1", name: "Ada" },
    { id: "2", name: "Grace" },
  ];
  const columns = [
    {
      key: "name",
      header: "Name",
      cell: (r: (typeof rows)[number]) => r.name,
      sortValue: (r: (typeof rows)[number]) => r.name,
    },
  ];

  test("the sortable header is a real button, inside a scoped th", () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />);
    const th = document.querySelector("th") as HTMLElement;
    expect(th.getAttribute("scope")).toBe("col");
    const button = th.querySelector("button");
    expect(button).not.toBeNull();
    // …and it sorts when activated, which is what a keyboard user could not do before.
    fireEvent.click(button as HTMLElement);
    expect(th.getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(button as HTMLElement);
    expect(th.getAttribute("aria-sort")).toBe("descending");
    cleanup();
  });

  test("an activatable row is focusable and opens on Enter and Space", () => {
    const opened: string[] = [];
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={(r) => opened.push(r.name)}
      />,
    );
    const row = document.querySelector("tbody tr") as HTMLElement;
    expect(row.tabIndex).toBe(0);
    press("Enter", row);
    press(" ", row);
    expect(opened).toEqual(["Ada", "Ada"]);
    cleanup();
  });

  test("a key from a control INSIDE the row does not open the row", () => {
    const opened: string[] = [];
    render(
      <DataTable
        columns={[{ key: "a", header: "A", cell: () => <button type="button">Menu</button> }]}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={(r) => opened.push(r.name)}
      />,
    );
    press("Enter", document.querySelector("tbody button") as HTMLElement);
    expect(opened).toEqual([]);
    cleanup();
  });

  test("selection is data-selected, not aria-selected", () => {
    // aria-selected on a plain <tr> outside a grid/treegrid is invalid ARIA.
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        isSelected={(r) => r.id === "2"}
      />,
    );
    const trs = Array.from(document.querySelectorAll("tbody tr"));
    expect(trs[1]?.getAttribute("data-selected")).toBe("true");
    expect(trs[1]?.getAttribute("aria-selected")).toBeNull();
    cleanup();
  });
});

describe("Toast", () => {
  function Harness() {
    const { toast } = useToast();
    return (
      <button type="button" id="fire" onClick={() => toast({ title: "Saved", duration: 0 })}>
        Fire
      </button>
    );
  }

  test("the live region exists BEFORE any toast is pushed", () => {
    // A region created in the same commit as its first message is the classic reason first toasts go
    // unannounced — the AT has to be watching the node before text lands in it.
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    const region = document.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe("");
    cleanup();
  });

  test("a sticky toast can be dismissed from the keyboard", () => {
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    fireEvent.click(document.querySelector("#fire") as HTMLElement);
    const close = document.querySelector('[aria-label="Dismiss notification"]') as HTMLElement;
    expect(close).not.toBeNull();
    fireEvent.click(close);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe("");
    cleanup();
  });
});

describe("controls", () => {
  test("TpCheckbox and TpSwitch accept children as the label instead of crashing", () => {
    // `children` was documented and spread onto the <input>, which React rejects as a void element.
    render(
      <>
        <TpCheckbox id="cb">Remember me</TpCheckbox>
        <TpSwitch id="sw">Auto-enrich</TpSwitch>
      </>,
    );
    expect(document.body.textContent).toContain("Remember me");
    expect(document.body.textContent).toContain("Auto-enrich");
    expect((document.querySelector("#cb") as HTMLInputElement).type).toBe("checkbox");
    cleanup();
  });

  test("TpChip's remove control is a sibling button, never nested in one", () => {
    // Interactive content inside a <button> is invalid HTML with undefined AT behaviour.
    render(
      <TpChip onClick={() => {}} onRemove={() => {}} removeLabel="Remove filter Industry">
        Industry
      </TpChip>,
    );
    const remove = document.querySelector(
      '[aria-label="Remove filter Industry"]',
    ) as HTMLButtonElement;
    expect(remove.tagName).toBe("BUTTON");
    // Its nearest button ancestor is ITSELF — i.e. it is not inside another button.
    expect(remove.closest("button")).toBe(remove);
    cleanup();
  });
});
