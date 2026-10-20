import { useEffect, useState } from "react";

/** Display names are optional metadata; missing/deleted conversations keep their traces. */
export function useModelTraceSessionTitles(revision: number): Record<string, string> {
  const [titles, setTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    void Promise.allSettled([
      Promise.resolve().then(() => window.codeshell.listSessions?.() ?? []),
      Promise.resolve().then(() => window.codeshell.listSessionTitles?.() ?? {}),
    ]).then(([sessions, named]) => {
      if (!alive) return;
      setTitles((previous) => ({
        ...previous,
        ...(sessions.status === "fulfilled"
          ? Object.fromEntries(sessions.value.map((session) => [session.id, session.title ?? ""]))
          : {}),
        ...(named.status === "fulfilled" ? named.value : {}),
      }));
    });
    return () => {
      alive = false;
    };
  }, [revision]);
  return titles;
}
