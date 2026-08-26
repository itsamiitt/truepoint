// SearchBox.tsx — ONE search box with two modes (decisions.md 2026-08-25): keywords (the debounced free text
// the page commits to the query) and "Describe" (plain English → the backend compiles a VALIDATED
// contactQuery → a preview Dialog → apply on confirm; 23 §3, ADR-0023, M14). The two used to be two boxes
// side by side, competing with the scope control for the same row; a new user could not tell which to type
// into. The AI never runs the search and never returns results — human-in-the-loop (23 §1).
"use client";

import type { AiSearchResponse, ContactQuery } from "@leadwolf/types";
import { Dialog, LoadingState, TpButton, TpInput, useToast } from "@leadwolf/ui";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import styles from "../prospect.module.css";
import { aiSearch } from "../searchApi";
import { ParsedFilterPreview } from "./ParsedFilterPreview";

export function SearchBox({
  value,
  onChange,
  onApplyQuery,
}: {
  /** The keyword text (the page debounces and commits it). */
  value: string;
  onChange: (text: string) => void;
  /** Apply a compiled query wholesale (the Describe mode's confirmed result). */
  onApplyQuery: (query: ContactQuery) => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<"keywords" | "describe">("keywords");
  const [describe, setDescribe] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<AiSearchResponse | null>(null);
  const canCompile = describe.trim().length > 0 && !loading;

  async function compile() {
    if (!canCompile) return;
    setLoading(true);
    try {
      setPreview(await aiSearch(describe.trim()));
    } catch (e) {
      // The backend returns a safe Problem Details message (never the model/prompt). Surface it as a toast.
      toast.error(
        "Couldn't build that search",
        e instanceof Error ? e.message : "Try rephrasing your description.",
      );
    } finally {
      setLoading(false);
    }
  }

  function apply() {
    if (!preview) return;
    onApplyQuery(preview.query);
    setPreview(null);
    setDescribe("");
    setMode("keywords");
  }

  return (
    <div className={styles.searchBox}>
      <div className={styles.searchBoxRow}>
        {mode === "keywords" ? (
          <TpInput
            type="search"
            placeholder="Search name, title, company, email, LinkedIn…"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-label="Search people"
          />
        ) : (
          <TpInput
            value={describe}
            placeholder="Describe who you're looking for, e.g. VPs of engineering at fintechs in Bengaluru"
            aria-label="Describe who you're looking for"
            disabled={loading}
            autoFocus
            onChange={(e) => setDescribe(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void compile();
              }
            }}
          />
        )}
        <TpButton
          variant={mode === "describe" ? "primary" : "ghost"}
          size="sm"
          aria-pressed={mode === "describe"}
          leftIcon={<Sparkles size={14} aria-hidden />}
          onClick={() => setMode((m) => (m === "describe" ? "keywords" : "describe"))}
        >
          Describe
        </TpButton>
        {mode === "describe" ? (
          <TpButton
            variant="secondary"
            size="sm"
            disabled={!canCompile}
            onClick={() => void compile()}
          >
            Build filters
          </TpButton>
        ) : null}
      </div>
      {loading ? <LoadingState label="Understanding your search…" /> : null}

      <Dialog
        open={preview !== null}
        onClose={() => setPreview(null)}
        title="Review the filters"
        description="Your description became the filters below. Review them, then apply."
        maxWidth={520}
        footer={
          <>
            <TpButton variant="ghost" size="sm" onClick={() => setPreview(null)}>
              Cancel
            </TpButton>
            <TpButton variant="primary" size="sm" onClick={apply}>
              Apply filters
            </TpButton>
          </>
        }
      >
        {preview ? <ParsedFilterPreview result={preview} /> : null}
      </Dialog>
    </div>
  );
}
