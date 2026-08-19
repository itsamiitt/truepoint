// ImportDraftPreviewPanel - the validation preview of a draft import: what the mapping would produce, why
// rows would be rejected, which columns are misbehaving, and a sample of the rejected rows themselves.
//
// `cached` is not cosmetic. A resumed draft shows the summary stored with it immediately, but the row
// SAMPLES need a fresh pass, so the panel has to say which of the two it is showing rather than implying
// the whole thing is live.
//
// The prop is the full ImportDraftPreviewResponse: `summary` (with its rejectHistogram and perColumn
// feedback) plus `sampleRejectedRows`. Every one of those is read with `.length` or `Object.keys()`, so a
// partial fixture is a crash, not a degraded render - this preview cost three passes to get right.
import { ImportDraftPreviewPanel } from "@leadwolf/ui";
import { Frame } from "./_webPage";

const PREVIEW = {
  summary: {
    total: 4_820,
    valid: 4_733,
    rejected: 87,
    wouldCreate: 3_991,
    wouldUpdate: 742,
    duplicateInFile: 51,
    // Reject CODE → count. Labels, never raw values — the histogram must not leak file contents.
    rejectHistogram: { missing_email: 41, invalid_email: 28, missing_name: 12, duplicate_in_file: 6 },
    perColumn: [
      { column: "Work email", parseFailures: 69, dominantRejectCode: "invalid_email", sampleLines: [14, 88, 204, 512, 903] },
      { column: "Country", parseFailures: 18, dominantRejectCode: null, sampleLines: [42, 610] },
    ],
  },
  sampleRejectedRows: [
    { row: 13, field: "email", reason: "Not a valid email address", code: "invalid_email", raw: { "Work email": "priya.raghunathan@", Company: "Ramp" } },
    { row: 87, field: "email", reason: "Missing a required value", code: "missing_email", raw: { "Work email": "", Company: "Vanta" } },
    { row: 203, field: null, reason: "Duplicate of row 14 in this file", code: "duplicate_in_file", raw: { "Work email": "aisling.byrne@linear.app", Company: "Linear" } },
    { row: 511, field: "firstName", reason: "Missing a required value", code: "missing_name", raw: { "First name": "", "Work email": "ops@figma.com" } },
  ],
};

/** A fresh validation pass over the uploaded file, with the reject breakdown and sample rows. */
export const Fresh = () => (
  <Frame>
    <ImportDraftPreviewPanel preview={PREVIEW} cached={false} busy={false} onRerun={() => {}} />
  </Frame>
);

/** A resumed draft: the summary is the stored one, and the panel says so rather than implying it is live. */
export const Cached = () => (
  <Frame>
    <ImportDraftPreviewPanel preview={PREVIEW} cached busy={false} onRerun={() => {}} />
  </Frame>
);

/** Re-running the validation pass. */
export const Rerunning = () => (
  <Frame>
    <ImportDraftPreviewPanel preview={PREVIEW} cached busy onRerun={() => {}} />
  </Frame>
);

/** A clean file: nothing rejected, so the breakdown sections correctly collapse away. */
export const NoRejects = () => (
  <Frame>
    <ImportDraftPreviewPanel
      preview={{
        summary: {
          total: 312,
          valid: 312,
          rejected: 0,
          wouldCreate: 288,
          wouldUpdate: 24,
          duplicateInFile: 0,
          rejectHistogram: {},
          perColumn: [],
        },
        sampleRejectedRows: [],
      }}
      cached={false}
      busy={false}
      onRerun={() => {}}
    />
  </Frame>
);

/** No preview yet - the panel offers the validate action instead of an empty summary. */
export const NotRunYet = () => (
  <Frame>
    <ImportDraftPreviewPanel preview={null} cached={false} busy={false} onRerun={() => {}} />
  </Frame>
);
