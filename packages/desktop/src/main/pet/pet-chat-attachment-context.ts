import { isAbsolute, join } from "node:path";
import type { InputAttachmentMeta } from "@cjhyy/code-shell-server/storage";
import {
  quarantineCorruptJson,
  readBoundedJson,
  writeOwnerJsonAtomic,
} from "./bounded-json-store.js";

const MAX_ROUTES = 32;
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_AGE_MS = 60 * 60 * 1000;
const ORIGINS = new Set([
  "paste",
  "os-drop",
  "file-panel",
  "picker",
  "mention",
  "generated",
  "mobile",
  "im-gateway",
  "tool",
]);

interface Scope {
  routeKey: string;
  sessionId: string;
}

interface TimedScope extends Scope {
  now?: number;
}

interface AttachmentRecord extends Scope {
  at: number;
  attachments: InputAttachmentMeta[];
}

function text(value: unknown, limit: number, allowNull = false): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= limit &&
    (allowNull || !value.includes("\0"))
  );
}

function validScope(input: Scope): void {
  // IM route keys deliberately contain NUL separators between channel, target and sender.
  if (!text(input.routeKey, 4_096, true) || !text(input.sessionId, 256))
    throw new Error("Invalid Mimi attachment context scope");
}

function timestamp(value: number | undefined): number {
  const at = value ?? Date.now();
  if (!Number.isSafeInteger(at) || at < 0) throw new Error("Invalid Mimi attachment context time");
  return at;
}

/** Validate and copy metadata only. An attachment path never authorizes reading its contents. */
function image(input: unknown): InputAttachmentMeta {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid Mimi image attachment metadata");
  const item = input as InputAttachmentMeta;
  if (
    item.kind !== "image" ||
    !text(item.id, 256) ||
    !text(item.sessionId, 256) ||
    !ORIGINS.has(item.origin) ||
    !text(item.path, 32_768) ||
    !text(item.absPath, 32_768) ||
    !isAbsolute(item.absPath) ||
    !Number.isSafeInteger(item.size) ||
    item.size <= 0 ||
    item.size > MAX_IMAGE_BYTES ||
    typeof item.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(item.sha256) ||
    !Number.isSafeInteger(item.createdAt) ||
    item.createdAt < 0 ||
    (item.relPath !== undefined && !text(item.relPath, 32_768)) ||
    (item.mime !== undefined && !/^image\/[a-z0-9.+-]{1,64}$/i.test(item.mime)) ||
    (item.originalName !== undefined && !text(item.originalName, 4_096)) ||
    (item.sourcePath !== undefined && !text(item.sourcePath, 32_768)) ||
    [item.width, item.height].some(
      (value) => value !== undefined && (!Number.isSafeInteger(value) || value <= 0),
    )
  )
    throw new Error("Invalid Mimi image attachment metadata");
  let vision: InputAttachmentMeta["vision"];
  if (item.vision !== undefined) {
    if (
      !item.vision ||
      typeof item.vision !== "object" ||
      Array.isArray(item.vision) ||
      typeof item.vision.include !== "boolean" ||
      (item.vision.mediaPath !== undefined && !text(item.vision.mediaPath, 32_768)) ||
      (item.vision.detail !== undefined &&
        !["low", "standard", "high"].includes(item.vision.detail))
    )
      throw new Error("Invalid Mimi image attachment metadata");
    vision = {
      include: item.vision.include,
      ...(item.vision.mediaPath !== undefined ? { mediaPath: item.vision.mediaPath } : {}),
      ...(item.vision.detail !== undefined ? { detail: item.vision.detail } : {}),
    };
  }
  return {
    id: item.id,
    sessionId: item.sessionId,
    kind: "image",
    origin: item.origin,
    path: item.path,
    absPath: item.absPath,
    size: item.size,
    sha256: item.sha256,
    createdAt: item.createdAt,
    ...(item.relPath !== undefined ? { relPath: item.relPath } : {}),
    ...(item.mime !== undefined ? { mime: item.mime } : {}),
    ...(item.originalName !== undefined ? { originalName: item.originalName } : {}),
    ...(item.sourcePath !== undefined ? { sourcePath: item.sourcePath } : {}),
    ...(item.width !== undefined ? { width: item.width } : {}),
    ...(item.height !== undefined ? { height: item.height } : {}),
    ...(vision ? { vision } : {}),
  };
}

function batch(attachments: readonly InputAttachmentMeta[]): InputAttachmentMeta[] {
  if (!Array.isArray(attachments)) throw new Error("Invalid Mimi attachment context batch");
  const unique = new Map<string, InputAttachmentMeta>();
  for (const input of attachments) {
    if (input?.kind !== "image") continue;
    const item = image(input);
    const previous = unique.get(item.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(item))
      throw new Error("Conflicting Mimi image attachment metadata");
    unique.set(item.id, item);
  }
  const images = [...unique.values()];
  if (
    images.length > MAX_IMAGES ||
    images.reduce((size, item) => size + item.size, 0) > MAX_IMAGE_BYTES
  )
    throw new Error("Mimi attachment context exceeds image limits");
  return images;
}

function sameScope(a: Scope, b: Scope): boolean {
  return a.routeKey === b.routeKey && a.sessionId === b.sessionId;
}

function freshImage(item: InputAttachmentMeta, now: number): boolean {
  return item.createdAt <= now && now - item.createdAt < MAX_AGE_MS;
}

