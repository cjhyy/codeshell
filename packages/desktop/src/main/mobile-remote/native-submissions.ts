import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { sessionsRoot } from "@cjhyy/code-shell-core";
import type {
  DispatchMobileChatTurnResult,
  MobileClientEvent,
  PermissionMode,
} from "@cjhyy/code-shell-server/mobile-remote";
import type { MobileExternalRuntimeCommands } from "./external-runtime-commands.js";
import { assertDesktopSessionId } from "../session-validation.js";

type Send = Extract<MobileClientEvent, { type: "chat.send" }>;
type Authority = Awaited<ReturnType<MobileExternalRuntimeCommands["authorizeNative"]>>;
type Entry = { fingerprint: string; stamp: string; result?: DispatchMobileChatTurnResult };

/** Read only. A durable ID without this Host's exact intent cannot authorize a new submission. */
export function hasPersistedMobileInput(sessionId: string, clientMessageId: string): boolean {
  assertDesktopSessionId(sessionId);
  const path = join(sessionsRoot(), sessionId, "transcript.jsonl");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128 * 1024 * 1024)
      throw new Error("无法核对已接受的输入，请先重新载入会话。");
    let found = false;
    const consume = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || typeof event.type !== "string" || !event.data)
        throw new Error("无法核对已接受的输入，请先重新载入会话。");
      if (
        event.type === "message" &&
        event.data.role === "user" &&
        event.data.clientMessageId === clientMessageId
      )
        found = true;
    };
    const chunk = Buffer.alloc(64 * 1024),
      decoder = new StringDecoder("utf8");
    let pending = "",
      offset = 0;
    while (offset < stat.size) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
      if (!count) throw new Error("incomplete transcript");
      offset += count;
      pending += decoder.write(chunk.subarray(0, count));
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (pending.length > 16 * 1024 * 1024) throw new Error("oversized transcript record");
    }
    consume(pending + decoder.end());
    for (const after of [fstatSync(fd), lstatSync(path)])
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.nlink !== 1 ||
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw new Error("transcript changed");
    return found;
  } catch {
    throw new Error("无法核对已接受的输入，请先重新载入会话。");
  } finally {
    closeSync(fd);
  }
}

/** Host-lifetime exact-intent receipts. Core's durable ID remains the restart boundary. */
export class MobileNativeSubmissions {
  private readonly entries = new Map<string, Entry>();
  private readonly admitting = new Map<string, { key: string; id: string; entry: Entry }>();
  constructor(
    private readonly commands: Pick<MobileExternalRuntimeCommands, "authorizeNative">,
    private readonly persisted: typeof hasPersistedMobileInput = hasPersistedMobileInput,
  ) {}
  has(sessionId: string, inputId?: string) {
    return !!inputId?.trim() && this.entries.has(JSON.stringify([sessionId, inputId.trim()]));
  }

  async begin(
    viewer: string | undefined,
    device: string | undefined,
    sessionId: string,
    event: Send,
    permission: PermissionMode,
  ) {
    const authority = await this.commands.authorizeNative(viewer, device, sessionId);
    const id = event.clientMessageId?.trim();
    if (!id) throw new Error("请选择会话并使用新的输入标识重新发送。");
    const key = JSON.stringify([sessionId, id]);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          event.text.trim(),
          event.attachments ?? [],
          event.modelKey ?? null,
          event.nativeConnectionId ?? null,
          event.modelTraceSource ?? null,
          permission,
        ]),
      )
      .digest("hex");
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error("同一输入的内容或模型选择已改变，请核对草稿后作为新消息发送。");
      if (existing.stamp !== authority.stamp)
        throw new Error("该输入已提交，请重新载入会话核对结果，不要重复发送。");
      authority.assertCurrent();
      return {
        authority,
        cached: existing.result ?? {
          ok: false as const,
          uncertain: true as const,
          clientMessageId: id,
          message: "该输入正在确认中，请重新载入会话核对结果。",
        },
      };
    }
    if (!authority.fresh && this.persisted(sessionId, id))
      throw new Error(
        "该输入已被接受，请重新载入会话核对结果；原模型选择无法重新确认，不会重复发送。",
      );
    authority.assertCurrent();
    if (this.entries.size >= 1024) {
      const completed = [...this.entries].find(([, item]) => item.result?.ok);
      if (completed) this.entries.delete(completed[0]);
      else throw new Error("仍有过多输入等待确认，请先重新载入会话核对结果。");
    }
    const active = this.admitting.get(sessionId);
    if (active) {
      if (
        active.entry.result &&
        !active.entry.result.ok &&
        active.entry.result.uncertain &&
        !authority.fresh &&
        this.persisted(sessionId, active.id)
      )
        this.admitting.delete(sessionId);
      else throw new Error("会话正在确认另一条模型输入，请先重新载入会话核对结果。");
    }
    authority.assertCurrent();
    const entry: Entry = { fingerprint, stamp: authority.stamp };
    this.admitting.set(sessionId, { key, id, entry });
    const release = () => {
      if (this.admitting.get(sessionId)?.entry === entry) this.admitting.delete(sessionId);
    };
    this.entries.set(key, entry); // No await between lookup and reservation.
    return {
      authority,
      settle: (result: DispatchMobileChatTurnResult, acceptedStamp?: string) => {
        if (result.ok || !result.uncertain) release();
        if (!result.ok && !result.uncertain) this.entries.delete(key);
        else {
          entry.result = result;
          entry.stamp = acceptedStamp ?? entry.stamp;
        }
      },
      reject: () => {
        release();
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    };
  }
}

export type MobileNativeSubmissionAuthority = Authority;
