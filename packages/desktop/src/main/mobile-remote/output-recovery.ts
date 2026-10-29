import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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
  cursorKey: Buffer;
  pending?: {
    seq: number;
    epoch: string;
    ownerWebContentsId: number;
    outputCursor?: string;
  };
  mirroring?: boolean;
}

const MiB = 1024 * 1024;
const BASE_PAGE_BYTES = MiB - 32 * 1024;
type BaseRequest = Extract<AuthenticatedMobileClientEvent, { type: "session.legacyBase" }>;
type BaseReply = Extract<MobileServerEvent, { type: "session.legacyBase" }>;
interface BaseCursor {
  v: 1;
  sessionId: string;
  recoveryId: string;
  throughEventId: string;
  endOffset: number;
  sha256: string;
  index: number;
  total: number;
}
function boundedText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}
function encodeBaseCursor(payload: BaseCursor, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", key).update(body).digest("base64url");
  const cursor = `${body}.${mac}`;
  if (cursor.length > 2048) throw new Error("base cursor exceeds its bound");
  return cursor;
}
function decodeBaseCursor(token: string, binding: Binding): BaseCursor {
  if (!boundedText(token, 2048) || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error("invalid base cursor");
  const [body, mac] = token.split(".");
  const supplied = Buffer.from(mac, "base64url");
  const expected = createHmac("sha256", binding.cursorKey).update(body).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw new Error("invalid base cursor");
  const bytes = Buffer.from(body, "base64url");
  if (
    bytes.length > 1400 ||
    bytes.toString("base64url") !== body ||
    supplied.toString("base64url") !== mac
  )
    throw new Error("invalid base cursor");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "endOffset,index,recoveryId,sessionId,sha256,throughEventId,total,v" ||
    value.v !== 1 ||
    value.sessionId !== binding.sessionId ||
    value.recoveryId !== binding.recoveryId ||
    !boundedText(value.throughEventId, 512) ||
    !Number.isSafeInteger(value.endOffset) ||
    value.endOffset < 1 ||
    value.endOffset > 32 * MiB ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.index) ||
    !Number.isSafeInteger(value.total) ||
    value.index <= 0 ||
    value.index >= value.total
  )
    throw new Error("invalid base cursor");
  return value;
}

