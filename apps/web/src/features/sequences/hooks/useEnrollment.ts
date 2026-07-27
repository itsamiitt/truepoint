// useEnrollment.ts — view state for one sequence's enrollment panel: the log entries, the enroll action
// (branching on the RFC-9457 `code` — "suppressed" → quiet DNC notice), and the per-entry "Send next step"
// action whose failures surface verbatim (the CAN-SPAM 422). Presentation state only.
//
// The LOG is a query keyed by sequence id — which is what removes the panel-reset effect the previous version
// needed: switching sequences used to mean clearing the entries by hand so the old sequence's log would not
// show under the new one's header. A different key is a different entry, so there is nothing to clear.
//
// The notices and per-entry send failures stay useState. They are not server state — they are the outcome of
// one interaction, and they belong to this panel until the user does something else.
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { ApiError, enrollContact, fetchEnrollmentLog, sendNextStep } from "../api";
import { sequenceKeys } from "../keys";
import type { EnrollmentEntry } from "../types";

/** A failed send, keyed to its log entry: the server's message verbatim + the problem code. */
export interface SendFailure {
  message: string;
  code: string;
}

export function useEnrollment(sequenceId: string, onChanged: () => void) {
  const qc = useQueryClient();
  const key = sequenceKeys.enrollmentLog(sequenceId);
  const query = useQuery<EnrollmentEntry[]>({
    queryKey: key,
    queryFn: () => fetchEnrollmentLog(sequenceId),
  });

  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [dncNotice, setDncNotice] = useState<string | null>(null);
  const [enrolledNotice, setEnrolledNotice] = useState<string | null>(null);
  const [sendFailures, setSendFailures] = useState<Record<string, SendFailure>>({});

  // Interaction outcomes belong to the sequence they happened on — selecting another one starts clean.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on the selected sequence.
  useEffect(() => {
    setEnrollError(null);
    setDncNotice(null);
    setEnrolledNotice(null);
    setSendFailures({});
  }, [sequenceId]);

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: key });
    onChanged();
  }, [qc, key, onChanged]);

  const enrollMutation = useMutation({
    mutationFn: (contactId: string) => enrollContact(sequenceId, contactId),
  });

  const sendMutation = useMutation({ mutationFn: (logId: string) => sendNextStep(logId) });

  /** POST /sequences/:id/enroll; returns whether it succeeded so the form can clear its picker. */
  const enroll = useCallback(
    async (contactId: string): Promise<boolean> => {
      setEnrollError(null);
      setDncNotice(null);
      setEnrolledNotice(null);
      try {
        await enrollMutation.mutateAsync(contactId);
        setEnrolledNotice("Enrolled — the contact now appears in the log below.");
        refresh();
        return true;
      } catch (e) {
        // A suppressed contact is a DNC outcome, not a failure to report as an error.
        if (e instanceof ApiError && e.code === "suppressed") setDncNotice(e.message);
        else setEnrollError(e instanceof Error ? e.message : "Could not enroll contact");
        return false;
      }
    },
    [enrollMutation, refresh],
  );

  /** POST /log/:id/send; failures kept per entry so one bad row does not blank the panel. */
  const sendNext = useCallback(
    async (logId: string) => {
      setSendFailures(({ [logId]: _retried, ...rest }) => rest);
      try {
        await sendMutation.mutateAsync(logId);
        refresh();
      } catch (e) {
        const failure: SendFailure =
          e instanceof ApiError
            ? { message: e.message, code: e.code }
            : { message: e instanceof Error ? e.message : "Send failed", code: "error" };
        setSendFailures((prev) => ({ ...prev, [logId]: failure }));
      }
    },
    [sendMutation, refresh],
  );

  return {
    entries: query.data ?? [],
    loading: query.isPending,
    error: query.error
      ? query.error instanceof Error
        ? query.error.message
        : "Failed to load the enrollment log"
      : null,
    reload: () => {
      void query.refetch();
    },
    enroll,
    enrolling: enrollMutation.isPending,
    enrollError,
    dncNotice,
    enrolledNotice,
    sendNext,
    sendingId: sendMutation.isPending ? (sendMutation.variables ?? null) : null,
    sendFailures,
  };
}
