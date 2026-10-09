import { readOutputJournal, readOutputJournalLegacyBase } from "@cjhyy/code-shell-core/internal";
import type { MobileServerEvent } from "@cjhyy/code-shell-core";
import { transcriptToStreamEvents } from "@cjhyy/code-shell-web";
import type { Snapshot } from "../SessionSnapshotStore.js";
import type { AuthenticatedMobileClientEvent } from "./handle-client-event.js";

interface Binding {
  sessionId: string;
  recoveryId: string;
  authority?: string;
}

/** A selected tab owns a read grant, never a caller supplied storage root or an arbitrary Session. */
export class MobileOutputRecovery {
  private readonly bindings = new Map<string, Binding>();
  private activeReads = 0;
  private readonly readingViewers = new Set<string>();
  constructor(
    private readonly deps: {
      root: () => string;
      authority: (sessionId: string) => Promise<string>;
      snapshot: (sessionId: string) => Snapshot | undefined;
      reply: (viewerId: string, event: MobileServerEvent) => void;
    },
  ) {}

  revoke(viewerId: string): void {
    this.bindings.delete(viewerId);
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
      const binding: Binding = { sessionId: event.sessionId, recoveryId: event.recoveryId };
      if (this.bindings.size >= 128) {
        this.deps.reply(viewer, { type: "session.recovery.ready", ...binding, ok: false });
        return false;
      }
      this.bindings.set(viewer, binding);
      try {
        binding.authority = await this.deps.authority(event.sessionId);
        if (this.bindings.get(viewer) !== binding) return false;
        this.deps.reply(viewer, {
          type: "session.recovery.ready",
          sessionId: event.sessionId,
          recoveryId: event.recoveryId,
          ok: true,
        });
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
