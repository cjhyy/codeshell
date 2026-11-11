import { createHash } from "node:crypto";
import type { NoticeChannel } from "@cjhyy/code-shell-pet/protocol";
import { composeDigestBody, type NoticeFacts } from "./pet-notice-compose.js";
import type { NoticeRecord, NoticeSettleStatus, PetNoticeLedger } from "./pet-notice-ledger.js";
import {
  isInQuietHours,
  isOwnerTimedKind,
  localHourIndex,
  localMinuteOfDay,
  type RouteDecision,
  type RouteState,
} from "./pet-notice-policy.js";
import { errorText, targetKey, type NoticeTarget } from "./pet-notice-types.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** setTimeout's ceiling; a longer wait is re-armed when the timer fires. */
const MAX_TIMER_MS = 2_147_483_647;
/** Hold reasons that only bundle; others (quiet hours, caps) clear when sending is allowed. */
const BUNDLING_REASONS: ReadonlySet<string> = new Set(["merge-window", "digest-attention"]);

/**
 * A digest the router recorded (its own record may be held, then superseded):
 * the owner's ordinary digest, or a bundle of follow-ups (kind `followup.due`).
 */
function isDigestRecord(record: NoticeRecord): boolean {
  return record.kind === "digest" || record.dedupeKey.startsWith("digest:");
}

/** Held follow-ups the owner timed: they wait for the P0 backstop only, never for quiet hours. */
function isTimed(record: NoticeRecord): boolean {
  return isOwnerTimedKind(record.kind);
}

