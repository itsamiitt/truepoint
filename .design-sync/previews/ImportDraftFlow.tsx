// ImportDraftFlow - the draft-backed import wizard body: Map, then Preview, then Confirm.
//
// The invariant it exists to hold is UPLOAD-ONCE. The file is POSTed when it is picked; every step after
// that references the server DRAFT, never the bytes again - which is what makes the flow resumable across a
// reload, and why the wizard can only mount this once a draft exists.
//
// The `draft` prop is the controller from useImportDraft. Stories drive it directly, because `step` is the
// only thing that decides which of the three panels renders.
import { ImportDraftFlow, MappingGrid } from "@leadwolf/ui";
import * as D from "./_webData";
import { Page } from "./_webPage";

const SUMMARY = {
  total: 4_820,
  valid: 4_733,
  rejected: 87,
  wouldCreate: 3_991,
  wouldUpdate: 742,
  duplicateInFile: 51,
  rejectHistogram: { missing_email: 41, invalid_email: 28, missing_name: 12, duplicate_in_file: 6 },
  perColumn: [
    { column: "Work email", parseFailures: 69, dominantRejectCode: "invalid_email", sampleLines: [14, 88, 204] },
  ],
};

/** A stand-in for useImportDraft's return value — every verb inert, since a card commits nothing. */
const controller = (over: Record<string, unknown> = {}) =>
  ({
    inDraftMode: true,
    isResume: false,
    jobId: "00000000-0000-4000-8000-0000000000f1",
    ref: { current: null },
    resume: null,
    step: "map",
    preview: null,
    previewIsCached: false,
    mappingSaved: true,
    busy: null,
    flowError: null,
    resumeNote: null,
    clearFlowError: () => {},
    tryCreateDraft: async () => true,
    advanceFromMap: async () => true,
    rerunPreview: async () => true,
    goToStep: () => {},
    commit: async () => null,
    discard: async () => true,
    ...over,
  }) as never;

const shared = {
  fileName: "emea-contacts-aug.csv",
  fileInput: <input type="file" />,
  mergeControls: null,
  mappingSection: <MappingGrid headers={D.CSV_HEADERS} mapping={D.MAPPING} onChange={() => {}} />,
  identityMapped: true,
  mapping: D.MAPPING,
  mergeMode: "update" as const,
  preservePopulated: true,
  onStarted: () => {},
  onDiscarded: () => {},
};

/** Step 1 — bind the file's columns to canonical fields. Continue is gated on an identity column. */
export const MapStep = () => (
  <Page height={760}>
    <ImportDraftFlow {...shared} draft={controller()} />
  </Page>
);

/** Step 2 — what the mapping would produce, and why 87 rows would be rejected. */
export const PreviewStep = () => (
  <Page height={760}>
    <ImportDraftFlow
      {...shared}
      draft={controller({ step: "preview", preview: { summary: SUMMARY, sampleRejectedRows: [] } })}
    />
  </Page>
);

/** Step 3 — the last statement of what is about to happen, before anything is written. */
export const ConfirmStep = () => (
  <Page height={640}>
    <ImportDraftFlow
      {...shared}
      draft={controller({ step: "confirm", preview: { summary: SUMMARY, sampleRejectedRows: [] } })}
    />
  </Page>
);

/** A resumed draft: the mapping was saved with the draft and can no longer be edited here, so the Back
 *  control is gone and the flow says why. */
export const Resumed = () => (
  <Page height={760}>
    <ImportDraftFlow
      {...shared}
      draft={controller({
        step: "preview",
        isResume: true,
        previewIsCached: true,
        preview: { summary: SUMMARY, sampleRejectedRows: [] },
        resume: {
          jobId: "00000000-0000-4000-8000-0000000000f1",
          sourceFilename: "emea-contacts-aug.csv",
          mergeMode: "update",
          preservePopulated: true,
        },
      })}
    />
  </Page>
);

/** A verb that failed - reported in place, with the draft still intact. */
export const Failed = () => (
  <Page height={760}>
    <ImportDraftFlow
      {...shared}
      draft={controller({ step: "confirm", preview: { summary: SUMMARY, sampleRejectedRows: [] }, flowError: "The draft could not be committed — the upload has expired." })}
    />
  </Page>
);
