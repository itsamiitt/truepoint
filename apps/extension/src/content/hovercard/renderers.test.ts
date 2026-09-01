// renderers.test.ts — DOM-level tests for the vanilla painters, on a happy-dom Window.
//
// GLOBALS ARE SCOPED TO THIS FILE ON PURPOSE. bun loads every test module before running any, and a
// GlobalRegistrator.register() at module scope would put `document` into every other test's world for the
// whole run (the global-state hazard that has bitten this repo before — see the .domtest convention in
// apps/web). Here the Window is created in beforeAll, `document` is set on globalThis for the duration of
// THIS file's tests, and the previous value (undefined) is restored in afterAll — nothing leaks past it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import type { CardHandlers, CardRegions } from "./dom.ts";
import { renderCompany } from "./renderCompany.ts";
import { renderPerson } from "./renderPerson.ts";
import type { CompanyCardVm, PersonCardVm } from "./viewModel.ts";

let win: Window;
const hadDocument = "document" in globalThis;
const priorDocument = (globalThis as { document?: unknown }).document;

beforeAll(() => {
  win = new Window();
  (globalThis as { document?: unknown }).document = win.document;
});

afterAll(() => {
  if (hadDocument) (globalThis as { document?: unknown }).document = priorDocument;
  else delete (globalThis as { document?: unknown }).document;
  void win.happyDOM.close();
});

function regions(): CardRegions {
  const doc = win.document;
  const make = (): HTMLElement => doc.createElement("div") as unknown as HTMLElement;
  return {
    avatarEl: make(),
    nameEl: make(),
    subEl: make(),
    metaEl: make(),
    pillEl: make(),
    bodyEl: make(),
    footerEl: make(),
  };
}

function handlers(log: string[]): CardHandlers {
  return {
    onAction: (id) => log.push(`action:${id}`),
    onCopy: (channel, value) => log.push(`copy:${channel}:${value}`),
    onOpenPanel: () => log.push("openPanel"),
  };
}

function personVm(over: Partial<PersonCardVm>): PersonCardVm {
  return {
    phase: "P8",
    name: "Jane Doe",
    sub: "VP Sales · Acme",
    meta: "Austin, TX",
    initials: "JD",
    pill: "In TruePoint",
    alert: null,
    hint: null,
    channels: [],
    freshnessLine: null,
    skeleton: false,
    buttons: [],
    openPanelLabel: null,
    error: null,
    ...over,
  };
}

