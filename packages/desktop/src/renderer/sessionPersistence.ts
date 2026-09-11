import type {
  SessionCatalogPatch,
  SessionCatalogApi,
  SessionCatalogSnapshot,
  SessionIndex,
  SessionSummary,
} from "../shared/session-catalog";

export type SessionPersistenceBridge = SessionCatalogApi;

const LEGACY_INDEX_PREFIX = "codeshell.sessionIndex.";
const EMPTY_INDEX: SessionIndex = { sessions: [], activeSessionId: null };
const MAX_LEGACY_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MEMORY_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MEMORY_SNAPSHOT_COUNT = 20;

function snapshotMetadata(value: string): { evictable: boolean } {
  if (new TextEncoder().encode(value).byteLength > MAX_LEGACY_SNAPSHOT_BYTES)
    throw new Error("Legacy conversation snapshot exceeds 128 MiB");
  const state = JSON.parse(value) as Record<string, any>;
  const safeRecord = (record: unknown): record is Record<string, any> =>
    !!record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    !Object.keys(record).some((key) => ["__proto__", "prototype", "constructor"].includes(key));
  if (!safeRecord(state) || !Array.isArray(state.messages))
    throw new Error("Invalid legacy conversation snapshot");
  if (
    state.messages.some(
      (message: unknown) =>
        !safeRecord(message) ||
        typeof message.id !== "string" ||
        !message.id ||
        typeof message.kind !== "string",
    )
  )
    throw new Error("Invalid legacy conversation message");
  return {
    evictable:
      !state.streamingAssistantId &&
      !state.streamingThinkingId &&
      Object.keys(state.activeAgents ?? {}).length === 0 &&
      !state.messages.some(
        (message: Record<string, any>) =>
          message.pending ||
          message.done === false ||
          message.status === "running" ||
          message.status === "queued" ||
          (message.kind === "ask_user" && message.answer === undefined),
      ),
  };
}

function transcriptKey(projectKey: string, sessionId: string): string {
  return `codeshell.transcript.${projectKey}.${sessionId}`;
}

function memoryTranscriptKey(projectKey: string, sessionId: string): string {
  return JSON.stringify([projectKey, sessionId]);
}

function projectPatch(
  projectKey: string,
  previous: SessionIndex,
  next: SessionIndex,
): SessionCatalogPatch | undefined {
  const patch: SessionCatalogPatch = { projectKey };
  const before = new Map(previous.sessions.map((session) => [session.id, session]));
  const after = new Set(next.sessions.map((session) => session.id));
  const upserts: NonNullable<SessionCatalogPatch["upserts"]> = [];
  for (const session of next.sessions) {
    const old = before.get(session.id);
    if (!old) {
      upserts.push({ id: session.id, values: { ...session } });
      continue;
    }
    const values: Partial<SessionSummary> = {};
    const removeFields: Array<keyof SessionSummary> = [];
    for (const field of new Set([...Object.keys(old), ...Object.keys(session)]) as Set<
      keyof SessionSummary
    >) {
      if (field === "id" || old[field] === session[field]) continue;
      if (session[field] === undefined) removeFields.push(field);
      else Object.assign(values, { [field]: session[field] });
    }
    if (Object.keys(values).length || removeFields.length) {
      upserts.push({
        id: session.id,
        values,
        ...(removeFields.length ? { removeFields } : {}),
      });
    }
  }
  if (upserts.length) patch.upserts = upserts;
  const deletedSessionIds = previous.sessions
    .filter((session) => !after.has(session.id))
    .map((session) => session.id);
  if (deletedSessionIds.length) patch.deletedSessionIds = deletedSessionIds;
  if (previous.activeSessionId !== next.activeSessionId)
    patch.activeSessionId = next.activeSessionId;
  if (previous.deletedProjectLabel !== next.deletedProjectLabel)
    patch.deletedProjectLabel = next.deletedProjectLabel ?? null;
  return Object.keys(patch).length > 1 ? patch : undefined;
}