function referenced(objective: string, alias: string): boolean {
  const boundary = (character: string | undefined) =>
    character === undefined || /[\s`"'()[\]{}<>,;:!?，。；：！？、“”‘’（）【】]/u.test(character);
  let offset = objective.indexOf(alias);
  while (offset !== -1) {
    const end = offset + alias.length;
    const sentencePeriod = objective[end] === "." && boundary(objective[end + 1]);
    if (boundary(objective[offset - 1]) && (boundary(objective[end]) || sentencePeriod))
      return true;
    offset = objective.indexOf(alias, offset + 1);
  }
  return false;
}

/** Select from a frozen turn snapshot, without observing another turn's route context. */
export function selectPetChatAttachments(
  attachments: readonly InputAttachmentMeta[],
  objective: string,
): InputAttachmentMeta[] {
  if (typeof objective !== "string") throw new Error("Invalid Mimi attachment objective");
  // A frozen turn can combine the previous batch with newly consumed images.
  // Enforce handoff limits on the referenced subset, rather than unrelated candidates.
  return batch(
    attachments.filter(
      (item) =>
        item?.kind === "image" &&
        [item.path, item.relPath, item.absPath].some(
          (alias) => typeof alias === "string" && alias.length > 0 && referenced(objective, alias),
        ),
    ),
  );
}

/** Recent Host attachment metadata, isolated by originating conversation and manager Session. */
export class PetChatAttachmentContext {
  private readonly filePath: string;
  private records: AttachmentRecord[] = [];
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(rootDirectory: string) {
    this.filePath = join(rootDirectory, "chat-attachment-context.json");
  }

  async remember(
    input: TimedScope & { attachments: readonly InputAttachmentMeta[] },
  ): Promise<void> {
    validScope(input);
    const at = timestamp(input.now);
    const attachments = batch(input.attachments);
    const scope = { routeKey: input.routeKey, sessionId: input.sessionId };
    return this.run(async () => {
      await this.load();
      if (attachments.length === 0) return;
      const fresh = this.fresh(at);
      const previous = fresh.find((record) => sameScope(record, scope));
      const merged = new Map(previous?.attachments.map((item) => [item.id, item]));
      for (const item of attachments) {
        if (!freshImage(item, at)) continue;
        const existing = merged.get(item.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(item))
          throw new Error("Conflicting Mimi image attachment metadata");
        if (!existing) merged.set(item.id, item);
      }
      // Keep source staging times and identity stable across replays. A later
      // image can join this route without renewing or reordering earlier images.
      const retained = [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
      let bytes = retained.reduce((total, item) => total + item.size, 0);
      while (retained.length > MAX_IMAGES || bytes > MAX_IMAGE_BYTES)
        bytes -= retained.shift()!.size;
      const records = fresh.filter((record) => !sameScope(record, scope));
      if (retained.length)
        records.push({
          ...scope,
          at: Math.max(...retained.map((item) => item.createdAt)),
          attachments: retained,
        });
      await this.persist(records.sort((a, b) => a.at - b.at));
    });
  }

  async list(input: TimedScope): Promise<InputAttachmentMeta[]> {
    validScope(input);
    const now = timestamp(input.now);
    const scope = { routeKey: input.routeKey, sessionId: input.sessionId };
    return this.run(async () => {
      await this.load();
      const record = this.fresh(now).find((candidate) => sameScope(candidate, scope));
      return record ? record.attachments.map(image) : [];
    });
  }

  async select(input: TimedScope & { objective: string }): Promise<InputAttachmentMeta[]> {
    if (typeof input.objective !== "string") throw new Error("Invalid Mimi attachment objective");
    const objective = input.objective;
    return selectPetChatAttachments(await this.list(input), objective);
  }

  async clear(input: Scope): Promise<void> {
    validScope(input);
    const scope = { routeKey: input.routeKey, sessionId: input.sessionId };
    return this.run(async () => {
      await this.load();
      await this.persist(this.records.filter((record) => !sameScope(record, scope)));
    });
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private fresh(now: number): AttachmentRecord[] {
    return this.records.flatMap((record) => {
      const attachments = record.attachments.filter((item) => freshImage(item, now));
      return attachments.length
        ? [{ ...record, at: Math.max(...attachments.map((item) => item.createdAt)), attachments }]
        : [];
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const value = await readBoundedJson(this.filePath, MAX_STATE_BYTES);
      if (value !== undefined) {
        const state = value as { version?: unknown; records?: unknown };
        if (
          !state ||
          state.version !== 1 ||
          !Array.isArray(state.records) ||
          state.records.length > MAX_ROUTES
        )
          throw new Error("Invalid Mimi attachment context state");
        this.records = state.records.map((record: AttachmentRecord) => {
          validScope(record);
          const attachments = batch(record.attachments);
          if (
            !attachments.length ||
            attachments.length !== record.attachments.length ||
            !Number.isSafeInteger(record.at) ||
            record.at < 0
          )
            throw new Error("Invalid Mimi attachment context state");
          return {
            routeKey: record.routeKey,
            sessionId: record.sessionId,
            at: timestamp(record.at),
            attachments,
          };
        });
      }
    } catch {
      await quarantineCorruptJson(this.filePath);
      this.records = [];
    }
    this.loaded = true;
  }

  private async persist(records: AttachmentRecord[]): Promise<void> {
    const bounded = records.slice(-MAX_ROUTES);
    while (
      Buffer.byteLength(JSON.stringify({ version: 1, records: bounded }, null, 2) + "\n") >
      MAX_STATE_BYTES
    )
      bounded.shift();
    await writeOwnerJsonAtomic(this.filePath, { version: 1, records: bounded }, MAX_STATE_BYTES);
    this.records = bounded;
  }
}
