import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  isFollowUpOpaqueId,
  isFollowUpRevision,
  isFollowUpTimestamp,
  isPetFollowUpMutationPayload,
  type PetFollowUpWakeOutcome,
  type PetFollowUpMissedPolicy,
  type PetRegisteredFollowUp,
  type RegisterPetFollowUpInput,
} from "@cjhyy/code-shell-pet";

const MAX_ENTRIES = 1_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const ID_PATTERN = /^registered-followup-[a-f0-9]{24}$/u;

function isOperationKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function registrationKey(input: RegisterPetFollowUpInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.title,
        input.text,
        input.wakeAt,
        input.timezone,
        input.intent,
        input.sourceSessionId ?? null,
        input.taskId ?? null,
        input.completionTarget
          ? [
              input.completionTarget.kind,
              input.completionTarget.channel,
              input.completionTarget.target,
              input.completionTarget.senderId ?? null,
              input.completionTarget.isDirectMessage ?? null,
              input.completionTarget.replyButton ?? null,
              [...(input.completionTarget.replyAttachmentKinds ?? [])].sort(),
            ]
          : null,
        input.missedPolicy ?? "fire-once",
        input.catchUpUntil ?? input.wakeAt + 24 * 60 * 60 * 1000,
      ]),
    )
    .digest("hex");
}

function validTarget(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  const text = (v: unknown, max: number) =>
    typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v);
  return (
    Object.keys(target).every((key) =>
      [
        "kind",
        "channel",
        "target",
        "senderId",
        "isDirectMessage",
        "replyButton",
        "replyAttachmentKinds",
      ].includes(key),
    ) &&
    target.kind === "im-gateway" &&
    text(target.channel, 128) &&
    text(target.target, 4_096) &&
    (target.senderId === undefined || text(target.senderId, 512)) &&
    (target.isDirectMessage === undefined || typeof target.isDirectMessage === "boolean") &&
    (target.replyButton === undefined ||
      target.replyButton === "native" ||
      target.replyButton === "link") &&
    (target.replyAttachmentKinds === undefined ||
      (Array.isArray(target.replyAttachmentKinds) &&
        target.replyAttachmentKinds.length <= 4 &&
        new Set(target.replyAttachmentKinds).size === target.replyAttachmentKinds.length &&
        target.replyAttachmentKinds.every((kind) =>
          ["image", "file", "audio", "video"].includes(kind),
        )))
  );
}

