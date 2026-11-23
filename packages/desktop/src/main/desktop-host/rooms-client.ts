import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { IpcMainInvokeEvent } from "electron";
import type {
  MobileServerEvent,
  MobileUploadService,
  RemoteHostManager,
} from "@cjhyy/code-shell-server/mobile-remote";
import type { PrivateHostPeer } from "../../host/native-peer.js";
import type { WorkbenchRoomCall } from "../../host/rooms/workbench.js";
import type { RoomRuntimeEvent } from "../../host/rooms/runtime.js";
import type { RoomModeApproval } from "../cc-room/room-mode-authority.js";
import type { confirmOnDesktop } from "../cc-room/room-mode-ipc.js";
import type { AuthenticatedMobileClientEvent } from "../mobile-remote/handle-client-event.js";
import type { DriveAgentTranscriptAccess } from "../cc-room/drive-agent-transcript-access.js";
type Origin = { key: string; owner: number; action: WorkbenchRoomCall; signal: AbortSignal };
type Upload = { device: string; callers: Set<string>; retainedUntil: number; claim?: string };
type Effects = {
  document(event: IpcMainInvokeEvent): AbortSignal;
  remote: Pick<
    RemoteHostManager,
    | "hasAuthenticatedViewer"
    | "isTrustedDevice"
    | "sendToViewer"
    | "sendToDevice"
    | "broadcast"
    | "onlineDeviceIds"
  >;
  uploads: Pick<MobileUploadService, "claim" | "retain" | "discard" | "release" | "finalize">;
  confirm: typeof confirmOnDesktop;
  listBackground: ConstructorParameters<typeof DriveAgentTranscriptAccess>[0];
  projects(device: string): Promise<void>;
  publish(event: RoomRuntimeEvent): void;
};
const allowedReplies = new Set([
  "ccRoom.approvalRequest",
  "ccRoom.listSessions.ok",
  "ccRoom.opened",
  "ccRoom.probe.ok",
  "ccRoom.readHistory.ok",
  "ccRoom.transcriptSubscribed",
  "chat.queued",
  "queue.error",
  "queue.state",
  "room.accepted",
  "room.error",
  "room.history.ok",
  "room.list.ok",
  "room.opened",
]);
import { RoomObservers } from "./room-observers.js";
export class NativeRooms {
  private readonly observers = new RoomObservers();
  private readonly links = new Map<
    string,
    Map<string, Extract<WorkbenchRoomCall, { op: "linked" }>>
  >();
  private resumeViews = false;
  private readonly openRooms = new Set<string>();
  private rootIdentity?: { peer: PrivateHostPeer; value: Promise<string> };
  // Only targets whose previous published queue contained entries are needed
  // to issue fresh snapshots. No message, upload or execution intent is kept.
  private readonly queueTargets = new Map<string, Set<string>>();
  presence() {
    try {
      this.peer().notify("rooms/onlineDevices", this.deps.remote.onlineDeviceIds());
    } catch {
      /* A new Host receives current presence at startup. */
    }
  }
  async connected() {
    const peer = this.peer();
    // The catalog initializes retention and lets connected phones drop stale run flags.
    const rooms = await peer.call<import("@cjhyy/code-shell-server/mobile-remote").RoomPublic[]>(
      "rooms/catalog",
      {},
    );
    if (this.peer() !== peer) return;
    this.presence();
    this.deps.publish({ type: "room.list.ok", rooms });
    for (const room of rooms)
      if (this.openRooms.has(room.id) && !room.open) {
        this.deps.publish({ type: "room.closed", roomId: room.id });
        this.deps.publish({ type: "room.changed", room });
      }
    this.openRooms.clear();
    for (const room of rooms) if (room.open) this.openRooms.add(room.id);
    if (this.resumeViews) {
      this.resumeViews = false;
      const snapshots: Promise<unknown>[] = [];
      for (const [viewerId, { device: deviceId }] of this.viewers)
        for (const roomId of this.queueTargets.get(deviceId) ?? []) {
          snapshots.push(
            this.sendPhone(
              { type: "queue.sync", target: { kind: "room", roomId }, deviceId, viewerId },
              deviceId,
              viewerId,
            ),
          );
        }
      await Promise.allSettled(snapshots);
      await this.observers.resume((roomId) =>
        this.deps.publish({
          type: "room.recovery",
          roomId,
          message: "房间服务重启后未能重新验证转录订阅，请重新打开。",
        }),
      );
    }
  }
  private readonly documents = new WeakMap<AbortSignal, string>();
  private readonly flows = new Map<string, Origin>();
  private readonly viewers = new Map<string, { device: string; active: AbortController }>();
  private readonly tickets = new Map<string, Upload>();
  constructor(
    private readonly peer: () => PrivateHostPeer,
    private readonly deps: Effects,
    private readonly ready?: (signal: AbortSignal) => Promise<void>,
  ) {}
  async desktop(event: IpcMainInvokeEvent, action: WorkbenchRoomCall) {
    const signal = this.deps.document(event);
    await this.ready?.(signal);
    signal.throwIfAborted();
    let key = this.documents.get(signal);
    if (!key) {
      key = "desktop:" + randomUUID();
      this.documents.set(signal, key);
      signal.addEventListener(
        "abort",
        () => {
          this.observers.remove(key!);
          this.links.delete(key!);
          try {
            this.peer().notify("rooms/release", key);
          } catch {
            /* Disconnected owner has been revoked. */
          }
        },
        { once: true },
      );
    }
    const document = key;
    if (action.op === "unsubscribe") this.observers.remove(document, action.roomId);
    if (action.op === "end" || action.op === "close")
      this.links.get(document)?.delete(action.roomId);
    if (action.op === "subscribe") {
      const source = this.links.get(document)?.get(action.roomId);
      return this.observers.subscribe(document, action.roomId, async (resume, active) => {
        const sig = AbortSignal.any([signal, active]);
        if (resume && source) {
          const opened = (await this.invoke(event, document, source, sig)) as { roomId: string };
          if (opened?.roomId !== action.roomId) throw Error("Room observation changed");
        }
        sig.throwIfAborted();
        return this.invoke(event, document, action, sig);
      });
    }
    const result = await this.invoke(event, document, action, signal);
    if (
      action.op === "linked" &&
      action.source !== undefined &&
      typeof (result as { roomId?: string })?.roomId === "string"
    ) {
      const links = this.links.get(document) ?? new Map();
      this.links.set(document, links);
      links.set((result as { roomId: string }).roomId, action);
    }
    return result;
  }
  private async invoke(
    event: IpcMainInvokeEvent,
    key: string,
    action: WorkbenchRoomCall,
    signal: AbortSignal,
  ) {
    this.deps.document(event).throwIfAborted();
    const peer = this.peer();
    const flow = randomUUID(),
      owner = event.sender.id;
    this.flows.set(flow, { key, owner, action, signal });
    try {
      const value = await peer.call("rooms/desktop", { flow, key, owner, action }, signal);
      signal.throwIfAborted();
      return value;
    } finally {
      this.flows.delete(flow);
    }
  }
  async root() {
    const signal = AbortSignal.timeout(15000);
    await this.ready?.(signal);
    const peer = this.peer();
    if (this.rootIdentity?.peer === peer) return this.rootIdentity.value;
    const value = peer.call<string>("rooms/root", {}, signal).catch((error) => {
      if (this.rootIdentity?.peer === peer) this.rootIdentity = undefined;
      throw error;
    });
    this.rootIdentity = { peer, value };
    return value;
  }
  async phone(event: AuthenticatedMobileClientEvent) {
    const { viewerId, deviceId } = event;
    if (!viewerId || !deviceId || !this.deps.remote.hasAuthenticatedViewer(viewerId, deviceId))
      throw Error("Room requester disconnected");
    if (event.type === "ccRoom.subscribeTranscript") {
      await this.observers.subscribe("mobile:" + viewerId, event.roomId, (_resume, active) =>
        this.sendPhone(event, deviceId, viewerId, active),
      );
      return;
    }
    if (event.type === "ccRoom.unsubscribeTranscript")
      this.observers.remove("mobile:" + viewerId, event.roomId);
    await this.sendPhone(event, deviceId, viewerId);
  }
  private async sendPhone(
    event: AuthenticatedMobileClientEvent,
    deviceId: string,
    viewerId: string,
    scope?: AbortSignal,
  ) {
    if (!this.deps.remote.hasAuthenticatedViewer(viewerId, deviceId))
      throw Error("Room requester disconnected");
    const previous = this.viewers.get(viewerId);
    if (previous && previous.device !== deviceId) this.left(viewerId);
    const tab = this.viewers.get(viewerId) ?? { device: deviceId, active: new AbortController() };
    this.viewers.set(viewerId, tab);
    const active = scope ? AbortSignal.any([tab.active.signal, scope]) : tab.active.signal;
    await this.ready?.(active);
    active.throwIfAborted();
    this.authorize(deviceId, viewerId);
    const flow = randomUUID();
    const keys: string[] = [];
    if (event.type === "room.send") {
      this.sweepTickets();
      for (const item of event.attachments ?? [])
        if (item.transport === "upload") {
          const key = JSON.stringify([deviceId, item.uploadId]);
          const ticket = this.tickets.get(key) ?? {
            device: deviceId,
            callers: new Set<string>(),
            retainedUntil: 0,
          };
          ticket.callers.add(flow);
          this.tickets.set(key, ticket);
          keys.push(key);
        }
    }
    try {
      const value = await this.peer().call("rooms/phone", event, active);
      active.throwIfAborted();
      return value;
    } finally {
      for (const key of keys) {
        this.tickets.get(key)?.callers.delete(flow);
      }
      this.sweepTickets();
    }
  }
  private sweepTickets() {
    for (const [key, ticket] of this.tickets)
      if (!ticket.callers.size && !ticket.claim && ticket.retainedUntil <= Date.now())
        this.tickets.delete(key);
  }
  left(viewer: string) {
    this.observers.remove("mobile:" + viewer);
    this.viewers.get(viewer)?.active.abort();
    const device = this.viewers.get(viewer)?.device;
    this.viewers.delete(viewer);
    if (device && ![...this.viewers.values()].some((t) => t.device === device))
      this.queueTargets.delete(device);
    try {
      this.peer().notify("rooms/left", viewer);
    } catch {
      /* The old Host is already gone. */
    }
  }
  cancel(viewer: string) {
    try {
      this.peer().notify("rooms/cancel", viewer);
    } catch {
      /* No live mode approval. */
    }
  }
  disconnect() {
    this.rootIdentity = undefined;
    this.resumeViews = true;
    this.observers.pause();
    for (const [viewer, tab] of this.viewers) {
      tab.active.abort();
      if (this.deps.remote.hasAuthenticatedViewer(viewer, tab.device))
        tab.active = new AbortController();
      else this.left(viewer);
    }
    this.flows.clear();
    // A physical submit could have won the race. Leave uncertain claimed
    // uploads to the receiver's expiry instead of guessing their disposition.
    this.tickets.clear();
  }
  private authorize(device: unknown, viewer?: unknown) {
    if (
      typeof device !== "string" ||
      !(viewer === undefined
        ? this.deps.remote.isTrustedDevice(device)
        : typeof viewer === "string" &&
          this.viewers.get(viewer)?.device === device &&
          this.deps.remote.hasAuthenticatedViewer(viewer, device))
    )
      throw Error("Room requester disconnected");
  }
  async handle(method: string, input: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const raw = input as Record<string, unknown>;
    if (method === "rooms/authorize") {
      this.authorize(raw.device, raw.viewer);
      return;
    }
    if (method === "rooms/projects") {
      this.authorize(raw.device);
      return this.deps.projects(raw.device as string);
    }
    if (method === "rooms/upload") {
      const { action, device, id, claimId } = raw;
      const key = JSON.stringify([device, id]);
      const ticket = this.tickets.get(key);
      if (
        typeof device !== "string" ||
        typeof id !== "string" ||
        !ticket ||
        ticket.device !== device
      )
        throw Error("Unknown room upload");
      if (action === "release" || action === "finalize") {
        if (typeof claimId !== "string" || claimId !== ticket.claim)
          throw Error("Room claim changed");
        await this.deps.uploads[action](device, id, claimId);
        ticket.claim = undefined;
        if (action === "finalize") this.tickets.delete(key);
        return;
      }
      this.authorize(device);
      if (action === "discard") {
        await this.deps.uploads.discard(device, id);
        this.tickets.delete(key);
        return;
      }
      if (action === "retain" && ticket.callers.size) {
        this.deps.uploads.retain(device, id);
        ticket.retainedUntil = Date.now() + 12 * 60 * 60 * 1000;
        return;
      }
      if (action === "claim" && (ticket.callers.size || ticket.retainedUntil > Date.now())) {
        const claim = this.deps.uploads.claim(device, id);
        ticket.claim = claim.claimId;
        return claim;
      }
      throw Error("Room upload is no longer current");
    }
    const origin = this.flows.get(String(raw.flow));
    if (!origin) throw Error("Unknown room document");
    const active = AbortSignal.any([origin.signal, signal]);
    active.throwIfAborted();
    if (
      method === "rooms/background" &&
      (origin.action.op === "linked" || origin.action.op === "subscribe")
    ) {
      const list = await this.deps.listBackground();
      active.throwIfAborted();
      return list;
    }
    if (
      method === "rooms/confirm" &&
      origin.action.op === "openSession" &&
      origin.action.mode === "bypassPermissions"
    ) {
      const approval = raw.approval as RoomModeApproval;
      if (
        approval?.requesterKey !== origin.key ||
        approval.toMode !== "bypassPermissions" ||
        approval.sessionId !== origin.action.sessionId ||
        approval.kind !== (origin.action.kind ?? "claude-code") ||
        (origin.action.settings && approval.roomId !== origin.action.settings.roomId)
      )
        throw Error("Room approval changed");
      if ((await realpath(origin.action.cwd)) !== approval.cwd)
        throw Error("Room directory changed");
      active.throwIfAborted();
      const result = await this.deps.confirm(
        approval,
        {
          key: origin.key,
          channel: "desktop",
          ownerWebContentsId: origin.owner,
          assertCurrent: () => active.throwIfAborted(),
        },
        active,
      );
      active.throwIfAborted();
      return result;
    }
    throw Error("Invalid room effect");
  }
  notice(method: string, input: unknown) {
    if (method === "rooms/event") {
      const event = input as RoomRuntimeEvent;
      if (event?.type === "room.changed") {
        if (event.room.open) this.openRooms.add(event.room.id);
        else this.openRooms.delete(event.room.id);
      }
      if (event?.type === "room.closed") {
        this.observers.ended(event.roomId);
        for (const links of this.links.values()) links.delete(event.roomId);
      }
      if (
        event &&
        [
          "room.message",
          "room.list.ok",
          "room.closed",
          "room.recovery",
          "room.changed",
          "ccRoom.approvalRequest",
          "ccRoom.approvalResolved",
        ].includes(event.type)
      )
        this.deps.publish(event);
      return;
    }
    if (method !== "rooms/reply") return;
    const { scope, id, event } = input as { scope: string; id?: string; event: MobileServerEvent };
    if (!event || !allowedReplies.has(event.type)) return;
    if (event.type === "queue.state" && event.target.kind === "room" && id) {
      const device =
        scope === "device" ? id : scope === "viewer" ? this.viewers.get(id)?.device : undefined;
      if (device) {
        const tracked = this.queueTargets.get(device) ?? new Set<string>();
        if (event.entries.length) {
          tracked.add(event.target.roomId);
          this.queueTargets.set(device, tracked);
        } else {
          tracked.delete(event.target.roomId);
          if (!tracked.size) this.queueTargets.delete(device);
        }
      }
    }
    if (scope === "viewer" && id) {
      const tab = this.viewers.get(id);
      if (tab && this.deps.remote.hasAuthenticatedViewer(id, tab.device))
        this.deps.remote.sendToViewer(id, event);
    }
    if (scope === "device" && id && this.deps.remote.isTrustedDevice(id))
      this.deps.remote.sendToDevice(id, event);
    if (scope === "broadcast") this.deps.remote.broadcast(event);
  }
}
