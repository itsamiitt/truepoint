// useEnrollment.ts — view state for one sequence's enrollment panel: the log entries, the enroll action
// (branching on the RFC-9457 `code` — "suppressed" → quiet DNC notice), and the per-entry "Send next step"
// action whose failures surface verbatim (the CAN-SPAM 422). Presentation state only.
"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, enrollContact, fetchEnrollmentLog, sendNextStep } from "../api";
import type { EnrollmentEntry } from "../types";

/** A failed send, keyed to its log entry: the server's message verbatim + the problem code. */
export interface SendFailure {
  message: string;
  code: string;
}

export function useEnrollment(sequenceId: string, onChanged: () => void) {
  const [entries, setEntries] = useState<EnrollmentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [dncNotice, setDncNotice] = useState<string | null>(null);
  const [enrolledNotice, setEnrolledNotice] = useState<string | null>(null);

  const [sendingId, setSendingId] = useState<string | null>(null);
  const [sendFailures, setSendFailures] = useState<Record<string, SendFailure>>({});

  const reload = useCallback(async () => {
    setError(null);
    try {
      setEntries(await fetchEnrollmentLog(sequenceId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load the enrollment log");
    } finally {
      setLoading(false);
    }
  }, [sequenceId]);

  // Fresh panel per selected sequence: clear panel-local state, then load that sequence's log.
  useEffect(() => {
    setEntries([]);
    setLoading(true);
    setEnrollError(null);
    setDncNotice(null);
    setEnrolledNotice(null);
    setSendFailures({});
    void reload();
  }, [reload]);

  /** POST /sequences/:id/enroll; returns whether it succeeded so the form can clear its picker. */
  const enroll = useCallback(
    async (contactId: string): Promise<boolean> => {
      setEnrolling(true);
      setEnrollError(null);
      setDncNotice(null);
      setEnrolledNotice(null);
      try {
        await enrollContact(sequenceId, contactId);
        setEnrolledNotice("Enrolled — the contact now appears in the log below.");
        await reload();
        onChanged();
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.code === "suppressed") {
          setDncNotice(e.message);
        } else {
          setEnrollError(e instanceof Error ? e.message : "Could not enroll contact");
        }
        return false;
      } finally {
        setEnrolling(false);
      }
    },
    [sequenceId, reload, onChanged],
  );

  /** POST /log/:id/send; one in-flight send at a time, failures kept per entry. */
  const sendNext = useCallback(
    async (logId: string) => {
      setSendingId(logId);
      setSendFailures(({ [logId]: _retried, ...rest }) => rest);
      try {
        await sendNextStep(logId);
        await reload();
        onChanged();
      } catch (e) {
        const failure: SendFailure =
          e instanceof ApiError
            ? { message: e.message, code: e.code }
            : { message: e instanceof Error ? e.message : "Send failed", code: "error" };
        setSendFailures((prev) => ({ ...prev, [logId]: failure }));
      } finally {
        setSendingId(null);
      }
    },
    [reload, onChanged],
  );

  return {
    entries,
    loading,
    error,
    reload,
    enroll,
    enrolling,
    enrollError,
    dncNotice,
    enrolledNotice,
    sendNext,
    sendingId,
    sendFailures,
  };
}
