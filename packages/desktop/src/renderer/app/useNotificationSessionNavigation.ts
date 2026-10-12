import { useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { DiskSessionMeta } from "../automation/rebuildFromDisk";
import { loadProjects } from "../projects";
import { getSessionPersistenceIndices } from "../sessionPersistence";
import { loadSessionIndex, NO_REPO_KEY, type SessionIndex } from "../transcripts";
import type { DiskSessionOpenGuard } from "./useSessionNavigation";
import {
  findNotificationSession,
  OPEN_NOTIFICATION_SESSION_EVENT,
  resolveNotificationSession,
} from "./notificationSessionNavigation";

interface Params {
  sessionIndicesRef: MutableRefObject<Record<string, SessionIndex>>;
  selectSession: (projectId: string | null, sessionId: string) => void;
  openDiskSession: (session: DiskSessionMeta, guard?: DiskSessionOpenGuard) => Promise<void>;
  unavailable: (sessionId: string) => void;
}

/** Native notifications and history actions share the normal session navigation. */
export function useNotificationSessionNavigation(params: Params): void {
  const latest = useRef(params);
  latest.current = params;
  useEffect(() => {
    let generation = 0;
    const persistedIndices = (): Record<string, SessionIndex> => {
      const keys = new Set([
        ...Object.keys(latest.current.sessionIndicesRef.current),
        ...Object.keys(getSessionPersistenceIndices()),
        ...loadProjects().map((project) => project.id),
        NO_REPO_KEY,
      ]);
      return Object.fromEntries(
        [...keys].map((key) => [key, loadSessionIndex(key === NO_REPO_KEY ? null : key)]),
      );
    };
    const open = (sessionId: string) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) return;
      const request = ++generation;
      const isCurrent = () => request === generation;
      const resolve = () =>
        resolveNotificationSession(sessionId, {
          currentIndices: () => latest.current.sessionIndicesRef.current,
          persistedIndices,
          listDiskSessions: window.codeshell.listDiskSessions,
        });
      void (async () => {
        try {
          const target = await resolve();
          if (!isCurrent()) return;
          if (!target) {
            latest.current.unavailable(sessionId);
          } else if (target.kind === "indexed") {
            latest.current.selectSession(target.target.projectId, target.target.session.id);
          } else {
            await latest.current.openDiskSession(target.session, {
              isCurrent,
              validate: async () => {
                if (!isCurrent()) return false;
                const currentTarget = await resolve();
                return isCurrent() && currentTarget !== null;
              },
            });
            if (!isCurrent()) return;
            if (!findNotificationSession(persistedIndices(), sessionId)) {
              latest.current.unavailable(sessionId);
            }
          }
        } catch {
          if (isCurrent()) latest.current.unavailable(sessionId);
        }
      })();
    };
    const onOpen = (event: Event) => open((event as CustomEvent).detail?.sessionId);
    window.addEventListener(OPEN_NOTIFICATION_SESSION_EVENT, onOpen);
    const unsubscribe = window.codeshell.onNotificationOpenSession?.(open);
    return () => {
      generation += 1;
      unsubscribe?.();
      window.removeEventListener(OPEN_NOTIFICATION_SESSION_EVENT, onOpen);
    };
  }, []);
}
