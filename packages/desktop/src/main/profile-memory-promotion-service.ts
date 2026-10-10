import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MemoryManager, type MemoryEntry } from "@cjhyy/code-shell-core";
import { readWorkspaceProfile, workspaceProfileDir } from "@cjhyy/code-shell-core/internal";
import type {
  CommitProfileMemoryPromotionInput,
  PreviewProfileMemoryPromotionInput,
  ProfileMemoryPromotionDraft,
  ProfileMemoryPromotionResult,
  ProfileMemoryPromotionReview,
} from "../shared/profile-memory-promotion.js";

const REVIEW_TTL_MS = 5 * 60_000;
const MAX_REVIEWS = 64;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_STORE_BYTES = 16 * MAX_FILE_BYTES;
const MAX_STORE_ENTRIES = 2048;

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid memory promotion input");
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("unexpected memory promotion field");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, multiline = false): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > max ||
    value.includes("\0") ||
    (!multiline && /[\r\n]/.test(value))
  )
    throw new Error("invalid memory promotion text");
  return value;
}
export function parseMemoryPromotionPreview(value: unknown): PreviewProfileMemoryPromotionInput {
  const input = object(value, ["cwd", "source", "profileName", "draft"]);
  const source = object(input.source, ["scope", "id"]);
  if (source.scope !== "user" && source.scope !== "dream")
    throw new Error("invalid source memory scope");
  const profileName = text(input.profileName, 64);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profileName)) throw new Error("invalid Profile name");
  const raw = object(input.draft, ["name", "description", "type", "content", "pinned"]);
  if (!["user", "feedback", "project", "reference"].includes(raw.type as string))
    throw new Error("invalid memory type");
  if (raw.pinned !== undefined && typeof raw.pinned !== "boolean")
    throw new Error("invalid memory pin");
  const draft: ProfileMemoryPromotionDraft = {
    name: text(raw.name, 512),
    description: text(raw.description, 4096),
    type: raw.type as ProfileMemoryPromotionDraft["type"],
    content: text(raw.content, 256 * 1024, true),
    ...(raw.pinned === undefined ? {} : { pinned: raw.pinned }),
  };
  return {
    cwd: text(input.cwd, 32768),
    profileName,
    source: { scope: source.scope, id: text(source.id, 1024) },
    draft,
  };
}
export function parseMemoryPromotionCommit(value: unknown): CommitProfileMemoryPromotionInput {
  const input = object(value, ["cwd", "reviewId"]);
  const reviewId = text(input.reviewId, 36);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(reviewId))
    throw new Error("invalid memory promotion review ID");
  return { cwd: text(input.cwd, 32768), reviewId };
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
function directory(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe memory directory");
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
function identity(info: Stats): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
}
function fileProof(path: string, limit = MAX_FILE_BYTES): string {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit)
    throw new Error("unsafe memory file");
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || identity(opened) !== identity(before))
      throw new Error("memory file changed");
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(descriptor, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    if (
      count > limit ||
      count !== opened.size ||
      identity(fstatSync(descriptor)) !== identity(opened) ||
      identity(lstatSync(path)) !== identity(opened)
    )
      throw new Error("memory file changed or exceeded its size limit");
    // Reject malformed UTF-8 before MemoryManager's existing parser reads it.
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count));
    return (
      identity(opened) + ":" + createHash("sha256").update(bytes.subarray(0, count)).digest("hex")
    );
  } finally {
    closeSync(descriptor);
  }
}
function memoryBaseDir(): string {
  // Match MemoryManager's public storage contract, including its HOME override.
  return process.env.CODE_SHELL_HOME || join(process.env.HOME ?? homedir(), ".code-shell");
}
function memoryRoot(baseDir: string, projectDir?: string): string {
  return projectDir
    ? join(baseDir, "projects", projectDir.replace(/[/\\:]/g, "-").replace(/^-/, ""), "memory")
    : join(baseDir, "memory");
}
function readStore(
  baseDir: string,
  scope: "user" | "dream",
  projectDir?: string,
): { manager: MemoryManager; proofs: Map<string, string> } | undefined {
  if (!directory(baseDir)) return undefined;
  if (projectDir) {
    const projects = join(baseDir, "projects");
    if (
      !directory(projects) ||
      !directory(join(projects, projectDir.replace(/[/\\:]/g, "-").replace(/^-/, "")))
    )
      return undefined;
  }
  const root = memoryRoot(baseDir, projectDir);
  if (!directory(root)) return undefined;
  // MemoryManager's constructor migrates the old flat layout. Review never
  // triggers that write: the existing memory editor must migrate it first.
  if (readdirSync(root).some((name) => name.endsWith(".md")))
    throw new Error("legacy memory layout requires opening the memory editor first");
  const dir = join(root, scope);
  if (!directory(dir)) return undefined;
  const names = readdirSync(dir);
  if (names.length > MAX_STORE_ENTRIES) throw new Error("memory store exceeds review entry limit");
  let bytes = 0;
  const proofs = new Map<string, string>();
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    proofs.set(name, fileProof(join(dir, name)));
    bytes += lstatSync(join(dir, name)).size;
    if (bytes > MAX_STORE_BYTES) throw new Error("memory store exceeds review byte limit");
  }
  return { manager: new MemoryManager({ baseDir, scope, projectDir }), proofs };
}
function readSource(input: PreviewProfileMemoryPromotionInput): {
  entry: MemoryEntry;
  proof: string;
} {
  const store = readStore(memoryBaseDir(), input.source.scope, input.cwd);
  const entries = store?.manager.loadAll().filter((entry) => entry.id === input.source.id) ?? [];
  if (entries.length !== 1) throw new Error("source memory is missing or ambiguous");
  const entry = entries[0];
  const proof = fileProof(join(store!.manager.getMemoryDir(), entry.fileName));
  if (proof !== store!.proofs.get(entry.fileName))
    throw new Error("source memory changed while reading");
  return { entry, proof };
}
function readTarget(profileName: string, name: string) {
  const dir = workspaceProfileDir(profileName);
  const path = join(dir, "profile.json");
  // Validate the existing Profile store before reading its exact file proof.
  const profile = readWorkspaceProfile(profileName);
  if (!profile) throw new Error("target Profile does not exist");
  const before = fileProof(path, 256 * 1024);
  const current = readWorkspaceProfile(profileName);
  const after = fileProof(path, 256 * 1024);
  if (!current || before !== after) throw new Error("target Profile changed while reading");
  for (const scope of ["user", "dream"] as const) {
    const store = readStore(dir, scope);
    if (store?.manager.loadAll().some((entry) => entry.name.trim() === name.trim()))
      throw new Error("target memory name already exists; choose another name");
  }
  return { profile: current, dir, proof: dir + ":" + after };
}
interface PendingReview {
  owner: number;
  input: PreviewProfileMemoryPromotionInput;
  sourceProof: string;
  targetProof: string;
  review: ProfileMemoryPromotionReview;
}