function validRecord(value: unknown): value is PetRegisteredFollowUp {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as PetRegisteredFollowUp;
  if (
    !Object.keys(row).every((key) =>
      [
        "id",
        "operationKey",
        "registrationKey",
        "revision",
        "title",
        "text",
        "wakeAt",
        "timezone",
        "missedPolicy",
        "catchUpUntil",
        "intent",
        "status",
        "createdAt",
        "updatedAt",
        "sourceSessionId",
        "taskId",
        "completionTarget",
        "wake",
      ].includes(key),
    )
  )
    return false;
  if (
    !ID_PATTERN.test(row.id) ||
    !isOperationKey(row.operationKey) ||
    !/^[a-f0-9]{64}$/u.test(row.registrationKey) ||
    !isFollowUpRevision(row.revision)
  )
    return false;
  if (
    row.id !==
    `registered-followup-${createHash("sha256").update(row.operationKey).digest("hex").slice(0, 24)}`
  )
    return false;
  if (
    !isPetFollowUpMutationPayload({
      action: "register",
      title: row.title,
      text: row.text,
      wakeAt: row.wakeAt,
      timezone: row.timezone,
      missedPolicy: row.missedPolicy,
      catchUpUntil: row.catchUpUntil,
      intent: row.intent,
      ...(row.sourceSessionId !== undefined ? { sourceSessionId: row.sourceSessionId } : {}),
      ...(row.taskId !== undefined ? { taskId: row.taskId } : {}),
    })
  )
    return false;
  if (row.missedPolicy !== "skip" && row.missedPolicy !== "fire-once") return false;
  if (!isFollowUpTimestamp(row.catchUpUntil) || row.catchUpUntil < row.wakeAt) return false;
  if (
    !["open", "completed", "dismissed", "cancelled"].includes(row.status) ||
    !isFollowUpTimestamp(row.createdAt) ||
    !isFollowUpTimestamp(row.updatedAt) ||
    row.updatedAt < row.createdAt ||
    !validTarget(row.completionTarget)
  )
    return false;
  const wake = row.wake;
  return (
    !!wake &&
    typeof wake === "object" &&
    !Array.isArray(wake) &&
    Object.keys(wake).every((key) =>
      ["revision", "status", "claimedAt", "completedAt", "detail", "taskId"].includes(key),
    ) &&
    wake.revision === row.revision &&
    ["scheduled", "claimed", "notified", "launched", "failed", "unknown"].includes(wake.status) &&
    (wake.claimedAt === undefined || isFollowUpTimestamp(wake.claimedAt)) &&
    (wake.completedAt === undefined || isFollowUpTimestamp(wake.completedAt)) &&
    (wake.detail === undefined ||
      (typeof wake.detail === "string" &&
        wake.detail.length <= 8_000 &&
        !wake.detail.includes("\0"))) &&
    (wake.taskId === undefined || isFollowUpOpaqueId(wake.taskId)) &&
    (wake.status === "scheduled"
      ? wake.claimedAt === undefined && wake.completedAt === undefined
      : isFollowUpTimestamp(wake.claimedAt)) &&
    (wake.status === "claimed"
      ? wake.completedAt === undefined
      : wake.status === "scheduled" || isFollowUpTimestamp(wake.completedAt))
  );
}

/** Single main-process owner; atomic writes commit canonical records before subscribers run. */
export class PetRegisteredFollowUpStore {
  private records = new Map<string, PetRegisteredFollowUp>();
  private listeners = new Set<() => void>();
  private loadPromise: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;

  constructor(
    private readonly path: string,
    options: {
      now?: () => number;
      /** Test seam: a failed replacement must preserve both disk and in-memory state. */
      replaceFile?: (temporary: string, target: string) => Promise<void>;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.replaceFile = options.replaceFile ?? rename;
  }
  private readonly replaceFile: (temporary: string, target: string) => Promise<void>;

  load(): Promise<void> {
    if (!this.loadPromise) {
      const attempt = this.read();
      this.loadPromise = attempt;
      void attempt.catch(() => {
        if (this.loadPromise === attempt) this.loadPromise = undefined;
      });
    }
    return this.loadPromise;
  }

  private async read(): Promise<void> {
    let raw: string;
    try {
      const info = await lstat(this.path);
      if (
        !info.isFile() ||
        info.size > MAX_FILE_BYTES ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      )
        throw new Error("unsafe follow-up store file");
      raw = await readFile(this.path, "utf8");
      if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw new Error("oversized follow-up store");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return;
      throw error;
    }
    const data: unknown = JSON.parse(raw);
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.keys(data).some((key) => key !== "version" && key !== "entries")
    )
      throw new Error("invalid follow-up store");
    const file = data as { version?: unknown; entries?: unknown };
    if (file.version !== 1 || !Array.isArray(file.entries) || file.entries.length > MAX_ENTRIES)
      throw new Error("invalid follow-up store schema");
    const next = new Map<string, PetRegisteredFollowUp>();
    const operations = new Set<string>();
    for (const row of file.entries) {
      if (!validRecord(row) || next.has(row.id) || operations.has(row.operationKey))
        throw new Error("invalid or duplicate follow-up record");
      next.set(row.id, row);
      operations.add(row.operationKey);
    }
    this.records = next;
  }

