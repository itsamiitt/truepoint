// AiSearchBox.tsx — the natural-language search box for the prospect rail (23 §3, ADR-0023, M14). The user
// types a plain-English query ("VPs of Eng at EU fintechs"); on submit the backend compiles it into a
// VALIDATED structured filter (a contactQuery) and returns it for confirmation. We PREVIEW the parsed filter
// in a Dialog so the user sees exactly what will run, and only on confirm do we apply it via the provided
// onApply callback (which wires into useContactSearch setText/setFilters). The AI never runs the search and
// never returns results — human-in-the-loop (23 §1). Token-styled via @leadwolf/ui; light theme only.
"use client";

import type { AiSearchResponse, ContactQuery } from "@leadwolf/types";
import { Dialog, LoadingState, TpButton, TpInput, useToast } from "@leadwolf/ui";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { aiSearch } from "../searchApi";
import { ParsedFilterPreview } from "./ParsedFilterPreview";

export function AiSearchBox({ onApply }: { onApply: (query: ContactQuery) => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<AiSearchResponse | null>(null);

  const canSubmit = text.trim().length > 0 && !loading;

  async function compile() {
    if (!canSubmit) return;
    setLoading(true);
    try {
      const result = await aiSearch(text.trim());
      setPreview(result);
    } catch (e) {
      // The backend returns a safe Problem Details message (never the model/prompt). Surface it as a toast.
      toast.error(
        "Couldn't build that search",
        e instanceof Error ? e.message : "Try rephrasing your query.",
      );
    } finally {
      setLoading(false);
    }
  }

  function apply() {
    if (!preview) return;
    onApply(preview.query);
    setPreview(null);
    setText("");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--tp-space-2)" }}>
      <div style={{ display: "flex", gap: 6 }}>
        <TpInput
          value={text}
          placeholder="Describe who you're looking for…"
          aria-label="Search in plain English"
          disabled={loading}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void compile();
            }
          }}
        />
        <TpButton
          variant="secondary"
          size="sm"
          disabled={!canSubmit}
          onClick={() => void compile()}
        >
          <Sparkles size={14} aria-hidden /> Ask
        </TpButton>
      </div>
      {loading ? <LoadingState label="Understanding your search…" /> : null}

      <Dialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        title="Review the parsed search"
        description="The AI turned your text into the filter below. Review it, then apply it to your prospect list."
        maxWidth={520}
        footer={
          <>
            <TpButton variant="ghost" size="sm" onClick={() => setPreview(null)}>
              Cancel
            </TpButton>
            <TpButton variant="primary" size="sm" onClick={apply}>
              Apply filter
            </TpButton>
          </>
        }
      >
        {preview ? <ParsedFilterPreview result={preview} /> : null}
      </Dialog>
    </div>
  );
}
