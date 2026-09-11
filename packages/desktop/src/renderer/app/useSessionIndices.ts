import { useEffect, useMemo, useState } from "react";
import { loadProjects } from "../projects";
import { getSessionPersistenceIndices, subscribeSessionPersistence } from "../sessionPersistence";
import {
  loadDeletedArchivedIndices,
  loadSessionIndex,
  NO_REPO_KEY,
  type SessionIndex,
} from "../transcripts";

/** Seed every visible project and follow Main's durable cross-window catalogue. */
export function useSessionIndices() {
  const [sessionIndices, setSessionIndices] = useState<Record<string, SessionIndex>>(() => {
    const out: Record<string, SessionIndex> = {};
    const liveProjects = loadProjects();
    for (const project of liveProjects) out[project.id] = loadSessionIndex(project.id);
    out[NO_REPO_KEY] = loadSessionIndex(null);
    // Removed projects still own archived conversations that Settings exposes.
    Object.assign(
      out,
      loadDeletedArchivedIndices(new Set(liveProjects.map((project) => project.id))),
    );
    return out;
  });
  useEffect(() => {
    const update = () => {
      const indices = getSessionPersistenceIndices();
      if (Object.keys(indices).length) {
        setSessionIndices((previous) => ({ ...previous, ...indices }));
      }
    };
    const unsubscribe = subscribeSessionPersistence(update);
    update();
    return unsubscribe;
  }, []);
  const archivedPetSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const index of Object.values(sessionIndices)) {
      for (const session of index.sessions) {
        if (session.archived) ids.add(session.engineSessionId ?? session.id);
      }
    }
    return ids;
  }, [sessionIndices]);
  return { sessionIndices, setSessionIndices, archivedPetSessionIds };
}