/** Reapply optimistic field edits over a newer canonical snapshot from another window. */
function projectPatchOn(index: SessionIndex, patch: SessionCatalogPatch): SessionIndex {
  const rows = new Map(index.sessions.map((session) => [session.id, { ...session }]));
  for (const upsert of patch.upserts ?? []) {
    if (
      !rows.has(upsert.id) &&
      (typeof upsert.values.title !== "string" ||
        typeof upsert.values.createdAt !== "number" ||
        typeof upsert.values.updatedAt !== "number")
    )
      continue;
    const session = { ...rows.get(upsert.id), ...upsert.values, id: upsert.id } as SessionSummary;
    for (const field of upsert.removeFields ?? []) {
      if (field !== "id") delete session[field];
    }
    rows.set(upsert.id, session);
  }
  for (const sessionId of patch.deletedSessionIds ?? []) rows.delete(sessionId);
  const active =
    patch.activeSessionId !== undefined ? patch.activeSessionId : index.activeSessionId;
  const label =
    patch.deletedProjectLabel !== undefined ? patch.deletedProjectLabel : index.deletedProjectLabel;
  return {
    sessions: [...rows.values()].sort((left, right) => right.updatedAt - left.updatedAt),
    activeSessionId: active && rows.has(active) && !rows.get(active)?.archived ? active : null,
    ...(label ? { deletedProjectLabel: label } : {}),
  };
}

type TranscriptOperation = {
  projectKey: string;
  sessionId: string;
  /** null deletes a renderer snapshot; canonical engine history is a separate store. */
  value: string | null;
  moveToProjectKey?: string;
};

type FlushPhase = "events" | "snapshots";

