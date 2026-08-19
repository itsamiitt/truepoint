// CaptureForm - paste a Sales Navigator URL to capture it into the workspace.
//
// The capture is user-initiated by design: the extension and this form are the only two ways a link enters
// the workspace, and neither runs in the background.
import { CaptureForm } from "@leadwolf/ui";
import { Frame } from "./_webPage";

/** The form at rest, waiting for a URL. */
export const Resting = () => (
  <Frame>
    <CaptureForm onCapture={async () => ({ deduped: false })} />
  </Frame>
);
