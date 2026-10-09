import { readOutputJournal, readOutputJournalLegacyBase } from "@cjhyy/code-shell-core/internal";
import type { MobileServerEvent } from "@cjhyy/code-shell-core";
import { transcriptToStreamEvents } from "@cjhyy/code-shell-web";
import type { Snapshot } from "../SessionSnapshotStore.js";
import type { OwnedExternalStreamEntry } from "../owned-external-stream.js";
import type { AuthenticatedMobileClientEvent } from "./handle-client-event.js";

interface Binding {
  viewerId: string;
  deviceId: string;
  sessionId: string;
  recoveryId: string;
  authority?: string;
  pending?: {
    seq: number;
    epoch: string;
    ownerWebContentsId: number;
    outputCursor?: string;
  };
  mirroring?: boolean;
}

/** A selected tab owns a read grant, never a caller supplied storage root or an arbitrary Session. */
export class MobileOutputRecovery {
  private readonly bindings = new Map<string, Binding>();
  private activeReads = 0;
  private readonly readingViewers = new Set<string>();
  private readonly pendingMirrors = new Set<Binding>();
  private activeMirrors = 0;
  constructor(
    private readonly deps: {
      root: () => string;
      authority: (sessionId: string) => Promise<string>;
      snapshot: (sessionId: string, sinceSeq?: number) => Snapshot | undefined;
      reply: (viewerId: string, event: MobileServerEvent) => void;
      owner?: (sessionId: string) => number | undefined;
      authenticated?: (viewerId: string, deviceId: string) => boolean;
      journalRequired?: (sessionId: string) => boolean;
    },
  ) {}

  revoke(viewerId: string): void {
    const old = this.bindings.get(viewerId);
    if (old) this.pendingMirrors.delete(old);
    this.bindings.delete(viewerId);
  }

  /** A bounded notification, not another event queue or a worker broadcast. */
  mirrorOwned(entry: OwnedExternalStreamEntry): void {
    if (!this.deps.owner || !this.deps.authenticated) return;
    const cursor = (entry.event as { outputCursor?: unknown } | null)?.outputCursor;
    for (const binding of this.bindings.values()) {
      if (binding.sessionId !== entry.sessionId) continue;
      binding.pending = {
        seq: entry.seq,
        epoch: entry.epoch,
        ownerWebContentsId: entry.ownerWebContentsId,
        ...(typeof cursor === "string" && cursor.length <= 2048 ? { outputCursor: cursor } : {}),
      };
      if (binding.authority && !binding.mirroring) this.pendingMirrors.add(binding);
    }
    this.pumpMirrors();
  }

  private pumpMirrors(): void {
    while (this.activeMirrors < 8 && this.pendingMirrors.size) {
      const binding = this.pendingMirrors.values().next().value!;
      this.pendingMirrors.delete(binding);
      if (this.bindings.get(binding.viewerId) !== binding || binding.mirroring) continue;
      binding.mirroring = true;
      this.activeMirrors++;
      void this.mirrorOne(binding).finally(() => {
        binding.mirroring = false;
        this.activeMirrors--;
        if (binding.pending && this.bindings.get(binding.viewerId) === binding)
          this.pendingMirrors.add(binding);
        this.pumpMirrors();
      });
    }
  }

  private async mirrorOne(binding: Binding): Promise<void> {
    const header = binding.pending;
    if (!header) return;
    binding.pending = undefined;
    const valid = () =>
      this.bindings.get(binding.viewerId) === binding &&
      this.deps.authenticated?.(binding.viewerId, binding.deviceId) === true &&
      this.deps.owner?.(binding.sessionId) === header.ownerWebContentsId;
    try {
      if (!valid() || (await this.deps.authority(binding.sessionId)) !== binding.authority)
        throw new Error("selected stream unavailable");
      // Fetch only the exact sequence observed at the owned ingress. A native
      // worker entry interleaved in this Session cannot be mirrored twice.
      const snapshot = this.deps.snapshot(binding.sessionId, header.seq - 1);
      const frame = snapshot?.events.find((candidate) => candidate.seq === header.seq);
      if (
        !snapshot ||
        snapshot.epoch !== header.epoch ||
        (await this.deps.authority(binding.sessionId)) !== binding.authority ||
        !valid()
      )
        throw new Error("selected stream unavailable");
      if (frame && Buffer.byteLength(JSON.stringify(frame.event)) <= 512 * 1024) {
        this.deps.reply(binding.viewerId, {
          type: "session.stream",
          sessionId: binding.sessionId,
          epoch: header.epoch,
          seq: frame.seq,
          event: frame.event,
        });
      } else if (header.outputCursor) {
        // No fabricated StreamEvent/cursor pair: the existing snapshot control
        // advertises the actual committed head and lets bounded pages recover it.
        this.deps.reply(binding.viewerId, {
          type: "session.snapshot",
          sessionId: binding.sessionId,
          epoch: header.epoch,
          nextSeq: header.seq + 1,
          entries: [],
          outputCursor: header.outputCursor,
        });
      } else throw new Error("uncovered stream unavailable");
    } catch {
      if (this.bindings.get(binding.viewerId) === binding) {
        this.revoke(binding.viewerId);
        if (this.deps.authenticated?.(binding.viewerId, binding.deviceId))
          this.deps.reply(binding.viewerId, {
            type: "session.recovery.ready",
            sessionId: binding.sessionId,
            recoveryId: binding.recoveryId,
            ok: false,
          });
      }
    }
  }

