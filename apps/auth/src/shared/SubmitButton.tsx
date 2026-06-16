// SubmitButton.tsx — a progressive-enhancement submit button for the auth forms (bug 4). With JS it reflects
// the server action's pending state via useFormStatus — a spinner + disabled + aria-busy so the redirect
// round-trip is visible instead of feeling frozen (04 §8 "latency honesty"). With JS off it degrades to a
// plain native <button type="submit">, so every form still works without client code. Wraps @leadwolf/ui Button.
"use client";

import { Button, Spinner } from "@leadwolf/ui";
import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

export function SubmitButton({ children }: { children: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="full" disabled={pending} aria-busy={pending}>
      {pending ? <Spinner size={16} /> : null}
      {children}
    </Button>
  );
}
