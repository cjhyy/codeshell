import { dlog } from "../desktop-logger.js";
import {
  quarantineCorruptJson,
  readBoundedJson,
  writeOwnerJsonAtomic,
} from "./bounded-json-store.js";

/**
 * What the briefs and the heartbeat remember between runs
 * (`<userData>/pet/proactive.json`): when each brief last went out (so the
 * next one starts there, and one already sent today is not sent again), and
 * the heartbeat's cursor and daily counts. The counts are durable so a
 * restart never resets the daily caps.
 *
 * Desktop main is the only writer; writes are serialised in-process and
 * atomic. A file this build cannot read is moved aside and starts empty.
 */

export const HEARTBEAT_JUDGE_CAP = 8;
export const HEARTBEAT_SAY_CAP = 4;
/** Fact keys the heartbeat already judged (bounded; oldest dropped first). */
export const HEARTBEAT_SEEN_MAX = 200;
const SCHEMA_VERSION = 1;
const MAX_BYTES = 256 * 1024;
const DAY_MS = 24 * 60 * 60_000;

export type BriefKind = "morning" | "evening";

export interface BriefMark {
  /** When it was sent (epoch ms): the next brief of that kind collects from here. */
  sentAt: number;
  /** The owner's local day it was sent on (see {@link localDayIndex}). */
  day: number;
}

export interface HeartbeatState {
  /** Facts are new when they appeared after this (the last heartbeat that judged or found none). */
  lastAt?: number;
  /** The local day `judged` and `said` count. */
  day?: number;
  judged: number;
  said: number;
  /** Keys of facts already judged, so a fact is weighed once. */
  seen: string[];
}

export interface PetProactiveState {
  briefs: Partial<Record<BriefKind, BriefMark>>;
  heartbeat: HeartbeatState;
}

/** Index of the owner's local day containing `ms` (offset east of UTC, minutes). */
export function localDayIndex(ms: number, offsetMin: number): number {
  return Math.floor((ms + Math.trunc(offsetMin) * 60_000) / DAY_MS);
}

/** The first instant of a local day index. */
export function localDayStart(day: number, offsetMin: number): number {
  return day * DAY_MS - Math.trunc(offsetMin) * 60_000;
}

function emptyState(): PetProactiveState {
  return { briefs: {}, heartbeat: { judged: 0, said: 0, seen: [] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDay(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function parseMark(value: unknown): BriefMark | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["sentAt", "day"])) return undefined;
  return isCount(value.sentAt) && isDay(value.day) ? (value as unknown as BriefMark) : undefined;
}

/** Strict: anything off and the whole file is unreadable (it is small and host-written). */
export function parseProactiveState(value: unknown): PetProactiveState | undefined {
  if (!isRecord(value) || value.version !== SCHEMA_VERSION) return undefined;
  if (!hasOnlyKeys(value, ["version", "briefs", "heartbeat"])) return undefined;
  const { briefs, heartbeat } = value;
  if (!isRecord(briefs) || !hasOnlyKeys(briefs, ["morning", "evening"])) return undefined;
  for (const mark of Object.values(briefs)) if (!parseMark(mark)) return undefined;
  if (
    !isRecord(heartbeat) ||
    !hasOnlyKeys(heartbeat, ["lastAt", "day", "judged", "said", "seen"]) ||
    (heartbeat.lastAt !== undefined && !isCount(heartbeat.lastAt)) ||
    (heartbeat.day !== undefined && !isDay(heartbeat.day)) ||
    !isCount(heartbeat.judged) ||
    !isCount(heartbeat.said) ||
    !Array.isArray(heartbeat.seen) ||
    heartbeat.seen.length > HEARTBEAT_SEEN_MAX ||
    !heartbeat.seen.every((key) => typeof key === "string" && key.length > 0 && key.length <= 300)
  )
    return undefined;
  return { briefs, heartbeat } as unknown as PetProactiveState;
}

export class PetProactiveStateStore {
  private state: PetProactiveState = emptyState();
  private loadPromise?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  load(): Promise<void> {
    if (!this.loadPromise) {
      const attempt = this.loadFromDisk().catch((error) => {
        if (this.loadPromise === attempt) this.loadPromise = undefined;
        throw error;
      });
      this.loadPromise = attempt;
    }
    return this.loadPromise;
  }

  get(): PetProactiveState {
    return structuredClone(this.state);
  }

  /** Change the state and persist it before resolving; a failed write changes nothing. */
  update(change: (draft: PetProactiveState) => void): Promise<PetProactiveState> {
    const run = this.queue
      .catch(() => undefined)
      .then(() => this.load())
      .then(async () => {
        const draft = structuredClone(this.state);
        change(draft);
        draft.heartbeat.seen = draft.heartbeat.seen.slice(-HEARTBEAT_SEEN_MAX);
        if (!parseProactiveState({ version: SCHEMA_VERSION, ...draft }))
          throw new Error("invalid proactive state");
        await writeOwnerJsonAtomic(this.path, { version: SCHEMA_VERSION, ...draft }, MAX_BYTES, {
          compact: true,
        });
        this.state = draft;
        return structuredClone(draft);
      });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async loadFromDisk(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = await readBoundedJson(this.path, MAX_BYTES);
    } catch (error) {
      await this.reset("pet.proactive.state_unreadable", String(error));
      return;
    }
    if (parsed === undefined) {
      this.state = emptyState();
      return;
    }
    const state = parseProactiveState(parsed);
    if (!state) {
      await this.reset("pet.proactive.state_invalid");
      return;
    }
    this.state = state;
  }

  private async reset(event: string, error?: string): Promise<void> {
    const moved = await quarantineCorruptJson(this.path).catch(() => undefined);
    dlog("main", event, {
      ...(error ? { error } : {}),
      ...(moved ? { quarantinePath: moved } : {}),
    });
    this.state = emptyState();
  }
}

/** The heartbeat's counts for `day`, reset when the local day changed. */
export function heartbeatToday(state: HeartbeatState, day: number): HeartbeatState {
  return state.day === day ? state : { ...state, day, judged: 0, said: 0 };
}