/** A selected tab owns a read grant, never a caller supplied storage root or an arbitrary Session. */
export class MobileOutputRecovery {
  private readonly bindings = new Map<string, Binding>();
  private activeReads = 0;
  private activeBaseReads = 0;
  private readonly readingViewers = new Set<string>();
  private readonly pendingMirrors = new Set<Binding>();
  private activeMirrors = 0;
  /** One bounded display projection; raw bytes and authority are still verified on every page. */
  private legacyProjection?: {
    binding: Binding;
    key: string;
    events: ReturnType<typeof transcriptToStreamEvents>;
    sizes: number[];
  };
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
    if (old) {
      if (this.legacyProjection?.binding === old) this.legacyProjection = undefined;
      this.pendingMirrors.delete(old);
      old.cursorKey.fill(0);
    }
    this.bindings.delete(viewerId);
  }

  /** A confirmed checkpoint invalidates every old viewer proof for this Session. */
  revokeSession(sessionId: string): void {
    for (const [viewerId, binding] of this.bindings)
      if (binding.sessionId === sessionId) this.revoke(viewerId);
  }

  private projectLegacyBase(events: Parameters<typeof transcriptToStreamEvents>[0]) {
    const projected = transcriptToStreamEvents(events);
    return {
      events: projected,
      sizes: projected.map((event) => Buffer.byteLength(JSON.stringify(event))),
    };
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
          ...(snapshot?.historicalGap ? { historicalGap: true as const } : {}),
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
        cursorKey: randomBytes(32),
      };
      if (this.bindings.size >= 128) {
        this.deps.reply(viewer, {
          type: "session.recovery.ready",
          sessionId: event.sessionId,
          recoveryId: event.recoveryId,
          ok: false,
        });
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
    if (event.type === "session.legacyBase") return this.readBase(event);
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
    if (!valid()) {
      reply({});
      return false;
    }
    if (this.readingViewers.has(viewer) || this.activeReads >= 8) {
      reply({ busy: true });
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
        maxFrames: event.maxFrames,
      });
      const base =
        page.status === "ok" && event.after === undefined
          ? // Preserve the original small inline fast path, including its raw budget.
            readOutputJournalLegacyBase(root, event.sessionId, page.legacyBaseThroughEventId, {
              maxBytes: 1024 * 1024,
            })
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
      let legacyBaseComplete = base?.complete;
      if (legacyBase && Buffer.byteLength(JSON.stringify(legacyBase)) > MiB) {
        legacyBase.events = [];
        legacyBaseComplete = false;
      }
      reply({
        page,
        ...(base ? { legacyBase, legacyBaseComplete } : {}),
        snapshot: {
          epoch: snapshot.epoch,
          nextSeq: snapshot.nextSeq,
          outputCursor: snapshot.outputCursor,
          unpaired: snapshot.outputUnpaired === true,
          ...(snapshot.historicalGap ? { historicalGap: true as const } : {}),
          ...(snapshot.outputInputIds ? { inputIds: snapshot.outputInputIds } : {}),
          ...(snapshot.outputCoverageIdentity
            ? { incarnation: snapshot.outputCoverageIdentity }
            : {}),
          ...(snapshot.outputJournalIdentity
            ? { journalIdentity: snapshot.outputJournalIdentity }
            : {}),
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

  private async readBase(event: BaseRequest): Promise<boolean> {
    const viewer = event.viewerId!;
    const binding = this.bindings.get(viewer);
    const valid = () =>
      binding &&
      this.bindings.get(viewer) === binding &&
      binding.deviceId === event.deviceId &&
      (!this.deps.authenticated || this.deps.authenticated(viewer, event.deviceId!)) &&
      binding.sessionId === event.sessionId &&
      binding.recoveryId === event.recoveryId &&
      binding.authority !== undefined;
    const envelope = {
      type: "session.legacyBase" as const,
      sessionId: event.sessionId,
      recoveryId: event.recoveryId,
      requestId: event.requestId,
    };
    const fail = (reason: "busy" | "incomplete") =>
      this.deps.reply(viewer, { ...envelope, ok: false, reason });
    if (
      !valid() ||
      !boundedText(event.sessionId, 128) ||
      !boundedText(event.recoveryId, 128) ||
      !boundedText(event.requestId, 128) ||
      !(
        (boundedText(event.throughEventId, 512) && event.cursor === undefined) ||
        (boundedText(event.cursor, 2048) && event.throughEventId === undefined)
      )
    ) {
      fail("incomplete");
      return false;
    }
    // No queue or raw transcript cache: one large read globally, sharing the
    // existing per-viewer and eight-global slots with ordinary journal reads.
    if (this.readingViewers.has(viewer) || this.activeReads >= 8 || this.activeBaseReads >= 1) {
      fail("busy");
      return false;
    }
    this.readingViewers.add(viewer);
    this.activeReads++;
    this.activeBaseReads++;
    if (this.legacyProjection?.binding !== binding) this.legacyProjection = undefined;
    try {
      if (
        !valid() ||
        (await this.deps.authority(event.sessionId)) !== binding!.authority ||
        !valid()
      )
        throw new Error("read grant revoked");
      const cursor = event.cursor ? decodeBaseCursor(event.cursor, binding!) : undefined;
      const throughEventId = cursor?.throughEventId ?? event.throughEventId!;
      const root = this.deps.root();
      const journal = readOutputJournal(root, event.sessionId, { maxFrames: 1 });
      if (journal.status !== "ok" || journal.legacyBaseThroughEventId !== throughEventId)
        throw new Error("base is not the journal cutover");
      const base = readOutputJournalLegacyBase(root, event.sessionId, throughEventId);
      if (
        !base.complete ||
        !base.identity ||
        (cursor &&
          (base.identity.endOffset !== cursor.endOffset || base.identity.sha256 !== cursor.sha256))
      )
        throw new Error("base identity changed");
      const key = JSON.stringify([
        root,
        binding!.sessionId,
        binding!.recoveryId,
        binding!.authority,
        journal.coverageIdentity,
        journal.coverageStart,
        throughEventId,
        base.identity.endOffset,
        base.identity.sha256,
      ]);
      if (this.legacyProjection?.key !== key) this.legacyProjection = undefined;
      // Tool pre-scan and cross-record state still use the complete verified base.
      // A cache hit skips only projection/serialization, never the raw hash checks above.
      const projection = this.legacyProjection ?? this.projectLegacyBase(base.events);
      const { events, sizes } = projection;
      if (
        !events.length ||
        events[0].type !== "session_started" ||
        events.slice(1).some((event) => event.type === "session_started") ||
        (cursor && cursor.total !== events.length)
      )
        throw new Error("base projection changed");
      if (sizes.some((size) => size + 2 > BASE_PAGE_BYTES))
        throw new Error("base event exceeds its bound");
      const index = cursor?.index ?? 0;
      let end = index,
        bytes = 2;
      while (end < events.length && bytes + sizes[end] + (end > index ? 1 : 0) <= BASE_PAGE_BYTES) {
        bytes += sizes[end] + (end > index ? 1 : 0);
        end++;
      }
      if (end === index) throw new Error("base page made no progress");
      const reply: BaseReply = {
        ...envelope,
        ok: true,
        throughEventId,
        index,
        events: events.slice(index, end),
        ...(end === events.length
          ? { complete: true as const }
          : {
              complete: false as const,
              next: encodeBaseCursor(
                {
                  v: 1,
                  sessionId: event.sessionId,
                  recoveryId: event.recoveryId,
                  throughEventId,
                  ...base.identity,
                  index: end,
                  total: events.length,
                },
                binding!.cursorKey,
              ),
            }),
      };
      if (Buffer.byteLength(JSON.stringify(reply)) > MiB)
        throw new Error("base reply exceeds its bound");
      if ((await this.deps.authority(event.sessionId)) !== binding!.authority || !valid())
        throw new Error("read grant revoked");
      // Never install a cache after an awaited revocation; the final page releases it.
      this.legacyProjection =
        !reply.complete &&
        events.length <= 20_000 &&
        sizes.reduce((sum, size) => sum + size + 1, 2) <= 16 * MiB
          ? { binding: binding!, key, events, sizes }
          : undefined;
      this.deps.reply(viewer, reply);
    } catch {
      if (this.legacyProjection?.binding === binding) this.legacyProjection = undefined;
      fail("incomplete");
    } finally {
      this.readingViewers.delete(viewer);
      this.activeReads--;
      this.activeBaseReads--;
    }
    return false;
  }
}