  async handle(event: AuthenticatedMobileClientEvent): Promise<boolean> {
    const viewer = event.viewerId;
    if (!viewer || !event.deviceId) return false;
    if (
      event.type === "session.recovery.cancel" ||
      event.type === "session.create" ||
      event.type === "ccRoom.openSession" ||
      event.type === "room.open" ||
      event.type === "room.create" ||
      event.type === "room.send"
    ) {
      this.revoke(viewer);
      return true;
    }
    if (event.type === "session.select") {
      this.revoke(viewer);
      if (!event.recoveryId) return true;
      if (this.deps.authenticated && !this.deps.authenticated(viewer, event.deviceId)) return false;
      const binding: Binding = {
        sessionId: event.sessionId,
        recoveryId: event.recoveryId,
        viewerId: viewer,
        deviceId: event.deviceId,
      };
      if (this.bindings.size >= 128) {
        this.deps.reply(viewer, { type: "session.recovery.ready", ...binding, ok: false });
        return false;
      }
      this.bindings.set(viewer, binding);
      try {
        binding.authority = await this.deps.authority(event.sessionId);
        if (
          this.bindings.get(viewer) !== binding ||
          (this.deps.authenticated && !this.deps.authenticated(viewer, event.deviceId))
        )
          return false;
        this.deps.reply(viewer, {
          type: "session.recovery.ready",
          sessionId: event.sessionId,
          recoveryId: event.recoveryId,
          ok: true,
          ...(this.deps.journalRequired?.(event.sessionId) ? { journalRequired: true } : {}),
        });
        if (binding.pending) {
          this.pendingMirrors.add(binding);
          this.pumpMirrors();
        }
        return true;
      } catch {
        if (this.bindings.get(viewer) !== binding) return false;
        this.revoke(viewer);
        this.deps.reply(viewer, {
          type: "session.recovery.ready",
          sessionId: event.sessionId,
          recoveryId: event.recoveryId,
          ok: false,
        });
        return false;
      }
    }
    if (event.type !== "session.outputJournal") return true;
    const binding = this.bindings.get(viewer);
    const valid = () =>
      binding &&
      this.bindings.get(viewer) === binding &&
      binding.deviceId === event.deviceId &&
      (!this.deps.authenticated || this.deps.authenticated(viewer, event.deviceId)) &&
      binding.sessionId === event.sessionId &&
      binding.recoveryId === event.recoveryId &&
      binding.authority !== undefined;
    const reply = (data: Partial<Extract<MobileServerEvent, { type: "session.outputJournal" }>>) =>
      this.deps.reply(viewer, {
        type: "session.outputJournal",
        sessionId: event.sessionId,
        recoveryId: event.recoveryId,
        requestId: event.requestId,
        page: { version: 1, status: "incomplete", frames: [], complete: false },
        ...data,
      });
    // No pending-page queue: one read per viewer and eight globally bound the
    // raw page + raw cutover prefix held over an asynchronous authority check.
    if (!valid() || this.readingViewers.has(viewer) || this.activeReads >= 8) {
      reply({});
      return false;
    }
    this.readingViewers.add(viewer);
    this.activeReads++;
    try {
      if (
        !valid() ||
        (await this.deps.authority(event.sessionId)) !== binding!.authority ||
        !valid()
      )
        throw new Error("read grant revoked");
      const root = this.deps.root();
      const page = readOutputJournal(root, event.sessionId, {
        after: event.after,
        through: event.through,
      });
      const base =
        page.status === "ok" && event.after === undefined
          ? readOutputJournalLegacyBase(root, event.sessionId, page.legacyBaseThroughEventId)
          : undefined;
      if ((await this.deps.authority(event.sessionId)) !== binding!.authority || !valid())
        throw new Error("read grant revoked");
      const snapshot = this.deps.snapshot(event.sessionId);
      if (!snapshot) throw new Error("snapshot unavailable");
      const legacyBase = base
        ? {
            throughEventId: page.legacyBaseThroughEventId!,
            events: base.complete ? transcriptToStreamEvents(base.events) : [],
          }
        : undefined;
      if (legacyBase && Buffer.byteLength(JSON.stringify(legacyBase)) > 1024 * 1024)
        throw new Error("display base exceeds its bound");
      reply({
        page,
        ...(base ? { legacyBase, legacyBaseComplete: base.complete } : {}),
        snapshot: {
          epoch: snapshot.epoch,
          nextSeq: snapshot.nextSeq,
          outputCursor: snapshot.outputCursor,
          unpaired: snapshot.outputUnpaired === true,
          ...(snapshot.outputInputIds ? { inputIds: snapshot.outputInputIds } : {}),
        },
      });
    } catch {
      // Fixed path-free failure; a once negotiated missing grant cannot become legacy success.
      reply({});
    } finally {
      this.readingViewers.delete(viewer);
      this.activeReads--;
    }
    return false;
  }
}
