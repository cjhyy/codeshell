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
import { driveAgentJobIdFromToolMessage, driveAgentLinkDetail } from "../cc-room/driveAgentLink";
import type { Message } from "../types";

export type DriveAgentJob = Extract<BackgroundWorkInfo, { kind: "job" }>;

const DriveAgentJobsContext = createContext<readonly DriveAgentJob[]>([]);
const INITIAL_RETRY_DELAYS_MS = [100, 500, 1_500] as const;

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
  autoOpen = false,
  children,
}: {
  sessionId?: string | null;
  messages: readonly Message[];
  /** Only the active live chat may automatically surface a newly launched job. */
  autoOpen?: boolean;
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
  const navigationRef = useRef<{
    sessionId: typeof sessionId;
    seen: Set<string>;
    liveTools: Set<string>;
    pendingJobs: Set<string>;
    opened: boolean;
    mountedAt: number;
    liveTurn: boolean;
  } | null>(null);

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
      const retry = () => {
        const delay = INITIAL_RETRY_DELAYS_MS[retryAttempt];
        if (delay === undefined) return;
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          if (requestSeq === requestSeqRef.current) void refresh(retryAttempt + 1);
        }, delay);
      };
      try {
        const result = await window.codeshell.listBackgroundWork(sessionId, { scope: "all" });
        if (requestSeq !== requestSeqRef.current) return;
        const wanted = new Set(jobKey.split("\n"));
        const matching = (result?.items ?? []).filter(
          (item: BackgroundWorkInfo): item is DriveAgentJob =>
            item.kind === "job" &&
            item.sourceSession.sessionId === sessionId &&
            wanted.has(item.jobId),
        );
        setJobs(matching);
        // Registration and the first UI read can race even when IPC succeeds.
        // Retry missing rows briefly; a missing registry never polls forever.
        if (matching.length < wanted.size) retry();
      } catch {
        if (requestSeq !== requestSeqRef.current) return;
        setJobs([]);
        retry();
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

  const hasRunningJob = jobs.some((job) => job.status === "running" || job.status === "cancelling");

  useEffect(() => {
    const navigation = navigationRef.current;
    if (!navigation || navigation.sessionId !== sessionId) {
      // Everything present when a transcript mounts/switches is history. Even
      // a replayed stale "running" tool must not reopen the user's dock.
      navigationRef.current = {
        sessionId,
        seen: new Set(messages.map((message) => message.id)),
        liveTools: new Set(),
        pendingJobs: new Set(),
        opened: false,
        mountedAt: Date.now(),
        liveTurn: autoOpen,
      };
      return;
    }
    // Once a live launch is observed, finishing the parent turn must not lose
    // its pending result or registry lookup. Reset only between idle batches,
    // before consuming candidates so one completed job cannot reopen the dock
    // for each concurrent result in the same effect.
    if (
      (!autoOpen || !navigation.liveTurn) &&
      !hasRunningJob &&
      navigation.pendingJobs.size === 0 &&
      navigation.liveTools.size === 0
    ) {
      navigation.opened = false;
    }
    navigation.liveTurn = autoOpen;
    for (const message of messages) {
      if (!navigation.seen.has(message.id)) {
        navigation.seen.add(message.id);
        if (
          autoOpen &&
          message.kind === "tool" &&
          // The persisted tool timestamp also excludes history arriving after
          // the initial empty render. Accept a fast tool whose start/result
          // were batched into one React render, provided it began in this view.
          message.startedAt >= navigation.mountedAt &&
          (message.status === "running" || message.status === "succeeded") &&
          /^(driveagent|driveclaudecode)$/i.test(message.toolName)
        ) {
          navigation.liveTools.add(message.id);
        }
      }
      if (message.kind !== "tool" || !navigation.liveTools.has(message.id)) continue;
      const jobId = driveAgentJobIdFromToolMessage(message);
      if (jobId) {
        navigation.liveTools.delete(message.id);
        navigation.pendingJobs.add(jobId);
      } else if (message.status !== "running") {
        // Inline completions and failed launches have no background page.
        navigation.liveTools.delete(message.id);
      }
    }
    for (const jobId of navigation.pendingJobs) {
      const job = jobs.find((candidate) => candidate.jobId === jobId);
      if (!job) continue;
      const detail = driveAgentLinkDetail(job);
      if (!detail) continue;
      navigation.pendingJobs.delete(job.jobId);
      if (navigation.opened) continue;
      navigation.opened = true;
      window.dispatchEvent(
        new CustomEvent("codeshell:open-cli-session", {
          detail: { ...detail, autoOpen: true },
        }),
      );
    }
  }, [autoOpen, hasRunningJob, jobs, messages, sessionId]);

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
