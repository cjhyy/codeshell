import React from "react";
import type { PetChatEvent } from "../../preload/pet-api";
import type { TrackedProject } from "../projects";

/** Strip trailing path separators so `/work/x` and `/work/x/` compare equal. */
function normalizeWorkspacePath(path: string): string {
  return path.replace(/[/\\]+$/, "");
}

/** Bind the LLM-selected, host-validated Workspace path to the renderer's stable project id. */
export function projectIdForPetWorkspacePath(
  projects: readonly TrackedProject[],
  workspacePath: string | null,
): string | null | undefined {
  if (workspacePath === null) return null;
  // The host validates workspacePath against the same on-disk project list the
  // renderer tracks, so an exact match is the norm. Normalize trailing
  // separators to tolerate a benign formatting difference between the two data
  // sources rather than silently dropping a confirmed delegation.
  const target = normalizeWorkspacePath(workspacePath);
  return projects.find((project) => normalizeWorkspacePath(project.path) === target)?.id;
}

export function PetAutoDelegationHost({
  projects,
  onDelegate,
  onUnresolved,
}: {
  projects: readonly TrackedProject[];
  onDelegate: (projectId: string | null, task: string, clientMessageId: string) => void;
  /** Called when a host-confirmed delegation cannot be routed to a tracked project. */
  onUnresolved?: (workspacePath: string | null) => void;
}) {
  const latestRef = React.useRef({ projects, onDelegate, onUnresolved });
  const handledRef = React.useRef(new Set<string>());
  latestRef.current = { projects, onDelegate, onUnresolved };

  React.useEffect(() => {
    const pet = window.codeshell.pet;
    if (!pet?.onChatEvent) return;
    return pet.onChatEvent((event: PetChatEvent) => {
      if (event.kind !== "delegation-requested") return;
      if (handledRef.current.has(event.clientMessageId)) return;
      handledRef.current.add(event.clientMessageId);
      if (handledRef.current.size > 200) {
        const oldest = handledRef.current.values().next().value;
        if (oldest) handledRef.current.delete(oldest);
      }
      const latest = latestRef.current;
      const projectId = projectIdForPetWorkspacePath(latest.projects, event.workspacePath);
      if (projectId === undefined) {
        // Mimi told the user the work was dispatched (the tool call succeeded
        // main-side), but the renderer no longer tracks the selected Workspace.
        // Surface this instead of silently dropping it so the user is not left
        // believing a session started when none did.
        window.codeshell.log("pet.delegation.workspace_missing", {
          workspacePath: event.workspacePath,
          clientMessageId: event.clientMessageId,
        });
        latest.onUnresolved?.(event.workspacePath);
        return;
      }
      latest.onDelegate(projectId, event.task, event.clientMessageId);
    });
  }, []);

  return null;
}
