/**
 * Bucket-aware registry for browser-panel <webview> guests.
 *
 * Renderer browser panels already use per-chat-session partitions
 * (`persist:browser:<bucket>`). Automation must target the same bucket that
 * owns the originating engine session, never the most recently focused global
 * guest. The legacy all-guest helpers remain for explicit all-session UI
 * features such as "capture cookies from all live browser sessions".
 */

import type { Session, WebContents } from "electron";

const BROWSER_PARTITION_PREFIX = "persist:browser";
const LEGACY_BUCKET = "__legacy__";

export type BrowserBucket = string;
export type BrowserPartition = string;

export interface GuestRecord {
  guest: WebContents;
  guestId: number;
  bucket: BrowserBucket;
  partition: BrowserPartition;
  engineSessionId?: string;
  windowId?: number;
  attachedAt: number;
  lastFocusedAt: number;
  source: "panel" | "popout";
}

export interface RegisterGuestInput {
  guest: WebContents;
  bucket: BrowserBucket;
  partition: BrowserPartition;
  engineSessionId?: string;
  windowId?: number;
  source?: "panel" | "popout";
}

export interface PendingAttachedGuestInput {
  guest: WebContents;
  windowId: number;
  partition: BrowserPartition;
}

export interface RegisterAttachedGuestMetadataInput {
  guestId: number;
  windowId: number;
  bucket: BrowserBucket;
  partition: BrowserPartition;
  engineSessionId?: string;
  source?: "panel" | "popout";
}

export interface GuestTarget {
  guest: WebContents;
  bucket: BrowserBucket;
  partition: BrowserPartition;
  guestId: number;
}

/** One browser tab as the agent sees it. tabId is the webContents.id (string). */
export interface GuestTab {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
}

const byGuestId = new Map<number, GuestRecord>();
const guestIdsByBucket = new Map<BrowserBucket, Set<number>>();
const activeGuestIdByBucket = new Map<BrowserBucket, number>();
const bucketBySessionId = new Map<string, BrowserBucket>();
const partitionByBucket = new Map<BrowserBucket, BrowserPartition>();
const wiredGuestIds = new Set<number>();
const pendingAttachedGuests = new Map<
  number,
  {
    guest: WebContents;
    guestId: number;
    windowId: number;
    partition: BrowserPartition;
    attachedAt: number;
  }
>();

export function sanitizeBrowserBucket(bucket: string): string {
  return bucket.replace(/[^a-zA-Z0-9_:.@-]/g, "_");
}

export function browserPartitionForBucket(bucket: string): BrowserPartition {
  return `${BROWSER_PARTITION_PREFIX}:${sanitizeBrowserBucket(bucket)}`;
}

export function registerSessionBucket(
  sessionId: string,
  bucket: BrowserBucket,
  partition: BrowserPartition = browserPartitionForBucket(bucket),
): void {
  if (!sessionId || !bucket) throw new Error("registerSessionBucket requires sessionId and bucket");
  assertExpectedPartition(bucket, partition);
  bucketBySessionId.set(sessionId, bucket);
  partitionByBucket.set(bucket, partition);
}

export function rememberAttachedGuest(input: PendingAttachedGuestInput): void {
  if (!input.windowId || !input.partition) {
    throw new Error("rememberAttachedGuest requires windowId and partition");
  }
  const guestId = input.guest.id;
  pendingAttachedGuests.set(guestId, {
    guest: input.guest,
    guestId,
    windowId: input.windowId,
    partition: input.partition,
    attachedAt: Date.now(),
  });
  input.guest.once("destroyed", () => {
    pendingAttachedGuests.delete(guestId);
  });
}