/** Main owns persistence; this class owns one window's immediate projection and unacknowledged edits. */
export class SessionPersistence {
  private canonical: SessionCatalogSnapshot = { revision: -1, indices: {} };
  private projection: Record<string, SessionIndex> = {};
  private pending: SessionCatalogPatch[] = [];
  private readonly transcriptValues = new Map<
    string,
    {
      value: string | null;
      version: number;
      hasEarlier?: boolean;
      readGeneration?: number;
      evictable?: boolean;
    }
  >();
  private readonly readingTranscripts = new Map<string, number>();
  private transcriptVersion = 0;
  private transcriptReadGeneration = 0;
  private transcriptQueue: TranscriptOperation[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly errorListeners = new Set<(error: unknown) => void>();
  private readonly flushListeners: Record<FlushPhase, Set<() => void>> = {
    events: new Set(),
    snapshots: new Set(),
  };
  private initialization?: Promise<void>;
  private initialized = false;
  private unsubscribe?: () => void;
  private catalogWrite?: Promise<void>;
  private transcriptWrite?: Promise<void>;

  constructor(
    private readonly bridge: SessionPersistenceBridge,
    private readonly storage?: Storage,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    this.canonical.indices = this.legacyIndices();
    this.projection = this.canonical.indices;
  }

  private legacyIndices(): Record<string, SessionIndex> {
    const indices: Record<string, SessionIndex> = {};
    if (!this.storage) return indices;
    for (let index = 0; index < this.storage.length; index += 1) {
      const key = this.storage.key(index);
      if (!key?.startsWith(LEGACY_INDEX_PREFIX)) continue;
      try {
        const parsed = JSON.parse(this.storage.getItem(key) ?? "null") as SessionIndex;
        if (Array.isArray(parsed?.sessions))
          indices[key.slice(LEGACY_INDEX_PREFIX.length)] = parsed;
      } catch {
        // Preserve unreadable entries for recovery; never acknowledge or remove them.
      }
    }
    return indices;
  }

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initialization) return this.initialization;
    this.unsubscribe ??= this.bridge.onChanged((snapshot) => this.acceptSnapshot(snapshot));
    const operation = async () => {
      const legacy = this.legacyIndices();
      const captured = new Map(
        Object.keys(legacy).map((projectKey) => {
          const key = `${LEGACY_INDEX_PREFIX}${projectKey}`;
          return [key, this.storage?.getItem(key)] as const;
        }),
      );
      // Even an empty installation needs the marker that fences stale legacy
      // browsers from later importing their old copy over a newer catalog.
      const snapshot = await this.bridge.importLegacy(legacy);
      this.acceptSnapshot(snapshot);
      for (const [key, value] of captured) {
        if (this.storage && this.storage.getItem(key) === value) this.storage.removeItem(key);
      }
      // Use both catalogs so a restart after index ACK but before all snapshot
      // ACKs can resume migration. Exact keys preserve ids/project names with dots.
      const candidates = new Map<string, { projectKey: string; sessionId: string }>();
      for (const indices of [legacy, snapshot.indices]) {
        for (const [projectKey, index] of Object.entries(indices)) {
          for (const session of index.sessions) {
            candidates.set(transcriptKey(projectKey, session.id), {
              projectKey,
              sessionId: session.id,
            });
          }
        }
      }
      for (const [key, identity] of candidates) {
        const value = this.storage?.getItem(key);
        if (value == null) continue;
        try {
          snapshotMetadata(value);
        } catch (error) {
          // Isolate a corrupt/oversized old cache, preserving its exact source
          // for manual recovery. A genuine backend/disk failure still rejects.
          this.onError(new Error(`Skipped unreadable legacy snapshot ${key}`, { cause: error }));
          continue;
        }
        // One snapshot per IPC prevents the 100 MiB legacy cache becoming one
        // giant structured-clone payload. Main refuses to overwrite newer data.
        await this.bridge.writeTranscript({ ...identity, value, legacy: true });
        if (this.storage && this.storage.getItem(key) === value) this.storage.removeItem(key);
      }
      this.initialized = true;
      this.notify();
      this.scheduleCatalogWrite();
      this.scheduleTranscriptWrite();
    };
    this.initialization = operation().catch((error) => {
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  getIndex(projectKey: string): SessionIndex {
    return this.projection[projectKey] ?? EMPTY_INDEX;
  }

  getIndices(): Record<string, SessionIndex> {
    return this.projection;
  }

  saveIndex(projectKey: string, next: SessionIndex): void {
    const patch = projectPatch(projectKey, this.getIndex(projectKey), next);
    if (!patch) return;
    this.pending.push(patch);
    this.reproject();
    this.scheduleCatalogWrite();
  }

  private acceptSnapshot(snapshot: SessionCatalogSnapshot): void {
    if (snapshot.revision < this.canonical.revision) return;
    this.canonical = snapshot;
    this.reproject();
  }

  private reproject(): void {
    const next = { ...this.canonical.indices };
    for (const patch of this.pending) {
      next[patch.projectKey] = projectPatchOn(next[patch.projectKey] ?? EMPTY_INDEX, patch);
    }
    this.projection = next;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.onError(error);
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeErrors(listener: (error: unknown) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /** Stage renderer state that is still waiting for its debounced save. */
  subscribeBeforeFlush(listener: () => void, phase: FlushPhase = "snapshots"): () => void {
    this.flushListeners[phase].add(listener);
    return () => this.flushListeners[phase].delete(listener);
  }

  private reportError = (error: unknown): void => {
    try {
      this.onError(error);
    } catch {
      /* diagnostics cannot reject the write twice */
    }
    for (const listener of this.errorListeners) {
      try {
        listener(error);
      } catch {
        // UI notifications cannot discard a pending write or reject a second time.
      }
    }
  };

  private scheduleCatalogWrite(): void {
    if (!this.initialized || this.catalogWrite || !this.pending.length) return;
    const write = async () => {
      while (this.pending.length) {
        const patch = this.pending[0]!;
        const snapshot = await this.bridge.apply(patch);
        this.pending.shift();
        this.acceptSnapshot(snapshot);
      }
    };
    this.catalogWrite = write().finally(() => {
      this.catalogWrite = undefined;
    });
    void this.catalogWrite.catch(this.reportError);
  }

  getTranscript(projectKey: string, sessionId: string): string | null {
    const key = memoryTranscriptKey(projectKey, sessionId);
    const value = this.transcriptValues.get(key);
    if (value) {
      this.transcriptValues.delete(key);
      this.transcriptValues.set(key, value);
    }
    return value?.value ?? null;
  }

  saveTranscript(projectKey: string, sessionId: string, value: string | null): void {
    const key = memoryTranscriptKey(projectKey, sessionId);
    if (this.transcriptValues.get(key)?.value === value) return;
    const hasEarlier = this.transcriptValues.get(key)?.hasEarlier === true;
    let evictable = false;
    try {
      evictable = value === null || snapshotMetadata(value).evictable;
    } catch {
      /* keep malformed pending data until Main reports the error */
    }
    this.transcriptValues.delete(key);
    this.transcriptValues.set(key, {
      value,
      version: ++this.transcriptVersion,
      hasEarlier: value !== null && hasEarlier,
      evictable,
    });
    const last = this.transcriptQueue[this.transcriptQueue.length - 1];
    // A queued snapshot can supersede another queued snapshot for the same
    // conversation, but never mutate the operation currently crossing IPC.
    if (
      last &&
      !last.moveToProjectKey &&
      this.transcriptQueue.length > (this.transcriptWrite ? 1 : 0) &&
      last.projectKey === projectKey &&
      last.sessionId === sessionId
    ) {
      this.transcriptQueue[this.transcriptQueue.length - 1] = { projectKey, sessionId, value };
    } else {
      this.transcriptQueue.push({ projectKey, sessionId, value });
    }
    this.scheduleTranscriptWrite();
  }

  copyTranscript(projectKey: string, targetProjectKey: string, sessionId: string): void {
    if (projectKey === targetProjectKey) return;
    const current = this.getTranscript(projectKey, sessionId);
    if (current !== null) {
      this.transcriptValues.set(memoryTranscriptKey(targetProjectKey, sessionId), {
        ...this.transcriptValues.get(memoryTranscriptKey(projectKey, sessionId)),
        value: current,
        version: ++this.transcriptVersion,
      });
    }
    this.transcriptQueue.push({
      projectKey,
      sessionId,
      value: null,
      moveToProjectKey: targetProjectKey,
    });
    this.scheduleTranscriptWrite();
  }

  private scheduleTranscriptWrite(): void {
    if (!this.initialized || this.transcriptWrite || !this.transcriptQueue.length) return;
    const write = async () => {
      while (this.transcriptQueue.length) {
        const operation = this.transcriptQueue[0]!;
        if (operation.moveToProjectKey) {
          const previous = await this.bridge.readTranscript({
            projectKey: operation.projectKey,
            sessionId: operation.sessionId,
            maxBytes: Number.MAX_SAFE_INTEGER,
          });
          if (previous.hasEarlier) throw new Error("Cannot move a partial conversation snapshot");
          if (previous.value !== null) {
            await this.bridge.writeTranscript({
              projectKey: operation.moveToProjectKey,
              sessionId: operation.sessionId,
              value: previous.value,
            });
          }
        } else if (operation.value === null) {
          await this.bridge.deleteTranscript(operation);
        } else {
          await this.bridge.writeTranscript({ ...operation, value: operation.value });
        }
        this.transcriptQueue.shift();
        this.trimTranscriptMemory(memoryTranscriptKey(operation.projectKey, operation.sessionId));
      }
    };
    this.transcriptWrite = write().finally(() => {
      this.transcriptWrite = undefined;
    });
    void this.transcriptWrite.catch(this.reportError);
  }

  async readTranscript(
    projectKey: string,
    sessionId: string,
    maxBytes?: number,
  ): Promise<{ value: string | null; hasEarlier: boolean }> {
    await this.initialize();
    if (
      this.transcriptQueue.some(
        (operation) =>
          operation.moveToProjectKey === projectKey && operation.sessionId === sessionId,
      )
    ) {
      this.scheduleTranscriptWrite();
      await this.transcriptWrite;
    }
    const key = memoryTranscriptKey(projectKey, sessionId);
    const before = this.transcriptValues.get(key);
    const pending = this.transcriptQueue.some(
      (operation) => operation.projectKey === projectKey && operation.sessionId === sessionId,
    );
    if (pending) return { value: before?.value ?? null, hasEarlier: before?.hasEarlier ?? false };
    const readGeneration = ++this.transcriptReadGeneration;
    this.readingTranscripts.set(key, (this.readingTranscripts.get(key) ?? 0) + 1);
    let result: { value: string | null; hasEarlier: boolean };
    try {
      result = await this.bridge.readTranscript({ projectKey, sessionId, maxBytes });
    } finally {
      const remaining = (this.readingTranscripts.get(key) ?? 1) - 1;
      if (remaining) this.readingTranscripts.set(key, remaining);
      else this.readingTranscripts.delete(key);
    }
    const latest = this.transcriptValues.get(key);
    if (
      (latest?.version ?? 0) !== (before?.version ?? 0) ||
      (latest?.readGeneration ?? 0) > readGeneration
    ) {
      return { value: latest?.value ?? null, hasEarlier: latest?.hasEarlier ?? false };
    }
    let evictable = false;
    try {
      evictable = result.value === null || snapshotMetadata(result.value).evictable;
    } catch {
      /* invalid backend snapshots remain visible to the parsing layer */
    }
    this.transcriptValues.delete(key);
    this.transcriptValues.set(key, {
      value: result.value,
      version: before?.version ?? 0,
      hasEarlier: result.hasEarlier,
      readGeneration,
      evictable,
    });
    this.trimTranscriptMemory(key);
    return result;
  }

  private trimTranscriptMemory(protectedKey: string): void {
    let bytes = [...this.transcriptValues.values()].reduce(
      (total, entry) => total + (entry.value?.length ?? 0) * 2,
      0,
    );
    const pending = new Set(
      this.transcriptQueue.flatMap((operation) => [
        memoryTranscriptKey(operation.projectKey, operation.sessionId),
        ...(operation.moveToProjectKey
          ? [memoryTranscriptKey(operation.moveToProjectKey, operation.sessionId)]
          : []),
      ]),
    );
    for (const [key, entry] of this.transcriptValues) {
      if (bytes <= MEMORY_SNAPSHOT_BYTES && this.transcriptValues.size <= MEMORY_SNAPSHOT_COUNT)
        break;
      if (
        key === protectedKey ||
        !entry.evictable ||
        pending.has(key) ||
        this.readingTranscripts.has(key)
      )
        continue;
      this.transcriptValues.delete(key);
      bytes -= (entry.value?.length ?? 0) * 2;
    }
  }

  async flush(): Promise<void> {
    await this.initialize();
    // Event coalescers must commit to React before snapshot readers serialize,
    // irrespective of the order in which the owning hooks mounted.
    for (const phase of ["events", "snapshots"] as const) {
      for (const listener of this.flushListeners[phase]) listener();
    }
    this.scheduleCatalogWrite();
    this.scheduleTranscriptWrite();
    // The caller sees any failure; pending operations survive and a later
    // flush retries the failed head before sending subsequent mutations.
    await Promise.all([this.catalogWrite, this.transcriptWrite]);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.listeners.clear();
    this.errorListeners.clear();
    this.flushListeners.events.clear();
    this.flushListeners.snapshots.clear();
  }
}

let activeBridge: SessionPersistenceBridge | undefined;
let activePersistence: SessionPersistence | undefined;

export function getSessionPersistence(): SessionPersistence | undefined {
  const bridge =
    typeof window === "undefined"
      ? undefined
      : (window.codeshell as unknown as { sessionCatalog?: SessionPersistenceBridge })
          ?.sessionCatalog;
  if (!bridge) return undefined;
  if (bridge !== activeBridge) {
    activePersistence?.dispose();
    activeBridge = bridge;
    activePersistence = new SessionPersistence(
      bridge,
      typeof localStorage === "undefined" ? undefined : localStorage,
      (error) => {
        window.codeshell?.log?.("session.persistence_write_failed", { error: String(error) });
      },
    );
  }
  return activePersistence;
}

export async function initializeSessionPersistence(): Promise<void> {
  await getSessionPersistence()?.initialize();
}

export async function flushSessionPersistence(): Promise<void> {
  await getSessionPersistence()?.flush();
}

export function subscribeSessionPersistenceFlush(
  listener: () => void,
  phase: FlushPhase = "snapshots",
): () => void {
  return getSessionPersistence()?.subscribeBeforeFlush(listener, phase) ?? (() => undefined);
}

export function subscribeSessionPersistence(listener: () => void): () => void {
  return getSessionPersistence()?.subscribe(listener) ?? (() => undefined);
}

export function getSessionPersistenceIndices(): Record<string, SessionIndex> {
  return getSessionPersistence()?.getIndices() ?? {};
}

export function subscribeSessionPersistenceErrors(listener: (error: unknown) => void): () => void {
  return getSessionPersistence()?.subscribeErrors(listener) ?? (() => undefined);
}
