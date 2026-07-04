// (shell)/imports/page.tsx — thin route for the Imports section landing (import-redesign 11 §1.1, S-U1
// scaffold). All rendering lives in the feature slice; the history dashboard (11 §2, S-U2) replaces the
// slice's landing component without touching this file.
import { ImportsLanding } from "@/features/import";

export default function Page() {
  return <ImportsLanding />;
}