export function registerAttachedGuestMetadata(input: RegisterAttachedGuestMetadataInput): void {
  if (!Number.isFinite(input.guestId) || !input.bucket || !input.partition || !input.windowId) {
    throw new Error("registerAttachedGuestMetadata requires guestId/windowId/bucket/partition");
  }
  assertExpectedPartition(input.bucket, input.partition);

  const pending = pendingAttachedGuests.get(input.guestId);
  if (!pending) {
    const existing = liveRecord(input.guestId);
    if (
      existing &&
      existing.windowId === input.windowId &&
      existing.bucket === input.bucket &&
      existing.partition === input.partition
    ) {
      assertSessionMetadata(input.engineSessionId, input.bucket);
      return;
    }
    throw new Error(`browser guest ${input.guestId} was not attached by this window`);
  }
  if (pending.windowId !== input.windowId) {
    throw new Error(`browser guest ${input.guestId} belongs to a different window`);
  }
  if (pending.partition !== input.partition) {
    throw new Error(
      `browser guest ${input.guestId} partition mismatch: expected ${pending.partition}`,
    );
  }
  if (safe(() => pending.guest.isDestroyed()) === true) {
    pendingAttachedGuests.delete(input.guestId);
    throw new Error(`browser guest ${input.guestId} is destroyed`);
  }

  assertSessionMetadata(input.engineSessionId, input.bucket);
  const engineSessionId =
    input.engineSessionId && bucketBySessionId.get(input.engineSessionId) === input.bucket
      ? input.engineSessionId
      : undefined;
  registerGuest({
    guest: pending.guest,
    bucket: input.bucket,
    partition: input.partition,
    engineSessionId,
    windowId: input.windowId,
    source: input.source ?? "panel",
  });
  pendingAttachedGuests.delete(input.guestId);
}

/** Register a freshly-attached guest with renderer-provided bucket metadata. */
export function registerGuest(input: RegisterGuestInput): void;
/** Legacy compatibility: registers into an isolated legacy bucket. */
export function registerGuest(guest: WebContents): void;
export function registerGuest(input: RegisterGuestInput | WebContents): void {
  const normalized =
    "guest" in input
      ? input
      : ({
          guest: input,
          bucket: LEGACY_BUCKET,
          partition: browserPartitionForBucket(LEGACY_BUCKET),
          source: "panel" as const,
        } satisfies RegisterGuestInput);

  const { guest, bucket, partition } = normalized;
  if (!bucket) throw new Error("registerGuest requires bucket");
  assertExpectedPartition(bucket, partition);

  const guestId = guest.id;
  removeGuestId(guestId);
  const now = Date.now();
  const record: GuestRecord = {
    guest,
    guestId,
    bucket,
    partition,
    engineSessionId: normalized.engineSessionId,
    windowId: normalized.windowId,
    attachedAt: now,
    lastFocusedAt: now,
    source: normalized.source ?? "panel",
  };

  byGuestId.set(guestId, record);
  let ids = guestIdsByBucket.get(bucket);
  if (!ids) {
    ids = new Set();
    guestIdsByBucket.set(bucket, ids);
  }
  ids.add(guestId);
  activeGuestIdByBucket.set(bucket, guestId);
  partitionByBucket.set(bucket, partition);
  if (record.engineSessionId) bucketBySessionId.set(record.engineSessionId, bucket);
  wireGuest(record.guest);
}

/** The active automation target for a bucket, or null when none is live. */
export function activeGuestForBucket(bucket: BrowserBucket): GuestTarget | null {
  const id = activeGuestIdByBucket.get(bucket);
  const active = id === undefined ? null : liveRecord(id);
  if (active && active.bucket === bucket) return targetFromRecord(active);

  const fallback = mostRecentLiveRecordForBucket(bucket);
  if (!fallback) {
    activeGuestIdByBucket.delete(bucket);
    return null;
  }
  activeGuestIdByBucket.set(bucket, fallback.guestId);
  return targetFromRecord(fallback);
}

export function activeGuestForSession(sessionId: string | undefined): GuestTarget | null {
  if (!sessionId) return null;
  const bucket = bucketBySessionId.get(sessionId);
  return bucket ? activeGuestForBucket(bucket) : null;
}

