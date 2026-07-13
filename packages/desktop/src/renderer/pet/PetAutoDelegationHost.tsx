import React from "react";
import type { PetChatEvent } from "../../preload/pet-api";
import type { TrackedProject } from "../projects";

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function projectMatchScore(project: TrackedProject, task: string): number {
  const haystack = normalized(task);
  const labels = [project.displayName, project.name]
    .filter((value): value is string => typeof value === "string")
    .map(normalized)
    .filter((value) => value.length >= 2);
  return labels.reduce(
    (score, label) => (haystack.includes(label) ? Math.max(score, label.length) : score),
    0,
  );
}

/** Prefer an explicitly named project, then the originating/active project. */
export function resolvePetDelegationProjectId(
  projects: readonly TrackedProject[],
  task: string,
  preferredProjectId: string | undefined,
  activeProjectId: string | null,
): string | null {
  const scored = projects
    .map((project) => ({ project, score: projectMatchScore(project, task) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored[0] && (!scored[1] || scored[0].score > scored[1].score)) {
    return scored[0].project.id;
  }
  if (preferredProjectId && projects.some((project) => project.id === preferredProjectId)) {
    return preferredProjectId;
  }
  if (activeProjectId && projects.some((project) => project.id === activeProjectId)) {
    return activeProjectId;
  }
  return projects.length === 1 ? projects[0]!.id : null;
}

export function PetAutoDelegationHost({
  projects,
  activeProjectId,
  onDelegate,
}: {
  projects: readonly TrackedProject[];
  activeProjectId: string | null;
  onDelegate: (projectId: string | null, task: string) => void;
}) {
  const latestRef = React.useRef({ projects, activeProjectId, onDelegate });
  const handledRef = React.useRef(new Set<string>());
  latestRef.current = { projects, activeProjectId, onDelegate };

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
      const projectId = resolvePetDelegationProjectId(
        latest.projects,
        event.task,
        event.preferredProjectId,
        latest.activeProjectId,
      );
      latest.onDelegate(projectId, event.task);
    });
  }, []);

  return null;
}
