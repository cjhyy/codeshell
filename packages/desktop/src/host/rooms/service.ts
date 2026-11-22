import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { sessionsRoot } from "@cjhyy/code-shell-core";
import type { ClaimedMobileUpload } from "@cjhyy/code-shell-server/mobile-remote";
import type { ActivityHistoryWorker } from "../../main/activity-history-worker-client.js";
import type { AuthenticatedMobileClientEvent } from "../../main/mobile-remote/handle-client-event.js";
import type { ExternalRuntimeModelEntry } from "../../shared/external-runtime-models.js";
import type { ReadCcRoom } from "../../shared/cc-room-reads.js";
import type { RoomHistoryRequest } from "@cjhyy/code-shell-server/mobile-remote";
import type { PrivateHostPeer } from "../native-peer.js";
import { roomPhoneActions } from "./phone.js";
import { createOwnedRooms } from "./runtime.js";
import { workbenchRoomActions, type WorkbenchRoomCall } from "./workbench.js";

export interface RoomHostSources {
  createAgent?: Parameters<typeof createOwnedRooms>[0]["createAgent"];
  history: Pick<ActivityHistoryWorker, "roomHistory">;
  read: (signal: AbortSignal) => ReadCcRoom;
  models(): Promise<ExternalRuntimeModelEntry[]>;
}
export type RoomDesktopRequest = {
  key: string;
  owner: number;
  flow: string;
  action: WorkbenchRoomCall;
};
export function hostedRooms(peer: () => PrivateHostPeer, data: string, sources: RoomHostSources) {
  const running = new AsyncLocalStorage<{ signal: AbortSignal; desktop?: RoomDesktopRequest }>();
  const life = new AbortController();
  const currentSignal = () => running.getStore()?.signal ?? life.signal;
  const owned = createOwnedRooms({
    directory: join(data, "mobile-remote"),
    sessions: sessionsRoot(),
    createAgent: sources.createAgent,
    externalRuntimeModels: sources.models,
    confirm(approval, requester, signal) {
      const entry = running.getStore()?.desktop;
      if (!entry || entry.action.op !== "openSession" || entry.key !== requester.key)
        throw Error("Room confirmation no longer belongs to a window");
      return peer().call(
        "rooms/confirm",
        { flow: entry.flow, approval },
        AbortSignal.any([signal, currentSignal()]),
      );
    },
    emit(event) {
      if (event.type === "room.message") phone.observed(event.roomId, event.msg);
      peer().notify("rooms/event", event);
    },
  });
  const history = {
    getMessages: (roomId: string, sinceSeq = 0) =>
      sources.history.roomHistory("rooms/messages", {
        rootIdentity: owned.manager.rootIdentity,
        roomId,
        sinceSeq,
      }),
    getHistoryPage: (roomId: string, request: RoomHistoryRequest = {}) =>
      sources.history.roomHistory("rooms/historyPage", {
        rootIdentity: owned.manager.rootIdentity,
        roomId,
        request,
      }),
  };
  const desktop = workbenchRoomActions(owned, () => {
    const entry = running.getStore()?.desktop;
    if (!entry || !(entry.action.op === "linked" || entry.action.op === "subscribe"))
      throw Error("No transcript observation request");
    return peer().call("rooms/background", { flow: entry.flow }, currentSignal());
  });
  const upload = (action: string, device: string, id: string, claimId?: string) =>
    peer().call<void>("rooms/upload", { action, device, id, claimId });
  const phone = roomPhoneActions(owned, {
    authorize: (device, viewer) => peer().call("rooms/authorize", { device, viewer }, life.signal),
    send: (scope, id, event) => peer().notify("rooms/reply", { scope, id, event }),
    uploads: {
      claim: (device, id) =>
        peer().call<ClaimedMobileUpload>("rooms/upload", { action: "claim", device, id }),
      release: (device, id, claim) => upload("release", device, id, claim),
      retain: (device, id) => upload("retain", device, id),
      discard: (device, id) => upload("discard", device, id),
    },
    settle: async (device, claims, action) => {
      await Promise.all(claims.map((c) => upload(action, device, c.uploadId, c.claimId)));
    },
    projects: (device) => peer().call("rooms/projects", { device }, currentSignal()),
    history,
    read: (method, input) => sources.read(currentSignal())(method, input),
  });
  try {
    owned.manager.pruneStaleRooms(14 * 24 * 60 * 60 * 1000);
  } catch {
    /* A locked room is retained. */
  }
  return {
    run(method: string, raw: unknown, signal: AbortSignal) {
      const active = AbortSignal.any([signal, life.signal]);
      active.throwIfAborted();
      if (method === "rooms/desktop") {
        const entry = raw as RoomDesktopRequest;
        if (!entry?.key || !entry.flow || !Number.isSafeInteger(entry.owner) || !entry.action)
          throw Error("Invalid room document");
        return running.run({ desktop: entry, signal: active }, () =>
          desktop.run(entry.action, {
            id: entry.owner,
            key: entry.key,
            assertCurrent: () => active.throwIfAborted(),
          }),
        );
      }
      if (method === "rooms/phone")
        return running.run({ signal: active }, () =>
          phone.handle(raw as AuthenticatedMobileClientEvent, active),
        );
      if (method === "rooms/catalog") return owned.manager.listRooms().map(owned.publicRoom);
      if (method === "rooms/root") return owned.manager.rootIdentity;
      throw Error("Unknown room action");
    },
    notice(method: string, key: unknown) {
      if (
        method === "rooms/onlineDevices" &&
        Array.isArray(key) &&
        key.every((v) => typeof v === "string")
      )
        phone.presence(key);
      if (typeof key !== "string") return;
      if (method === "rooms/release") desktop.release(key);
      if (method === "rooms/left") phone.left(key);
      if (method === "rooms/cancel") phone.cancel(key);
    },
    close() {
      life.abort();
      phone.close();
      owned.transcripts.closeAll();
      owned.manager.closeAll();
    },
  };
}
