import type { BackgroundWorkInfo } from "../../preload/types";
import type { ToolMessage } from "../types";
import type { OpenCliSessionEventDetail, RoomCliKind } from "./types";

type DriveAgentToolMessage = Pick<ToolMessage, "toolName" | "result">;

export function roomCliKind(cli: unknown): RoomCliKind | null {
  if (cli === "claude") return "claude-code";
  if (cli === "codex") return "codex";
  return null;
}

export function driveAgentLinkDetail(
  job: Extract<BackgroundWorkInfo, { kind: "job" }>,
): OpenCliSessionEventDetail | null {
  const cliKind = roomCliKind(job.cli);
  if (
    job.jobKind !== "drive-agent" ||
    !job.externalSessionId?.trim() ||
    !job.cwd?.trim() ||
    !job.sourceSession.sessionId?.trim() ||
    !cliKind
  ) {
    return null;
  }
  return {
    externalSessionId: job.externalSessionId,
    cliKind,
    cwd: job.cwd,
    sourceSessionId: job.sourceSession.sessionId,
  };
}

/** Extract the registry job id returned by a background DriveAgent launch.
 * Foreground completions intentionally return null because they have no job
 * row to supply the complete deep-link metadata. */
export function driveAgentJobIdFromToolMessage(message: DriveAgentToolMessage): string | null {
  const toolName = message.toolName.toLowerCase();
  if (toolName !== "driveagent" && toolName !== "driveclaudecode") return null;
  if (!message.result) return null;
  return message.result.match(/\bjobId\s+([A-Za-z0-9][A-Za-z0-9._:-]*)/)?.[1] ?? null;
}

/** Resolve a chat tool card through the renderer's background-work snapshot. */
export function driveAgentLinkDetailForToolMessage(
  message: DriveAgentToolMessage,
  jobs: readonly Extract<BackgroundWorkInfo, { kind: "job" }>[],
): OpenCliSessionEventDetail | null {
  const jobId = driveAgentJobIdFromToolMessage(message);
  if (!jobId) return null;
  const job = jobs.find((candidate) => candidate.jobId === jobId);
  return job ? driveAgentLinkDetail(job) : null;
}