export class ProfileMemoryPromotionReviews {
  private readonly pending = new Map<string, PendingReview>();
  constructor(private readonly now = Date.now) {}
  clearOwner(owner: number): void {
    for (const [id, record] of this.pending) if (record.owner === owner) this.pending.delete(id);
  }
  private expire(): void {
    for (const [id, record] of this.pending)
      if (record.review.expiresAt <= this.now()) this.pending.delete(id);
  }
  preview(owner: number, value: unknown): ProfileMemoryPromotionReview {
    this.expire();
    this.clearOwner(owner);
    if (this.pending.size >= MAX_REVIEWS) throw new Error("too many pending memory reviews");
    const input = parseMemoryPromotionPreview(value);
    const source = readSource(input);
    const target = readTarget(input.profileName, input.draft.name);
    const review: ProfileMemoryPromotionReview = {
      reviewId: randomUUID(),
      expiresAt: this.now() + REVIEW_TTL_MS,
      source: {
        id: source.entry.id!,
        scope: input.source.scope,
        name: source.entry.name,
        description: source.entry.description,
        type: source.entry.type,
        content: source.entry.content,
      },
      target: {
        profileName: input.profileName,
        label: target.profile.label,
        portableMemory: target.profile.portableMemory,
      },
      draft: input.draft,
    };
    this.pending.set(review.reviewId, {
      owner,
      input,
      sourceProof: source.proof,
      targetProof: target.proof,
      review,
    });
    return structuredClone(review);
  }
  commit(owner: number, value: unknown): ProfileMemoryPromotionResult {
    const input = parseMemoryPromotionCommit(value);
    this.expire();
    const record = this.pending.get(input.reviewId);
    if (!record || record.owner !== owner)
      throw new Error("memory promotion review expired or unavailable");
    // Consume before any I/O, including failure. A fresh review is required
    // after an ambiguous write/index failure; repeated clicks never copy twice.
    this.pending.delete(input.reviewId);
    if (record.input.cwd !== input.cwd) throw new Error("review project changed");
    const source = readSource(record.input);
    if (source.proof !== record.sourceProof) throw new Error("source memory changed during review");
    const target = readTarget(record.input.profileName, record.input.draft.name);
    if (target.proof !== record.targetProof)
      throw new Error("target Profile changed during review");
    const id = randomUUID();
    const manager = new MemoryManager({ baseDir: target.dir, scope: "user" });
    // Only the edited draft is copied. Dream/retrieval/promotion lifecycle is
    // intentionally absent; the destination is a new manual user memory.
    const fileName = manager.save(
      { ...record.input.draft, id, origin: "manual" },
      { forceOrigin: "manual" },
    );
    // This Main operation is synchronous, but it does not add a cross-process
    // body transaction to MemoryManager's existing atomic-file/index-lock API.
    return { profileName: record.input.profileName, id, fileName };
  }
}
