// export.ts — a client-side CSV export of the MASKED prospect rows (05 §6/§7). It serializes ONLY the non-PII
// facets already shown in the grid (name, title, email domain + status, masked flags) — never real email/phone
// (those exist only in a reveal response, never in the masked list). This is an honest "export what you see"
// for the masked universe; the monetized `/exports` of revealed data is a separate, server-side path.
"use client";

import type { MaskedContact } from "@leadwolf/types";
import { displayName } from "./types";

/** RFC-4180 escape: quote a cell and double any embedded quotes. */
function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

const HEADERS = [
  "Name",
  "Title",
  "Email domain",
  "Email status",
  "Has email",
  "Has phone",
  "Seniority",
  "Department",
  "Country",
  "Outreach status",
  "Revealed",
];

function toRow(c: MaskedContact): string {
  return [
    displayName(c),
    c.jobTitle ?? "",
    c.emailDomain ?? "",
    c.emailStatus,
    c.hasEmail ? "yes" : "no",
    c.hasPhone ? "yes" : "no",
    c.seniorityLevel ?? "",
    c.department ?? "",
    c.locationCountry ?? "",
    c.outreachStatus,
    c.isRevealed ? "yes" : "no",
  ]
    .map((v) => csvCell(String(v)))
    .join(",");
}

/** Build a CSV string for a set of masked rows (header + one row each). Pure — unit-testable without the DOM. */
export function maskedCsv(contacts: MaskedContact[]): string {
  return [HEADERS.map(csvCell).join(","), ...contacts.map(toRow)].join("\r\n");
}

/** Trigger a browser download of the masked-rows CSV. No-PII; client-side only. */
export function exportMaskedCsv(contacts: MaskedContact[], filename = "prospects.csv"): void {
  const blob = new Blob([maskedCsv(contacts)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
