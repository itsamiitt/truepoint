// stubs/next-script.tsx — next/script, replaced by an inert element.
//
// TurnstileWidget loads the Cloudflare Turnstile challenge through next/script. A preview card has no Next
// runtime to honour the loading strategy, and a design card must not reach out to a third-party challenge
// host — so the script simply never loads. The widget's own container div still renders, which is the part
// that matters for layout: the card shows the space the challenge occupies on the form.

import type { ReactNode } from "react";

export default function Script(_props: {
  src?: string;
  id?: string;
  strategy?: string;
  async?: boolean;
  defer?: boolean;
  onLoad?: () => void;
  onReady?: () => void;
  children?: ReactNode;
}) {
  return null;
}
