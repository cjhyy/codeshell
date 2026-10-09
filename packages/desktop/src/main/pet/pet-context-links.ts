import { createHash } from "node:crypto";
import type { PetContextOriginRef, PetGroundedTaskRef } from "@cjhyy/code-shell-pet";
import { imConversationRouteKey } from "./session-turn-scheduler.js";
import { readBoundedJson, writeOwnerJsonAtomic } from "./bounded-json-store.js";

export type PetContextEventKind = "chat" | "task-result" | "session-report" | "follow-up-wake";

export interface PetContextLink {
  clientMessageId: string;
  originRef: PetContextOriginRef;
  eventKind: PetContextEventKind;
  at: number;
  tasks: PetGroundedTaskRef[];
}

export interface PetContextLinkQuery {
  originId?: string;
  taskId?: string;
  clientMessageId?: string;
  query?: string;
  limit?: number;
}

export interface PetContextLinkView {
  entries: PetContextLink[];
  totalCount: number;
  truncated: boolean;
}

const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9:_-]{1,512}$/u;

/** Host-issued relevance label. Raw channel targets/sender IDs never leave this helper. */
export function petContextOriginForSource(
  source?: { channel: string; target?: string; senderId?: string },
  clientMessageId = "unknown",
): PetContextOriginRef {
  if (!source) return { id: "origin-desktop", kind: "desktop", channel: "mimi" };
  const route = imConversationRouteKey(source);
  return {
    id: `origin-${createHash("sha256")
      .update(route ?? `unknown:${clientMessageId}`)
      .digest("hex")
      .slice(0, 32)}`,
    kind: route ? "im-gateway" : "unknown",
    channel: source.channel.slice(0, 32),
  };
}

/**
 * Single-owner query index over Mimi's shared conversation. It records source
 * and host-grounded task references, not a second transcript or task ledger.
 * No label in this index authorizes a reply, continuation or wider visibility.
 */
export class PetContextLinkStore {
  private entries = new Map<string, PetContextLink>();
  private loadPromise: Promise<void> | undefined;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  record(input: PetContextLink): Promise<PetContextLink> {
    const parsed = parseLink(input);
    if (!parsed) return Promise.reject(new Error("invalid Mimi context association"));
    const run = this.mutationQueue
      .catch(() => undefined)
      .then(() => this.load())
      .then(async () => {
        const previous = this.entries.get(parsed.clientMessageId);
        if (
          previous &&
          (previous.originRef.id !== parsed.originRef.id || previous.eventKind !== parsed.eventKind)
        )
          throw new Error("Mimi context association origin cannot change");
        const tasks = new Map((previous?.tasks ?? []).map((task) => [task.taskId, task]));
        for (const task of parsed.tasks) tasks.set(task.taskId, task);
        const entry: PetContextLink = {
          ...parsed,
          at: previous?.at ?? parsed.at,
          tasks: [...tasks.values()].slice(-4),
        };
        const staged = new Map(this.entries);
        staged.set(entry.clientMessageId, entry);
        const retained = sorted(staged.values()).slice(0, MAX_ENTRIES);
        await writeOwnerJsonAtomic(this.path, { version: 1, entries: retained }, MAX_FILE_BYTES);
        this.entries = new Map(retained.map((row) => [row.clientMessageId, row]));
        return structuredClone(entry);
      });
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }

