import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { LinkedSessionTarget } from "@cjhyy/code-shell-server/mobile-remote";
import type { TaskInboxSourcesDeps } from "../task-inbox/task-inbox-sources.js";

type BackgroundHost = NonNullable<TaskInboxSourcesDeps["background"]>;

/** A delegation can launch outside registered project roots. Its exact Host
 * job identity permits observing that transcript, never authorizing a cwd for
 * commands or takeover. Grants belong to the window that opened the room. */
export class DriveAgentTranscriptAccess {
  private readonly observations = new Map<number, Map<string, LinkedSessionTarget>>();

  constructor(private readonly list: BackgroundHost["list"]) {}

  async open<T extends { roomId: string; cwd: string }>(
    senderId: number,
    source: unknown,
    target: { externalSessionId: unknown; cwd: unknown; kind: unknown },
    open: (target: LinkedSessionTarget) => T,
  ): Promise<T> {
    const reference = source as { jobId?: unknown; sourceSessionId?: unknown } | null;
    if (
      !reference ||
      !validId(reference.jobId) ||
      !validId(reference.sourceSessionId) ||
      !validId(target.externalSessionId) ||
      (target.kind !== "claude-code" && target.kind !== "codex")
    ) {
      throw new Error("Invalid DriveAgent transcript reference");
    }
    const cwd = await canonicalDirectory(target.cwd);
    const cli = target.kind === "codex" ? "codex" : "claude";
    const job = (await this.list()).find(
      (item) =>
        item.kind === "job" &&
        item.jobKind === "drive-agent" &&
        item.jobId === reference.jobId &&
        item.sourceSession.sessionId === reference.sourceSessionId &&
        item.externalSessionId === target.externalSessionId &&
        item.cli === cli,
    );
    if (!job || job.kind !== "job" || (await canonicalDirectory(job.cwd)) !== cwd) {
      throw new Error("DriveAgent transcript does not match the requested job");
    }
    const authorized: LinkedSessionTarget = {
      externalSessionId: target.externalSessionId,
      cwd,
      kind: target.kind,
    };
    // RoomManager still validates the authoritative on-disk CLI identity. A
    // failed open must not grant subsequent subscription access.
    const result = open(authorized);
    if (resolve(result.cwd) !== cwd) throw new Error("DriveAgent transcript room cwd mismatch");
    let rooms = this.observations.get(senderId);
    if (!rooms) this.observations.set(senderId, (rooms = new Map()));
    rooms.set(result.roomId, authorized);
    return result;
  }

  async requireSubscription(
    senderId: number,
    roomId: string,
    target: { externalSessionId: unknown; cwd: unknown; kind: unknown },
  ): Promise<string> {
    const observed = this.observations.get(senderId)?.get(roomId);
    if (
      !observed ||
      observed.externalSessionId !== target.externalSessionId ||
      observed.kind !== target.kind ||
      (await canonicalDirectory(target.cwd)) !== observed.cwd
    ) {
      throw new Error("DriveAgent transcript subscription has no matching observation");
    }
    return observed.cwd;
  }

  forgetSender(senderId: number): void {
    this.observations.delete(senderId);
  }

  forgetRoom(senderId: number, roomId: string): void {
    this.observations.get(senderId)?.delete(roomId);
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
}

async function canonicalDirectory(value: unknown): Promise<string> {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.length > 32_768 ||
    value.includes("\0") ||
    !(await stat(value)).isDirectory()
  ) {
    throw new Error("DriveAgent transcript cwd must be an existing absolute directory");
  }
  return resolve(await realpath(value));
}