/** Dedupe key of one digest: its local hour plus the exact member set. */
export function digestDedupeKey(hourIndex: number, memberIds: readonly string[]): string {
  const hash = createHash("sha256")
    .update([...memberIds].sort().join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  return `digest:${hourIndex}:${hash}`;
}

/**
 * Earliest instant a P2 digest could be sent, given what blocks it now.
 * Only quiet hours and the hourly cap delay a P2; anything else is "now".
 */
export function nextSendAllowedAt(
  state: Pick<
    RouteState,
    "now" | "quietHours" | "timezoneOffsetMin" | "sentThisHour" | "maxPerHour"
  >,
): number {
  const { now, quietHours, timezoneOffsetMin } = state;
  if (quietHours && isInQuietHours(quietHours, now, timezoneOffsetMin)) {
    const [hours, minutes] = quietHours.end.split(":").map(Number);
    const endMinute = hours! * 60 + minutes!;
    const minute = localMinuteOfDay(now, timezoneOffsetMin);
    const delta = (endMinute - minute + 24 * 60) % (24 * 60) || 24 * 60;
    return Math.floor(now / MINUTE) * MINUTE + delta * MINUTE;
  }
  if (state.sentThisHour >= state.maxPerHour) {
    const nextHour = localHourIndex(now, timezoneOffsetMin) + 1;
    return nextHour * HOUR - Math.trunc(timezoneOffsetMin) * MINUTE;
  }
  return now;
}

/**
 * When to flush the held notices: once sending is allowed, and not before
 * the earliest bundling-only hold has had its merge window to collect
 * company. Undefined when nothing is held.
 */
export function digestFlushAt(
  held: readonly NoticeRecord[],
  allowedAt: number,
  mergeWindowMs: number,
): number | undefined {
  if (held.length === 0) return undefined;
  let ready = Number.POSITIVE_INFINITY;
  for (const record of held) {
    const bundling = BUNDLING_REASONS.has(record.decision?.reason ?? "");
    ready = Math.min(ready, bundling ? record.createdAt + mergeWindowMs : 0);
  }
  return Math.max(allowedAt, ready);
}

export interface DigestTimerOptions {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (timer: unknown) => void;
  onFire: () => void;
}

/** One pending digest flush; re-arming keeps the earliest requested time. */
export class DigestTimer {
  private timer: unknown;
  private at: number | undefined;
  private disposed = false;

  constructor(private readonly options: DigestTimerOptions) {}

  /** The instant the pending flush is due, if one is armed. */
  get dueAt(): number | undefined {
    return this.at;
  }

  arm(at: number): void {
    if (this.disposed) return;
    if (this.at !== undefined && this.at <= at) return;
    this.cancel();
    this.at = at;
    const delay = Math.min(Math.max(0, at - this.options.now()), MAX_TIMER_MS);
    const timer = this.options.setTimeout(() => {
      if (this.timer !== timer) return;
      this.timer = undefined;
      this.at = undefined;
      this.options.onFire();
    }, delay);
    // A pending digest must never keep the process alive.
    (timer as { unref?: () => void } | undefined)?.unref?.();
    this.timer = timer;
  }

  cancel(): void {
    if (this.timer !== undefined) this.options.clearTimeout(this.timer);
    this.timer = undefined;
    this.at = undefined;
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }
}

export interface NoticeDigestOptions {
  ledger: Pick<PetNoticeLedger, "load" | "held" | "countsThisHour">;
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (timer: unknown) => void;
  /** Current settings sampled at `now`. */
  window: (now: number) => {
    quietHours: RouteState["quietHours"];
    maxPerHour: number;
    maxP0PerHour: number;
    mergeWindowMs: number;
    timezoneOffsetMin: number;
  };
  /** A held record's facts, stored target and the channel it asked for (absent: auto). */
  unpack: (record: NoticeRecord) => {
    facts: NoticeFacts;
    target: NoticeTarget;
    channel?: NoticeChannel;
  };
  /**
   * Route one digest to `target` on `channel`: an ordinary P2 digest, or
   * (`timed`) a bundle of follow-ups the owner timed, routed like them.
   */
  submit: (digest: {
    target: NoticeTarget;
    channel: NoticeChannel;
    dedupeKey: string;
    ruleIds: string[];
    body: string;
    count: number;
    timed: boolean;
  }) => Promise<RouteDecision>;
  /** Why a held notice should no longer be sent (see `staleReason`); undefined keeps it. */
  stale?: (record: NoticeRecord, now: number) => string | undefined;
  /** Settle without throwing. */
  settle: (id: string, status: NoticeSettleStatus, error: string) => Promise<void>;
  log: (event: string, data: Record<string, unknown>) => void;
}

const MAX_DIGEST_RULE_IDS = 100;

/**
 * Bundles the held notices into one digest, sent at the next moment sending
 * is allowed (quiet hours over, next hour after the cap, merge window
 * passed). Members are revoked as "digested" only once the digest itself
 * was routed somewhere other than the digest.
 */
export class NoticeDigest {
  private readonly timer: DigestTimer;
  private run: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: NoticeDigestOptions) {
    this.timer = new DigestTimer({
      now: options.now,
      setTimeout: options.setTimeout,
      clearTimeout: options.clearTimeout,
      onFire: () => void this.flush(),
    });
  }

  /** Arm the flush for the current held set; a no-op when nothing is held. */
  schedule(): void {
    if (this.disposed) return;
    try {
      const at = this.flushAt(this.options.ledger.held(), this.options.now());
      if (at !== undefined) this.timer.arm(at);
    } catch (error) {
      this.options.log("pet.notice.digest_schedule_failed", { error: errorText(error) });
    }
  }

  /** Serialised: concurrent flushes run one after another. */
  flush(): Promise<void> {
    const run = this.run
      .then(() => this.flushNow())
      .catch((error) => this.options.log("pet.notice.digest_failed", { error: errorText(error) }));
    this.run = run;
    return run;
  }

  dispose(): void {
    this.disposed = true;
    this.timer.dispose();
  }

  /** When the held follow-ups / the other held notices may be bundled and sent. */
  private flushTimes(
    held: readonly NoticeRecord[],
    now: number,
  ): { timed: number | undefined; regular: number | undefined } {
    const window = this.options.window(now);
    const counts = this.options.ledger.countsThisHour(now);
    const timed = held.filter(isTimed);
    const regular = held.filter((record) => !isTimed(record));
    const allowedAt = nextSendAllowedAt({
      now,
      quietHours: window.quietHours,
      timezoneOffsetMin: window.timezoneOffsetMin,
      sentThisHour: counts.sent,
      maxPerHour: window.maxPerHour,
    });
    // Follow-ups were held only by the P0 backstop: they go once it has room.
    const nextHour =
      (localHourIndex(now, window.timezoneOffsetMin) + 1) * HOUR -
      Math.trunc(window.timezoneOffsetMin) * MINUTE;
    return {
      timed: timed.length === 0 ? undefined : counts.p0Sent < window.maxP0PerHour ? now : nextHour,
      regular: digestFlushAt(regular, allowedAt, window.mergeWindowMs),
    };
  }

  private flushAt(held: readonly NoticeRecord[], now: number): number | undefined {
    const { timed, regular } = this.flushTimes(held, now);
    if (timed === undefined) return regular;
    return regular === undefined ? timed : Math.min(timed, regular);
  }

  private async flushNow(): Promise<void> {
    if (this.disposed) return;
    await this.options.ledger.load();
    const held = this.options.ledger.held();
    // A digest that was itself held (a race with the cap) is superseded by this one.
    for (const record of held)
      if (isDigestRecord(record)) await this.options.settle(record.id, "revoked", "superseded");
    const now = this.options.now();
    const candidates: NoticeRecord[] = [];
    for (const record of held) {
      if (isDigestRecord(record)) continue;
      const stale = this.options.stale?.(record, now);
      if (stale) await this.options.settle(record.id, "revoked", stale);
      else candidates.push(record);
    }
    const times = this.flushTimes(candidates, now);
    const ready = (record: NoticeRecord) => {
      const at = isTimed(record) ? times.timed : times.regular;
      return at !== undefined && at <= now;
    };
    const members = candidates.filter(ready);
    const later = [times.timed, times.regular].filter(
      (at): at is number => at !== undefined && at > now,
    );
    if (later.length > 0) this.timer.arm(Math.min(...later));
    if (members.length === 0) return;
    // One digest per destination: the owner's, and one per IM conversation a
    // held notice came from, so a group-chat notice is never rerouted to the
    // owner; and per channel asked for, so a named IM (or desktop only) is kept.
    // Follow-ups are bundled apart: their digest is routed like a follow-up.
    const groups = new Map<
      string,
      { target: NoticeTarget; channel: NoticeChannel; members: NoticeRecord[]; timed: boolean }
    >();
    for (const record of members) {
      const { target, channel = "auto" } = this.options.unpack(record);
      const timed = isTimed(record);
      const key = JSON.stringify([targetKey(target), channel, timed]);
      const group = groups.get(key) ?? { target, channel, members: [], timed };
      group.members.push(record);
      groups.set(key, group);
    }
    const hour = localHourIndex(now, this.options.window(now).timezoneOffsetMin);
    for (const group of groups.values()) await this.send(group, hour);
  }

  private async send(
    {
      target,
      channel,
      members,
      timed,
    }: { target: NoticeTarget; channel: NoticeChannel; members: NoticeRecord[]; timed: boolean },
    hour: number,
  ): Promise<void> {
    const ids = members.map((record) => record.id);
    const decision = await this.options.submit({
      target,
      channel,
      dedupeKey: digestDedupeKey(hour, ids),
      ruleIds: [...new Set(members.flatMap((record) => record.ruleIds))].slice(
        0,
        MAX_DIGEST_RULE_IDS,
      ),
      body: composeDigestBody(
        members.map((record) => ({ kind: record.kind, facts: this.options.unpack(record).facts })),
        timed ? "到点的跟进：" : undefined,
      ),
      count: members.length,
      timed,
    });
    // Held again (the cap was reached meanwhile): keep the members for the next flush.
    if (decision.outlet === "digest") return;
    for (const id of ids) await this.options.settle(id, "revoked", "digested");
  }
}
