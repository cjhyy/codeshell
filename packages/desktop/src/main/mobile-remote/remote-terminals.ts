/**
 * Remote viewers of Desktop terminals. A phone or browser tab attaches to the
 * SAME pty a Desktop window shows (or starts one of its own), so both screens
 * show one shell. Everything here is gated by the Desktop owner's "remote
 * terminal" switch, which is off by default and persisted beside the other
 * mobile-remote state.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import type { MobileTerminalInfo } from "@cjhyy/code-shell-core";
import type { MobileServerEvent, RemoteHostManager } from "@cjhyy/code-shell-server/mobile-remote";
import {
  ptyAttachRemote,
  ptyDetachRemote,
  ptyList,
  ptyPruneRemoteViewers,
  ptyRemoteKill,
  ptyRemoteResize,
  ptyRemoteStart,
  ptyRemoteWrite,
  ptyRevokeRemoteAccess,
  type PtyInfo,
} from "../pty-service.js";
import { dlog } from "../desktop-logger.js";
import type { AuthenticatedMobileClientEvent } from "./handle-client-event.js";

export type RemoteTerminalEvent = Extract<
  AuthenticatedMobileClientEvent,
  { type: `terminal.${string}` }
>;

export function isRemoteTerminalEvent(
  event: AuthenticatedMobileClientEvent,
): event is RemoteTerminalEvent {
  return event.type.startsWith("terminal.");
}

/** The only persisted state: whether remote viewers may use terminals at all. */
export class RemoteTerminalPolicy {
  private value: boolean;

