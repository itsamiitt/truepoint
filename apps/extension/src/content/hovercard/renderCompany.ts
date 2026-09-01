// renderCompany.ts — paints a CompanyCardVm. Same full-repaint discipline as renderPerson. The company card
// reads ZERO page DOM — everything here came from the server, addressed by the URL alone (X07 stays deferred).
import { type CardHandlers, type CardRegions, button, el } from "./dom.ts";
import type { CompanyCardVm } from "./viewModel.ts";

export function renderCompany(
  regions: CardRegions,
  vm: CompanyCardVm,
  handlers: CardHandlers,
): void {
  regions.avatarEl.classList.add("square");
  regions.avatarEl.replaceChildren();
  if (vm.logoUrl) {
    const img = document.createElement("img");
    img.src = vm.logoUrl;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => {
      img.remove();
      regions.avatarEl.textContent = vm.monogram;
    });
    regions.avatarEl.appendChild(img);
  } else {
    regions.avatarEl.textContent = vm.monogram;
  }
  regions.nameEl.textContent = vm.name;
  regions.subEl.textContent = vm.sub ?? "";
  regions.metaEl.textContent = "";
  regions.metaEl.hidden = true;
  regions.pillEl.textContent = vm.pill ?? "";
  regions.pillEl.hidden = !vm.pill;

  const body = regions.bodyEl;
  body.replaceChildren();

  if (vm.phase === "C0") {
    body.append(el("div", "skel"), el("div", "skel"));
  }

  if (vm.headcount) {
    const line = el("div", "hcount", vm.headcount.count);
    if (vm.headcount.growth) line.appendChild(el("span", "growth", vm.headcount.growth));
    body.appendChild(line);
  }
  if (vm.foundedHq) body.appendChild(el("div", "hint", vm.foundedHq));
  if (vm.hint) body.appendChild(el("div", "hint", vm.hint));

  const footer = regions.footerEl;
  footer.replaceChildren();
  if (vm.buttons.length > 0) {
    const rowEl = el("div", "btnrow");
    for (const b of vm.buttons) {
      rowEl.appendChild(
        button(
          b.kind === "secondary" ? "btn secondary" : "btn",
          b.label,
          () => handlers.onAction(b.id),
          { disabled: b.disabled },
        ),
      );
    }
    footer.appendChild(rowEl);
  }
  if (vm.openPanelLabel) {
    footer.appendChild(button("ghost", vm.openPanelLabel, () => handlers.onOpenPanel()));
  }
  footer.hidden = footer.childElementCount === 0;
}
