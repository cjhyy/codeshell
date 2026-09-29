import { useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import {
  getProjectSnapshot,
  saveProjects,
  subscribeProjects,
  type TrackedProject,
} from "../projects";

const setProjects: Dispatch<SetStateAction<TrackedProject[]>> = (update) => {
  const current = getProjectSnapshot();
  const next = typeof update === "function" ? update(current) : update;
  if (next !== current) saveProjects(next);
};

/** UI and configuration lookup consume the same Main-backed projection.
 * An effect copying React state would leave child renders one snapshot behind.
 */
export function useTrackedProjects(): [TrackedProject[], typeof setProjects] {
  const projects = useSyncExternalStore(subscribeProjects, getProjectSnapshot, getProjectSnapshot);
  return [projects, setProjects];
}