  constructor(private readonly filePath: string) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
      this.value =
        typeof parsed === "object" && parsed !== null && "enabled" in parsed
          ? parsed.enabled === true
          : false;
    } catch {
      this.value = false;
    }
  }

  get enabled(): boolean {
    return this.value;
  }

  set(enabled: boolean): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ enabled })}\n`, { mode: 0o600 });
    renameSync(tmp, this.filePath);
    this.value = enabled;
  }
}

/** Output is coalesced per viewer so a redrawing TUI doesn't send a frame per write. */
const FLUSH_DELAY_MS = 12;
const FLUSH_BYTES = 64 * 1024;

interface PendingOutput {
  viewerId: string;
  deviceId: string;
  terminalId: string;
  data: string;
  timer?: ReturnType<typeof setTimeout>;
}

export interface RemoteTerminalDeps {
  remote: Pick<RemoteHostManager, "sendToViewer" | "hasAuthenticatedViewer" | "broadcast">;
  policy: Pick<RemoteTerminalPolicy, "enabled" | "set">;
  /** Primary root of a known project; throws for an unknown id. */
  projectCwd: (projectId: string) => string;
}

export class RemoteTerminals {
  private readonly pending = new Map<string, PendingOutput>();

  constructor(private readonly deps: RemoteTerminalDeps) {}

  get enabled(): boolean {
    return this.deps.policy.enabled;
  }

  /** Desktop settings switch. Turning it off ends every remote session at once. */
  setEnabled(enabled: boolean): void {
    this.deps.policy.set(enabled);
    if (!enabled) {
      for (const entry of this.pending.values()) if (entry.timer) clearTimeout(entry.timer);
      this.pending.clear();
      ptyRevokeRemoteAccess();
    }
    this.deps.remote.broadcast(this.listEvent());
    dlog("main", "pty.remote.access", { enabled });
  }

  /** A remote tab went away without detaching. */
  releaseViewer(viewerId: string): void {
    ptyPruneRemoteViewers((key) => viewerOf(key) !== viewerId);
    for (const [key, entry] of this.pending) {
      if (entry.viewerId !== viewerId) continue;
      if (entry.timer) clearTimeout(entry.timer);
      this.pending.delete(key);
    }
  }

  handle(event: RemoteTerminalEvent): void {
    const { viewerId, deviceId } = event;
    if (!viewerId || !deviceId) return;
    const reply = (next: MobileServerEvent) => this.deps.remote.sendToViewer(viewerId, next);
    if (event.type === "terminal.list") {
      reply(this.listEvent());
      return;
    }
    if (!this.enabled) {
      reply({
        type: "terminal.error",
        ...(event.type === "terminal.open" ? { requestId: event.requestId } : {}),
        ...("terminalId" in event && event.terminalId ? { terminalId: event.terminalId } : {}),
        code: "disabled",
        message: "桌面端没有开启远程终端。",
      });
      return;
    }
    const key = viewerKey(viewerId, deviceId);
    switch (event.type) {
      case "terminal.open":
        this.open(event, key, reply);
        return;
      case "terminal.input":
        ptyRemoteWrite(event.terminalId, key, event.data, event.reply === true);
        return;
      case "terminal.resize":
        ptyRemoteResize(event.terminalId, key, event.cols, event.rows);
        return;
      case "terminal.detach":
        this.drop(key, event.terminalId);
        ptyDetachRemote(event.terminalId, key);
        return;
      case "terminal.kill":
        ptyRemoteKill(event.terminalId, key);
        return;
    }
  }

  private open(
    event: Extract<RemoteTerminalEvent, { type: "terminal.open" }>,
    key: string,
    reply: (event: MobileServerEvent) => void,
  ): void {
    const { requestId } = event;
    const fail = (code: "not_found" | "failed", message: string) =>
      reply({ type: "terminal.error", requestId, code, message });
    let terminalId = event.terminalId;
    if (!terminalId) {
      let cwd: string;
      try {
        cwd = event.projectId ? this.deps.projectCwd(event.projectId) : homedir();
      } catch {
        fail("not_found", "找不到这个项目。");
        return;
      }
      terminalId = `term:remote::${randomUUID()}`;
      const started = ptyRemoteStart({
        sessionId: terminalId,
        cwd,
        cols: event.cols,
        rows: event.rows,
      });
      if (!started.ok) {
        fail("failed", started.detail);
        return;
      }
    }
    const id = terminalId;
    const attached = ptyAttachRemote(
      id,
      {
        key,
        onData: (data) => this.queue(key, id, data),
        onExit: (exitCode, signal) => {
          this.flush(key, id);
          reply({
            type: "terminal.exit",
            terminalId: id,
            exitCode,
            ...(signal ? { signal } : {}),
          });
        },
      },
      { cols: event.cols, rows: event.rows },
    );
    if (!attached) {
      fail("not_found", "这个终端已经关闭了。");
      return;
    }
    // Anything buffered for an earlier attachment is already in the replay.
    this.drop(key, id);
    reply({
      type: "terminal.opened",
      requestId,
      terminal: toInfo(attached.info),
      replay: attached.replay,
    });
  }

  private queue(key: string, terminalId: string, data: string): void {
    const slot = `${key}\n${terminalId}`;
    let entry = this.pending.get(slot);
    if (!entry) {
      const [viewerId, deviceId] = splitKey(key);
      entry = { viewerId, deviceId, terminalId, data: "" };
      this.pending.set(slot, entry);
    }
    entry.data += data;
    if (entry.data.length >= FLUSH_BYTES) {
      this.flush(key, terminalId);
      return;
    }
    entry.timer ??= setTimeout(() => this.flush(key, terminalId), FLUSH_DELAY_MS);
  }

  private flush(key: string, terminalId: string): void {
    const slot = `${key}\n${terminalId}`;
    const entry = this.pending.get(slot);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(slot);
    if (!this.deps.remote.hasAuthenticatedViewer(entry.viewerId, entry.deviceId)) {
      ptyDetachRemote(terminalId, key);
      return;
    }
    if (entry.data) {
      this.deps.remote.sendToViewer(entry.viewerId, {
        type: "terminal.data",
        terminalId,
        data: entry.data,
      });
    }
  }

  private drop(key: string, terminalId: string): void {
    const slot = `${key}\n${terminalId}`;
    const entry = this.pending.get(slot);
    if (entry?.timer) clearTimeout(entry.timer);
    this.pending.delete(slot);
  }

  private listEvent(): MobileServerEvent {
    return {
      type: "terminal.list.ok",
      enabled: this.enabled,
      terminals: this.enabled ? ptyList().map(toInfo) : [],
    };
  }
}

function viewerKey(viewerId: string, deviceId: string): string {
  return `${viewerId}\n${deviceId}`;
}

function splitKey(key: string): [string, string] {
  const at = key.indexOf("\n");
  return [key.slice(0, at), key.slice(at + 1)];
}

function viewerOf(key: string): string {
  return splitKey(key)[0];
}

function toInfo(info: PtyInfo): MobileTerminalInfo {
  return { ...info, title: basename(info.cwd) || info.cwd };
}
