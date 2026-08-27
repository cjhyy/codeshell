import type { RendererConfigurationTarget } from "../preload/types";
import { projectIdForPath } from "./projects";

export function optionalProjectConfigurationTarget(
  projectPath: string | null | undefined,
): RendererConfigurationTarget | null {
  if (!projectPath) return null;
  const projectId = projectIdForPath(projectPath);
  if (!projectId) throw new Error("project configuration requires a live V2 project id");
  return { projectId };
}

export function requireProjectConfigurationTarget(
  projectPath: string,
): RendererConfigurationTarget {
  const target = optionalProjectConfigurationTarget(projectPath);
  if (!target) throw new Error("project configuration requires a live V2 project id");
  return target;
}

export function conversationConfigurationTarget(
  sessionId: string | null | undefined,
  projectId: string | null | undefined,
): RendererConfigurationTarget {
  if (sessionId) return { sessionId };
  if (projectId) return { projectId };
  return { noRepo: true };
}