describe("renderPerson", () => {
  it("paints identity, pill and meta; hides an absent meta line", () => {
    const r = regions();
    renderPerson(r, personVm({}), handlers([]));
    expect(r.nameEl.textContent).toBe("Jane Doe");
    expect(r.subEl.textContent).toBe("VP Sales · Acme");
    expect(r.metaEl.textContent).toBe("Austin, TX");
    expect(r.metaEl.hidden).toBe(false);
    expect(r.pillEl.textContent).toBe("In TruePoint");
    expect(r.avatarEl.textContent).toBe("JD");

    renderPerson(r, personVm({ meta: null }), handlers([]));
    expect(r.metaEl.hidden).toBe(true);
  });

  it("a value channel gets a Copy control wired to the handler; a presence line does not", () => {
    const r = regions();
    const log: string[] = [];
    renderPerson(
      r,
      personVm({
        channels: [
          {
            id: "email",
            line: "jane@acme.example",
            isValue: true,
            masked: false,
            numeric: false,
            badge: { tone: "success", text: "Verified" },
            copied: false,
          },
          {
            id: "phone",
            line: "Phone on record",
            isValue: false,
            masked: false,
            numeric: false,
            badge: null,
            copied: false,
          },
        ],
      }),
      handlers(log),
    );
    const buttons = r.bodyEl.querySelectorAll("button.copybtn");
    expect(buttons.length).toBe(1);
    (buttons[0] as unknown as HTMLButtonElement).click();
    expect(log).toEqual(["copy:email:jane@acme.example"]);
    expect(r.bodyEl.textContent).toContain("Verified");
    expect(r.bodyEl.textContent).toContain("Phone on record");
  });

  it("footer buttons dispatch their action ids; the ghost dispatches openPanel; empty footer hides", () => {
    const r = regions();
    const log: string[] = [];
    renderPerson(
      r,
      personVm({
        buttons: [
          {
            id: "revealEmail",
            label: "Reveal email · 1 credits",
            kind: "primary",
            disabled: false,
          },
          {
            id: "revealPhone",
            label: "Reveal phone · 5 credits",
            kind: "secondary",
            disabled: true,
          },
        ],
        openPanelLabel: "Open full profile",
      }),
      handlers(log),
    );
    const btns = r.footerEl.querySelectorAll("button.btn");
    expect(btns.length).toBe(2);
    (btns[0] as unknown as HTMLButtonElement).click();
    expect((btns[1] as unknown as HTMLButtonElement).disabled).toBe(true);
    const ghost = r.footerEl.querySelector("button.ghost") as unknown as HTMLButtonElement;
    ghost.click();
    expect(log).toEqual(["action:revealEmail", "openPanel"]);
    expect(r.footerEl.hidden).toBe(false);

    renderPerson(r, personVm({}), handlers(log));
    expect(r.footerEl.hidden).toBe(true);
  });

  it("alert, skeleton, hint and error each land in the body when present", () => {
    const r = regions();
    renderPerson(
      r,
      personVm({
        alert: "Job change detected · 2026-08-30",
        skeleton: true,
        hint: "Not enough credits",
        error: "Unexpected error.",
      }),
      handlers([]),
    );
    expect(r.bodyEl.textContent).toContain("Job change detected");
    expect(r.bodyEl.querySelectorAll(".skel").length).toBe(2);
    expect(r.bodyEl.textContent).toContain("Not enough credits");
    expect(r.bodyEl.textContent).toContain("Unexpected error.");
  });
});

describe("renderCompany", () => {
  const companyVm = (over: Partial<CompanyCardVm>): CompanyCardVm => ({
    phase: "C1",
    name: "Acme Corp",
    monogram: "A",
    logoUrl: null,
    sub: "Software · acme.example",
    pill: null,
    headcount: { count: "200 employees", growth: "+100% · 12 mo" },
    foundedHq: "Founded 2015 · Austin, US",
    hint: null,
    buttons: [],
    openPanelLabel: "Open company profile",
    ...over,
  });

  it("paints the monogram when no logo, headcount with growth, and the ghost", () => {
    const r = regions();
    const log: string[] = [];
    renderCompany(r, companyVm({}), handlers(log));
    expect(r.avatarEl.textContent).toBe("A");
    expect(r.avatarEl.classList.contains("square")).toBe(true);
    expect(r.bodyEl.textContent).toContain("200 employees");
    expect(r.bodyEl.textContent).toContain("+100% · 12 mo");
    expect(r.bodyEl.textContent).toContain("Founded 2015");
    (r.footerEl.querySelector("button.ghost") as unknown as HTMLButtonElement).click();
    expect(log).toEqual(["openPanel"]);
  });

  it("renders the logo img with no-referrer when a URL exists", () => {
    const r = regions();
    renderCompany(r, companyVm({ logoUrl: "https://cdn.example/logo.png" }), handlers([]));
    const img = r.avatarEl.querySelector("img");
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("C3 error offers the retry button wired to its action", () => {
    const r = regions();
    const log: string[] = [];
    renderCompany(
      r,
      companyVm({
        phase: "C3",
        headcount: null,
        foundedHq: null,
        hint: "Something went wrong. We'll retry.",
        buttons: [{ id: "retryIntel", label: "Retry", kind: "secondary", disabled: false }],
        openPanelLabel: null,
      }),
      handlers(log),
    );
    (r.footerEl.querySelector("button.btn") as unknown as HTMLButtonElement).click();
    expect(log).toEqual(["action:retryIntel"]);
  });
});
