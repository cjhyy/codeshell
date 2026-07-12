import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { BackgroundWorkInfo } from "../../preload/types";
import { driveAgentJobIdFromToolMessage } from "../cc-room/driveAgentLink";
import type { Message } from "../types";

export type DriveAgentJob = Extract<BackgroundWorkInfo, { kind: "job" }>;

const DriveAgentJobsContext = createContext<readonly DriveAgentJob[]>([]);
const INITIAL_RETRY_DELAYS_MS = [100, 500] as const;

export function DriveAgentJobsProvider({
  jobs,
  children,
}: {
  jobs: readonly DriveAgentJob[];
  children: React.ReactNode;
}) {
  return <DriveAgentJobsContext.Provider value={jobs}>{children}</DriveAgentJobsContext.Provider>;
}

/** Load only the background jobs referenced by DriveAgent cards in this
 * transcript. One loader per message stream avoids per-card IPC and polling. */
export function DriveAgentJobsLoader({
  sessionId,
  messages,
  children,
}: {
  sessionId?: string | null;
  messages: readonly Message[];
  children: React.ReactNode;
}) {
  const jobIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) {
      if (message.kind !== "tool") continue;
      const jobId = driveAgentJobIdFromToolMessage(message);
      if (jobId) ids.add(jobId);
    }
    return [...ids];
  }, [messages]);
  const jobKey = jobIds.join("\n");
  const [jobs, setJobs] = useState<DriveAgentJob[]>([]);
  const requestSeqRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);

  const refresh = useCallback(
    async (retryAttempt = 0) => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      const requestSeq = ++requestSeqRef.current;
      if (!sessionId || !jobKey) {
        setJobs([]);
        return;
      }
      try {
        const result = await window.codeshell.listBackgroundWork(sessionId, { scope: "all" });
        if (requestSeq !== requestSeqRef.current) return;
        const wanted = new Set(jobKey.split("\n"));
        setJobs(
          (result?.items ?? []).filter(
            (item: BackgroundWorkInfo): item is DriveAgentJob =>
              item.kind === "job" &&
              item.sourceSession.sessionId === sessionId &&
              wanted.has(item.jobId),
          ),
        );
      } catch {
        if (requestSeq !== requestSeqRef.current) return;
        setJobs([]);
        const delay = INITIAL_RETRY_DELAYS_MS[retryAttempt];
        if (delay !== undefined) {
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = null;
            if (requestSeq === requestSeqRef.current) void refresh(retryAttempt + 1);
          }, delay);
        }
      }
    },
    [jobKey, sessionId],
  );

  useEffect(() => {
    requestSeqRef.current += 1;
    setJobs([]);
    void refresh();
    return () => {
      requestSeqRef.current += 1;
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [refresh]);

  useEffect(() => {
    if (!jobKey) return;
    const onChanged = (): void => void refresh();
    window.addEventListener("codeshell:files-changed", onChanged);
    return () => window.removeEventListener("codeshell:files-changed", onChanged);
  }, [jobKey, refresh]);

  const hasRunningJob = jobs.some((job) => job.status === "running");
  useEffect(() => {
    if (!hasRunningJob) return;
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [hasRunningJob, refresh]);

  return <DriveAgentJobsProvider jobs={jobs}>{children}</DriveAgentJobsProvider>;
}

export function useDriveAgentJobs(): readonly DriveAgentJob[] {
  return useContext(DriveAgentJobsContext);
}