  list(): PetRegisteredFollowUp[] {
    return [...this.records.values()]
      .sort((a, b) => a.wakeAt - b.wakeAt || a.id.localeCompare(b.id))
      .map((row) => structuredClone(row));
  }
  get(id: string): PetRegisteredFollowUp | undefined {
    const row = this.records.get(id);
    return row ? structuredClone(row) : undefined;
  }
  findByOperationKey(operationKey: string): PetRegisteredFollowUp | undefined {
    const row = [...this.records.values()].find((entry) => entry.operationKey === operationKey);
    return row ? structuredClone(row) : undefined;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  register(input: RegisterPetFollowUpInput): Promise<PetRegisteredFollowUp> {
    const snapshot = structuredClone(input);
    return this.mutate((entries) => {
      const { operationKey, completionTarget, ...definition } = snapshot;
      if (
        !isOperationKey(operationKey) ||
        !validTarget(completionTarget) ||
        !isPetFollowUpMutationPayload({ action: "register", ...definition })
      )
        throw new Error("invalid follow-up registration");
      const key = registrationKey(snapshot);
      const existing = [...entries.values()].find((row) => row.operationKey === operationKey);
      if (existing) {
        if (existing.registrationKey !== key)
          throw new Error("follow-up operationKey belongs to a different registration");
        return existing;
      }
      if (entries.size >= MAX_ENTRIES) throw new Error("follow-up registry is full");
      const at = this.timestamp();
      if (snapshot.wakeAt <= at) throw new Error("follow-up wakeAt must be in the future");
      const row: PetRegisteredFollowUp = {
        id: `registered-followup-${createHash("sha256").update(operationKey).digest("hex").slice(0, 24)}`,
        ...snapshot,
        missedPolicy: snapshot.missedPolicy ?? "fire-once",
        catchUpUntil: snapshot.catchUpUntil ?? snapshot.wakeAt + 24 * 60 * 60 * 1000,
        registrationKey: key,
        revision: 1,
        status: "open",
        createdAt: at,
        updatedAt: at,
        wake: { revision: 1, status: "scheduled" },
      };
      entries.set(row.id, row);
      return row;
    });
  }

  reschedule(
    id: string,
    expectedRevision: number,
    input: {
      wakeAt: number;
      timezone: string;
      missedPolicy?: PetFollowUpMissedPolicy;
      catchUpUntil?: number;
    },
  ): Promise<PetRegisteredFollowUp> {
    return this.mutate((entries) => {
      if (
        !isPetFollowUpMutationPayload({
          action: "reschedule",
          followUpId: id,
          expectedRevision,
          ...input,
        })
      )
        throw new Error("invalid follow-up reschedule");
      const row = this.current(entries, id, expectedRevision);
      const at = this.timestamp();
      if (input.wakeAt <= at) throw new Error("follow-up wakeAt must be in the future");
      row.revision += 1;
      row.wakeAt = input.wakeAt;
      row.timezone = input.timezone;
      row.missedPolicy = input.missedPolicy ?? row.missedPolicy;
      row.catchUpUntil = input.catchUpUntil ?? input.wakeAt + 24 * 60 * 60 * 1000;
      row.updatedAt = Math.max(at, row.updatedAt);
      row.wake = { revision: row.revision, status: "scheduled" };
      return row;
    });
  }

  cancel(id: string, expectedRevision: number): Promise<PetRegisteredFollowUp> {
    return this.handle(id, expectedRevision, "cancel");
  }
  handle(
    id: string,
    expectedRevision: number,
    action: "complete" | "dismiss" | "cancel",
  ): Promise<PetRegisteredFollowUp> {
    return this.mutate((entries) => {
      if (!["complete", "dismiss", "cancel"].includes(action))
        throw new Error("invalid follow-up action");
      const row = this.current(entries, id, expectedRevision);
      row.revision += 1;
      row.status =
        action === "complete" ? "completed" : action === "dismiss" ? "dismissed" : "cancelled";
      row.updatedAt = Math.max(this.timestamp(), row.updatedAt);
      // Only unclaimed or settled wakes can be changed; claimed effects may already be in flight.
      row.wake = { revision: row.revision, status: "scheduled" };
      return row;
    });
  }

  /** Durable claim: a surviving claim is never eligible for automatic re-delivery. */
  claimWake(id: string, revision: number): Promise<PetRegisteredFollowUp | undefined> {
    return this.mutate((entries) => {
      const row = entries.get(id);
      if (
        !row ||
        row.revision !== revision ||
        row.status !== "open" ||
        row.wake.status !== "scheduled" ||
        row.wakeAt > this.timestamp()
      )
        return undefined;
      row.wake = { revision, status: "claimed", claimedAt: this.timestamp() };
      row.updatedAt = Math.max(row.wake.claimedAt!, row.updatedAt);
      return row;
    });
  }

  completeWake(
    id: string,
    revision: number,
    outcome: PetFollowUpWakeOutcome,
  ): Promise<PetRegisteredFollowUp | undefined> {
    const snapshot = structuredClone(outcome);
    return this.mutate((entries) => {
      if (
        !snapshot ||
        typeof snapshot !== "object" ||
        Object.keys(snapshot).some((key) => !["status", "detail", "taskId"].includes(key)) ||
        !["notified", "launched", "failed", "unknown"].includes(snapshot.status)
      )
        throw new Error("invalid follow-up wake outcome");
      const row = entries.get(id);
      if (
        !row ||
        row.revision !== revision ||
        row.status !== "open" ||
        row.wake.status !== "claimed"
      )
        return undefined;
      row.wake = { ...row.wake, ...snapshot, completedAt: this.timestamp() };
      row.updatedAt = Math.max(row.wake.completedAt!, row.updatedAt);
      if (!validRecord(row)) throw new Error("invalid follow-up wake outcome");
      return row;
    });
  }

  /** Startup compensation records uncertainty; it never retries an external effect blindly. */
  recoverClaims(): Promise<number> {
    return this.mutate((entries) => {
      let count = 0;
      for (const row of entries.values()) {
        if (row.status !== "open" || row.wake.status !== "claimed") continue;
        row.wake = {
          ...row.wake,
          status: "unknown",
          completedAt: this.timestamp(),
          detail: "上次唤醒已开始但结果未记录；未自动重试。",
        };
        row.updatedAt = Math.max(row.wake.completedAt!, row.updatedAt);
        count += 1;
      }
      return count;
    });
  }

  private timestamp(): number {
    const at = this.now();
    if (!isFollowUpTimestamp(at)) throw new Error("invalid follow-up clock");
    return at;
  }
  private current(
    entries: Map<string, PetRegisteredFollowUp>,
    id: string,
    revision: number,
  ): PetRegisteredFollowUp {
    const row = entries.get(id);
    if (!row || row.status !== "open") throw new Error("跟进项不存在或已处理");
    if (!isFollowUpRevision(revision) || row.revision !== revision)
      throw new Error("跟进项版本已更新，请重新读取");
    if (row.wake.status === "claimed") throw new Error("跟进项正在唤醒，结果记录前不能修改");
    return row;
  }
  private mutate<T>(fn: (entries: Map<string, PetRegisteredFollowUp>) => T): Promise<T> {
    const pending = this.queue
      .catch(() => undefined)
      .then(async () => {
        await this.load();
        const entries = new Map([...this.records].map(([id, row]) => [id, structuredClone(row)]));
        const result = fn(entries);
        if (entries.size > MAX_ENTRIES || [...entries.values()].some((row) => !validRecord(row)))
          throw new Error("invalid follow-up store mutation");
        const body = `${JSON.stringify({ version: 1, entries: [...entries.values()] })}\n`;
        if (Buffer.byteLength(body) > MAX_FILE_BYTES) throw new Error("oversized follow-up store");
        if (body === `${JSON.stringify({ version: 1, entries: [...this.records.values()] })}\n`)
          return structuredClone(result);
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        if (!(await lstat(dirname(this.path))).isDirectory())
          throw new Error("unsafe follow-up store directory");
        const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
        try {
          await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
          await this.replaceFile(temporary, this.path);
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
        this.records = entries;
        for (const listener of this.listeners) {
          try {
            listener();
          } catch {
            /* observers cannot roll back a committed mutation */
          }
        }
        return structuredClone(result);
      });
    this.queue = pending.catch(() => undefined);
    return pending;
  }
}
