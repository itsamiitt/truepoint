// (shell)/loading.tsx — the route-level loading UI for every signed-in destination.
//
// Next renders the NEAREST loading.tsx while a route segment's code and data resolve, so one file at the group
// level covers home, prospect, lists, sequences, reports, settings and the rest. Without it a route transition
// showed nothing at all until the destination chunk finished loading — the app looked frozen rather than busy,
// which reads as a failure on a slow connection. A route that wants a tailored skeleton can still add its own
// loading.tsx; the nearest one wins.
//
// Deliberately minimal: the AppShell chrome (rail + top bar) is already painted by the group layout, so this
// only fills the content area. Spinner is the design system's loading primitive — token-driven, and it renders
// an <output> with an accessible label, so assistive tech announces the pending state.
import { Spinner } from "@leadwolf/ui";

export default function ShellLoading() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // Tall enough to sit where content will appear rather than clinging to the top of the viewport.
        minHeight: "60vh",
        width: "100%",
      }}
    >
      <Spinner size={22} label="Loading page" />
    </div>
  );
}