export function bucketForSession(sessionId: string | undefined): BrowserBucket | null {
  if (!sessionId) return null;
  return bucketBySessionId.get(sessionId) ?? null;
}

export function bucketForGuestId(guestId: number): BrowserBucket | null {
  return liveRecord(guestId)?.bucket ?? null;
}

export function guestRecordForId(guestId: number): GuestRecord | null {
  return liveRecord(guestId);
}

export function hasRegisteredBucket(bucket: string | undefined): boolean {
  return typeof bucket === "string" && partitionByBucket.has(bucket);
}

export function partitionForSession(sessionId: string | undefined): BrowserPartition | null {
  const bucket = bucketForSession(sessionId);
  return bucket ? (partitionByBucket.get(bucket) ?? browserPartitionForBucket(bucket)) : null;
}

export function registeredPartitionForBucket(bucket: string | undefined): BrowserPartition | null {
  if (!bucket) return null;
  return partitionByBucket.get(bucket) ?? null;
}

export function listGuestsForBucket(bucket: BrowserBucket): GuestTab[] {
  const cur = activeGuestForBucket(bucket);
  const out: GuestTab[] = [];
  for (const record of recordsForBucket(bucket)) {
    out.push({
      tabId: String(record.guestId),
      url: safe(() => record.guest.getURL()) ?? "",
      title: safe(() => record.guest.getTitle()) ?? "",
      active: cur?.guestId === record.guestId,
    });
  }
  return out;
}

export function listGuestsForSession(sessionId: string | undefined): GuestTab[] {
  const bucket = bucketForSession(sessionId);
  return bucket ? listGuestsForBucket(bucket) : [];
}

/** Make a tab active by focusing it, but only when it belongs to the bucket. */
export function focusGuestForBucket(bucket: BrowserBucket, tabId: string): boolean {
  const id = Number(tabId);
  if (!Number.isFinite(id)) return false;
  const record = liveRecord(id);
  if (!record || record.bucket !== bucket) return false;
  activeGuestIdByBucket.set(bucket, id);
  record.lastFocusedAt = Date.now();
  try {
    record.guest.focus();
  } catch {
    /* focus best-effort; active is already updated */
  }
  return true;
}

export function focusGuestForSession(sessionId: string | undefined, tabId: string): boolean {
  const bucket = bucketForSession(sessionId);
  return bucket ? focusGuestForBucket(bucket, tabId) : false;
}

export function forgetSession(sessionId: string): void {
  bucketBySessionId.delete(sessionId);
}

/** Legacy: current global automation target, kept for non-automation callers/tests. */
export function activeGuest(): WebContents | null {
  const record = mostRecentLiveRecord();
  return record?.guest ?? null;
}

/** Legacy: list all live guest tabs. Automation must use listGuestsForSession. */
export function listGuests(): GuestTab[] {
  const cur = activeGuest();
  const out: GuestTab[] = [];
  for (const record of liveRecords()) {
    out.push({
      tabId: String(record.guestId),
      url: safe(() => record.guest.getURL()) ?? "",
      title: safe(() => record.guest.getTitle()) ?? "",
      active: record.guest === cur,
    });
  }
  return out;
}

/** List distinct Electron sessions backing live browser guests. */
export function listGuestSessions(): Session[] {
  const out: Session[] = [];
  const seen = new Set<Session>();
  for (const record of liveRecords()) {
    const sess = safe(() => record.guest.session);
    if (!sess || seen.has(sess)) continue;
    seen.add(sess);
    out.push(sess);
  }
  return out;
}

/** Resolve a tabId (webContents.id string) back to its live guest, or null. */
export function guestById(tabId: string): WebContents | null {
  const id = Number(tabId);
  if (!Number.isFinite(id)) return null;
  return liveRecord(id)?.guest ?? null;
}

