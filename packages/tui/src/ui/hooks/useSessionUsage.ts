import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AgentClient, UsageSummary } from "@cjhyy/code-shell-core";

function isOwnedSummary(value: unknown, sessionId: string): value is UsageSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const summary = value as UsageSummary;
  return (
    summary.version === 1 &&
    summary.scope === "session" &&
    summary.sessionId === sessionId &&
    summary.includesChildren === true &&
    typeof summary.partial === "boolean" &&
    Number.isFinite(summary.knownEstimatedCostUsd) &&
    summary.knownEstimatedCostUsd >= 0 &&
    Number.isSafeInteger(summary.unknownCostRequests) &&
    summary.unknownCostRequests >= 0 &&
    Number.isSafeInteger(summary.totalTokens) &&
    summary.totalTokens >= 0
  );
}

/** A response belongs to the selected Session and the latest requested snapshot. */
export function useSessionUsage(
  client: Pick<AgentClient, "query">,
  sessionId: string | undefined,
  currentSessionId: RefObject<string | undefined>,
) {
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<{ sessionId: string; summary: UsageSummary }>();
  const refresh = useCallback(
    async (target: string | undefined) => {
      const request = ++generation.current;
      if (!target) {
        setSnapshot(undefined);
        return;
      }
      try {
        const summary = (
          await client.query("usage", {
            scope: "session",
            sessionId: target,
            includeChildren: true,
          })
        ).data;
        if (!isOwnedSummary(summary, target)) throw new Error("Invalid Session usage response");
        if (request === generation.current && currentSessionId.current === target)
          setSnapshot({ sessionId: target, summary });
      } catch {
        // Older hosts and failed reads must not show another Session's bill.
        if (request === generation.current && currentSessionId.current === target)
          setSnapshot(undefined);
      }
    },
    [client, currentSessionId],
  );
  useEffect(() => {
    void refresh(sessionId);
    return () => {
      generation.current++;
    };
  }, [sessionId, refresh]);
  return {
    summary: snapshot && snapshot.sessionId === sessionId ? snapshot.summary : undefined,
    refresh,
  };
}
