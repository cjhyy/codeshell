import type { BackgroundWorkInfo } from "../../preload/types";
import type { OpenCliSessionEventDetail, RoomCliKind } from "./types";

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