/** Legacy global focus. Automation must use focusGuestForSession. */
export function focusGuest(tabId: string): boolean {
  const id = Number(tabId);
  if (!Number.isFinite(id)) return false;
  const record = liveRecord(id);
  if (!record) return false;
  return focusGuestForBucket(record.bucket, tabId);
}

function assertExpectedPartition(bucket: string, partition: string): void {
  const expected = browserPartitionForBucket(bucket);
  if (partition !== expected) {
    throw new Error(
      `browser guest partition mismatch for bucket "${bucket}": expected ${expected}`,
    );
  }
}

function assertSessionMetadata(sessionId: string | undefined, bucket: string): void {
  if (!sessionId) return;
  const existing = bucketBySessionId.get(sessionId);
  if (existing !== undefined && existing !== bucket) {
    throw new Error(
      `browser session bucket mismatch for session "${sessionId}": expected ${existing}`,
    );
  }
}

function wireGuest(guest: WebContents): void {
  if (wiredGuestIds.has(guest.id)) return;
  wiredGuestIds.add(guest.id);
  guest.once("destroyed", () => {
    removeGuestId(guest.id);
    wiredGuestIds.delete(guest.id);
  });
  guest.on("focus", () => {
    const record = liveRecord(guest.id);
    if (!record) return;
    record.lastFocusedAt = Date.now();
    activeGuestIdByBucket.set(record.bucket, record.guestId);
  });
}

function removeGuestId(guestId: number): void {
  const prev = byGuestId.get(guestId);
  if (!prev) return;
  byGuestId.delete(guestId);
  const ids = guestIdsByBucket.get(prev.bucket);
  ids?.delete(guestId);
  if (ids && ids.size === 0) guestIdsByBucket.delete(prev.bucket);
  if (activeGuestIdByBucket.get(prev.bucket) === guestId) {
    const fallback = mostRecentLiveRecordForBucket(prev.bucket);
    if (fallback) activeGuestIdByBucket.set(prev.bucket, fallback.guestId);
    else activeGuestIdByBucket.delete(prev.bucket);
  }
}

function targetFromRecord(record: GuestRecord): GuestTarget {
  return {
    guest: record.guest,
    bucket: record.bucket,
    partition: record.partition,
    guestId: record.guestId,
  };
}

function liveRecord(guestId: number): GuestRecord | null {
  const record = byGuestId.get(guestId);
  if (!record) return null;
  if (safe(() => record.guest.isDestroyed()) === true) {
    removeGuestId(guestId);
    return null;
  }
  return record;
}

function* liveRecords(): Iterable<GuestRecord> {
  for (const id of [...byGuestId.keys()]) {
    const record = liveRecord(id);
    if (record) yield record;
  }
}

function recordsForBucket(bucket: string): GuestRecord[] {
  const ids = guestIdsByBucket.get(bucket);
  if (!ids) return [];
  const out: GuestRecord[] = [];
  for (const id of [...ids]) {
    const record = liveRecord(id);
    if (record && record.bucket === bucket) out.push(record);
  }
  return out.sort((a, b) => a.attachedAt - b.attachedAt);
}

function mostRecentLiveRecordForBucket(bucket: string): GuestRecord | null {
  let best: GuestRecord | null = null;
  for (const record of recordsForBucket(bucket)) {
    if (!best || record.lastFocusedAt >= best.lastFocusedAt) best = record;
  }
  return best;
}

function mostRecentLiveRecord(): GuestRecord | null {
  let best: GuestRecord | null = null;
  for (const record of liveRecords()) {
    if (!best || record.lastFocusedAt >= best.lastFocusedAt) best = record;
  }
  return best;
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Test/teardown helper. */
export function _resetGuests(): void {
  byGuestId.clear();
  guestIdsByBucket.clear();
  activeGuestIdByBucket.clear();
  bucketBySessionId.clear();
  partitionByBucket.clear();
  wiredGuestIds.clear();
  pendingAttachedGuests.clear();
}