  async query(input: PetContextLinkQuery = {}): Promise<PetContextLinkView> {
    if (
      input.originId !== undefined &&
      (typeof input.originId !== "string" || !/^origin-[A-Za-z0-9_-]{1,80}$/u.test(input.originId))
    )
      throw new Error("invalid Mimi origin selector");
    for (const id of [input.taskId, input.clientMessageId]) {
      if (id !== undefined && (typeof id !== "string" || !ID_RE.test(id)))
        throw new Error("invalid Mimi context selector");
    }
    if (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 128))
      throw new Error("invalid Mimi context query");
    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    )
      throw new Error("invalid Mimi context query limit");
    await this.mutationQueue;
    await this.load();
    const needle = input.query?.trim().normalize("NFKC").toLowerCase();
    const matches = sorted(this.entries.values()).filter(
      (entry) =>
        (input.originId === undefined || entry.originRef.id === input.originId) &&
        (input.clientMessageId === undefined || entry.clientMessageId === input.clientMessageId) &&
        (input.taskId === undefined || entry.tasks.some((task) => task.taskId === input.taskId)) &&
        (!needle ||
          [entry.originRef.channel, ...entry.tasks.map((task) => task.objective)].some((text) =>
            text.normalize("NFKC").toLowerCase().includes(needle),
          )),
    );
    const entries = matches.slice(0, input.limit ?? 20);
    return {
      entries: structuredClone(entries),
      totalCount: matches.length,
      truncated: entries.length < matches.length,
    };
  }

  private load(): Promise<void> {
    if (!this.loadPromise) {
      const attempt = this.loadFromDisk();
      this.loadPromise = attempt;
      void attempt.catch(() => {
        if (this.loadPromise === attempt) this.loadPromise = undefined;
      });
    }
    return this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    const raw = await readBoundedJson(this.path, MAX_FILE_BYTES);
    if (raw === undefined) return;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("invalid Mimi context index");
    const data = raw as { version?: unknown; entries?: unknown };
    if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > MAX_ENTRIES)
      throw new Error("invalid Mimi context index");
    const parsed = data.entries.map(parseLink);
    if (
      parsed.some((entry) => !entry) ||
      new Set(parsed.map((entry) => entry!.clientMessageId)).size !== parsed.length
    )
      throw new Error("invalid Mimi context index entry");
    this.entries = new Map(parsed.map((entry) => [entry!.clientMessageId, entry!]));
  }
}

function sorted(entries: Iterable<PetContextLink>): PetContextLink[] {
  return [...entries].sort(
    (a, b) => b.at - a.at || a.clientMessageId.localeCompare(b.clientMessageId),
  );
}

function parseLink(value: unknown): PetContextLink | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as PetContextLink;
  if (
    typeof entry.clientMessageId !== "string" ||
    !ID_RE.test(entry.clientMessageId) ||
    !Number.isSafeInteger(entry.at) ||
    entry.at < 0 ||
    !["chat", "task-result", "session-report", "follow-up-wake"].includes(entry.eventKind) ||
    !entry.originRef ||
    !/^origin-[A-Za-z0-9_-]{1,80}$/u.test(entry.originRef.id) ||
    !["desktop", "im-gateway", "unknown"].includes(entry.originRef.kind) ||
    typeof entry.originRef.channel !== "string" ||
    !/^[a-zA-Z0-9_-]{1,32}$/u.test(entry.originRef.channel) ||
    !Array.isArray(entry.tasks) ||
    entry.tasks.length > 4
  )
    return undefined;
  const taskIds = new Set<string>();
  for (const task of entry.tasks) {
    if (
      !task ||
      typeof task.taskId !== "string" ||
      !ID_RE.test(task.taskId) ||
      typeof task.sessionId !== "string" ||
      !ID_RE.test(task.sessionId) ||
      typeof task.objective !== "string" ||
      !task.objective.trim() ||
      task.objective.length > 800 ||
      taskIds.has(task.taskId)
    )
      return undefined;
    taskIds.add(task.taskId);
  }
  return {
    clientMessageId: entry.clientMessageId,
    originRef: {
      id: entry.originRef.id,
      kind: entry.originRef.kind,
      channel: entry.originRef.channel,
    },
    eventKind: entry.eventKind,
    at: entry.at,
    tasks: entry.tasks.map(({ taskId, sessionId, objective }) => ({
      taskId,
      sessionId,
      objective,
    })),
  };
}
