// CopyButton.tsx — a tiny copy-to-clipboard control for a revealed value (email / phone / LinkedIn). Shows a
// check for ~1.2s and toasts on success/failure. Purely presentational; the value is already in the client.
"use client";

import { TpIconButton, useToast } from "@leadwolf/ui";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${label} copied`);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error(`Could not copy ${label.toLowerCase()}`);
    }
  };

  return (
    <TpIconButton
      label={copied ? "Copied" : `Copy ${label.toLowerCase()}`}
      onClick={() => void onCopy()}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </TpIconButton>
  );
}
