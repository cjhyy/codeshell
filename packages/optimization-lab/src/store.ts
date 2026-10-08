import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { acquireLockOnPath } from "@cjhyy/code-shell-core/extension";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./contracts/canonical-json.js";
import { verifyExperimentPlan, type ExperimentPlan } from "./contracts/experiment.js";
import { assertGrantActive, verifyBudgetGrant, type BudgetGrant } from "./contracts/grant.js";

export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const ExperimentIdSchema = z
  .string()
  .regex(/^exp_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
export interface LeaseFence {
  owner: string;
  generation: number;
}
export interface LeaseRecord extends LeaseFence {
  heartbeatAt: number;
  expiresAt: number;
}
export const LeaseRecordSchema = z
  .object({
    owner: z.string().min(1).max(128),
    generation: z.number().int().positive().safe(),
    heartbeatAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().nonnegative().safe(),
  })
  .strict();
export type ExperimentStatus =
  | "draft"
  | "ready"
  | "authorized"
  | "baselining"
  | "awaiting_baseline_grading"
  | "proposing"
  | "screening"
  | "awaiting_screening_grading"
  | "final_evaluating"
  | "report_ready"
  | "cancelled"
  | "budget_exhausted"
  | "interrupted"
  | "failed";
export interface ExperimentState {
  schemaVersion: 1;
  id: string;
  revision: number;
  status: ExperimentStatus;
  startedAt: string | null;
  grantRevision: number;
  controlRevision: number;
  stopRequested: boolean;
  data: Record<string, unknown>;
}
const StateSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: ExperimentIdSchema,
    revision: z.number().int().positive().safe(),
    status: z.enum([
      "draft",
      "ready",
      "authorized",
      "baselining",
      "awaiting_baseline_grading",
      "proposing",
      "screening",
      "awaiting_screening_grading",
      "final_evaluating",
      "report_ready",
      "cancelled",
      "budget_exhausted",
      "interrupted",
      "failed",
    ]),
    startedAt: z.string().datetime().nullable(),
    grantRevision: z.number().int().nonnegative().safe(),
    controlRevision: z.number().int().nonnegative().safe(),
    stopRequested: z.boolean(),
    data: z.record(z.unknown()),
  })
  .strict();
export interface ExperimentSnapshot {
  plan: ExperimentPlan;
  state: ExperimentState;
  grant: BudgetGrant | null;
  lease: LeaseRecord | null;
}
export interface MutationOptions {
  expectedRevision?: number;
  fence?: LeaseFence;
  now?: number;
}
export interface ArtifactRef {
  hash: string;
  path: string;
}

/** Reject symlinks/non-regular files both before open and through O_NOFOLLOW. */
export function readBoundedFile(path: string, maxBytes = MAX_ARTIFACT_BYTES): string | undefined {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes)
    throw new Error("optimization_lab: unsafe or oversized file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.size > maxBytes ||
      opened.dev !== info.dev ||
      opened.ino !== info.ino
    )
      throw new Error("optimization_lab: file changed while opening");
    const text = readFileSync(fd, "utf8");
    if (Buffer.byteLength(text, "utf8") > maxBytes)
      throw new Error("optimization_lab: file exceeds bound");
    return text;
  } finally {
    closeSync(fd);
  }
}

/** fsync precedes atomic rename; an abandoned unique temporary file is never read as state. */
export function writeAtomicFile(path: string, text: string, maxBytes = MAX_ARTIFACT_BYTES): void {
  if (Buffer.byteLength(text, "utf8") > maxBytes)
    throw new Error("optimization_lab: file exceeds bound");
  const current = readBoundedFile(path, maxBytes);
  void current;
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    // Windows does not permit ordinary directory descriptors; other file sync
    // failures remain fatal rather than being silently treated as durability.
    let dirFd: number | undefined;
    try {
      dirFd = openSync(dirname(path), constants.O_RDONLY);
      fsyncSync(dirFd);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const unsupported =
        code === "EINVAL" ||
        code === "ENOTSUP" ||
        code === "EISDIR" ||
        (process.platform === "win32" && (code === "EPERM" || code === "EACCES"));
      if (!unsupported) throw error;
    } finally {
      if (dirFd !== undefined) closeSync(dirFd);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readJson<T>(path: string): T | undefined {
  const text = readBoundedFile(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("optimization_lab: corrupt JSON state");
  }
}

/** All callbacks are synchronous and bounded. Never hold this short lock across await. */
export class ExperimentStore {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.ensureDirectory(this.root);
    this.ensureDirectory(join(this.root, "experiments"));
  }

  private ensureDirectory(path: string): void {
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("optimization_lab: unsafe store directory");
  }

  directory(id: string): string {
    ExperimentIdSchema.parse(id);
    this.ensureDirectory(this.root);
    this.ensureDirectory(join(this.root, "experiments"));
    const path = join(this.root, "experiments", id);
    if (!existsSync(path)) throw new Error("optimization_lab: unknown experiment");
    this.ensureDirectory(path);
    return path;
  }

  /** Internal shared critical section for state, lease and ledger; no nested locks. */
  withLock<T>(id: string, fn: (directory: string) => T): T {
    const directory = this.directory(id);
    const release = acquireLockOnPath(directory, 2000);
    try {
      const result = fn(directory);
      if (result && typeof (result as { then?: unknown }).then === "function")
        throw new Error("optimization_lab: asynchronous store lock callback forbidden");
      return result;
    } finally {
      release();
    }
  }

  create(raw: ExperimentPlan): ExperimentSnapshot {
    const plan = verifyExperimentPlan(raw);
    const id = `exp_${randomUUID()}`;
    this.ensureDirectory(this.root);
    this.ensureDirectory(join(this.root, "experiments"));
    const directory = join(this.root, "experiments", id);
    const staging = join(this.root, "experiments", `.pending_${randomUUID()}`);
    mkdirSync(staging, { mode: 0o700 });
    const state: ExperimentState = {
      schemaVersion: 1,
      id,
      revision: 1,
      status: "ready",
      startedAt: null,
      grantRevision: 0,
      controlRevision: 0,
      stopRequested: false,
      data: {},
    };
    try {
      writeAtomicFile(join(staging, "plan.json"), canonicalJson(plan));
      writeAtomicFile(join(staging, "state.json"), canonicalJson(state));
      renameSync(staging, directory);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return { plan, state, grant: null, lease: null };
  }

  list(): ExperimentSnapshot[] {
    return readdirSync(join(this.root, "experiments"))
      .filter((id) => ExperimentIdSchema.safeParse(id).success)
      .sort()
      .map((id) => this.read(id));
  }

  read(id: string): ExperimentSnapshot {
    return this.withLock(id, (directory) => this.readUnlocked(directory, id));
  }

  readUnlocked(directory: string, id: string): ExperimentSnapshot {
    const plan = verifyExperimentPlan(readJson(join(directory, "plan.json")));
    let state = StateSchema.parse(readJson(join(directory, "state.json"))) as ExperimentState;
    if (state.id !== id) throw new Error("optimization_lab: state identity mismatch");
    let grant: BudgetGrant | null = null;
    const grantsDirectory = join(directory, "grants");
    if (existsSync(grantsDirectory)) {
      this.ensureDirectory(grantsDirectory);
      const revisions = readdirSync(grantsDirectory)
        .filter((name) => /^[1-9][0-9]*\.json$/.test(name))
        .map((name) => Number(name.slice(0, -5)))
        .sort((a, b) => a - b);
      if (revisions.length > 10000)
        throw new Error("optimization_lab: grant history exceeds bound");
      for (let index = 0; index < revisions.length; index++) {
        const revision = revisions[index];
        if (revision !== index + 1) throw new Error("optimization_lab: grant history gap");
        const next = verifyBudgetGrant(
          readJson(join(grantsDirectory, `${revision}.json`)),
          plan.planHash,
        );
        if (
          next.revision !== revision ||
          (grant && next.startOperationId !== grant.startOperationId)
        )
          throw new Error("optimization_lab: grant history identity mismatch");
        grant = next;
      }
    }
    const latestRevision = grant?.revision ?? 0;
    if (state.grantRevision > latestRevision)
      throw new Error("optimization_lab: referenced grant missing");
    if (state.grantRevision < latestRevision) {
      // Grant is durable before the mutable head. Recover a crash between the
      // two writes toward the newest control intent, especially revocation.
      state = {
        ...state,
        grantRevision: latestRevision,
        revision: state.revision + 1,
        controlRevision: state.controlRevision + 1,
      };
      writeAtomicFile(join(directory, "state.json"), canonicalJson(state));
    }
    const leaseRaw = readJson(join(directory, "lease.json"));
    const lease = leaseRaw === undefined ? null : LeaseRecordSchema.parse(leaseRaw);
    return { plan, state, grant, lease };
  }

  assertFenceUnlocked(directory: string, fence: LeaseFence, now = Date.now()): LeaseRecord {
    const lease = LeaseRecordSchema.parse(readJson(join(directory, "lease.json")));
    if (
      lease.owner !== fence.owner ||
      lease.generation !== fence.generation ||
      now >= lease.expiresAt
    )
      throw new Error("optimization_lab: lease lost or expired");
    return lease;
  }

  assertAdmitted(id: string, fence: LeaseFence, now = Date.now()): ExperimentSnapshot {
    return this.withLock(id, (directory) => {
      this.assertFenceUnlocked(directory, fence, now);
      const snapshot = this.readUnlocked(directory, id);
      if (!snapshot.grant) throw new Error("optimization_lab: experiment is not authorized");
      assertGrantActive(snapshot.grant, snapshot.plan.planHash, now);
      if (snapshot.state.stopRequested) throw new Error("optimization_lab: stop requested");
      return snapshot;
    });
  }

  mutate(
    id: string,
    options: MutationOptions,
    fn: (state: ExperimentState, snapshot: ExperimentSnapshot) => ExperimentState | void,
  ): ExperimentSnapshot {
    return this.withLock(id, (directory) => {
      const snapshot = this.readUnlocked(directory, id);
      if (
        options.expectedRevision !== undefined &&
        snapshot.state.revision !== options.expectedRevision
      )
        throw new Error("optimization_lab: stale state revision");
      if (options.fence) this.assertFenceUnlocked(directory, options.fence, options.now);
      const state = structuredClone(snapshot.state);
      const returned = fn(state, snapshot);
      if (returned && typeof (returned as unknown as { then?: unknown }).then === "function")
        throw new Error("optimization_lab: asynchronous state mutation forbidden");
      const next = StateSchema.parse({
        ...(returned ?? state),
        id,
        revision: snapshot.state.revision + 1,
      });
      if (
        next.grantRevision !== snapshot.state.grantRevision ||
        next.controlRevision !== snapshot.state.controlRevision
      )
        throw new Error("optimization_lab: control fields require control mutation");
      canonicalJson(next);
      writeAtomicFile(join(directory, "state.json"), canonicalJson(next));
      return { ...snapshot, state: next };
    });
  }

  /** Trusted host only: append revision without needing a fictitious execution lease. */
  appendGrant(id: string, raw: BudgetGrant, expectedRevision?: number): ExperimentSnapshot {
    return this.withLock(id, (directory) => {
      const snapshot = this.readUnlocked(directory, id);
      const grant = verifyBudgetGrant(raw, snapshot.plan.planHash);
      if (
        snapshot.grant?.revision === grant.revision &&
        canonicalJson(snapshot.grant) === canonicalJson(grant)
      )
        return snapshot;
      if (expectedRevision !== undefined && snapshot.state.revision !== expectedRevision)
        throw new Error("optimization_lab: stale state revision");
      if (grant.revision !== snapshot.state.grantRevision + 1)
        throw new Error("optimization_lab: grant revisions must append");
      if (snapshot.grant && grant.startOperationId !== snapshot.grant.startOperationId)
        throw new Error("optimization_lab: start operation identity is immutable");
      this.ensureDirectory(join(directory, "grants"));
      const path = join(directory, "grants", `${grant.revision}.json`);
      const serialized = canonicalJson(grant);
      const existing = readBoundedFile(path);
      if (existing !== undefined && existing !== serialized)
        throw new Error("optimization_lab: immutable grant conflict");
      if (existing === undefined) writeAtomicFile(path, serialized);
      const state = {
        ...snapshot.state,
        revision: snapshot.state.revision + 1,
        controlRevision: snapshot.state.controlRevision + 1,
        grantRevision: grant.revision,
      };
      writeAtomicFile(join(directory, "state.json"), canonicalJson(state));
      return { ...snapshot, state, grant };
    });
  }

  requestStop(id: string, expectedRevision?: number): ExperimentSnapshot {
    return this.withLock(id, (directory) => {
      const snapshot = this.readUnlocked(directory, id);
      if (expectedRevision !== undefined && snapshot.state.revision !== expectedRevision)
        throw new Error("optimization_lab: stale state revision");
      if (snapshot.state.stopRequested) return snapshot;
      const state = {
        ...snapshot.state,
        revision: snapshot.state.revision + 1,
        controlRevision: snapshot.state.controlRevision + 1,
        stopRequested: true,
      };
      writeAtomicFile(join(directory, "state.json"), canonicalJson(state));
      return { ...snapshot, state };
    });
  }

  putJson(id: string, kind: string, value: unknown, fence?: LeaseFence): ArtifactRef {
    return this.putText(id, kind, canonicalJson(value), fence, "json");
  }
  getJson<T = unknown>(id: string, kind: string, hash: string): T {
    return JSON.parse(this.getText(id, kind, hash, "json")) as T;
  }
  putText(
    id: string,
    kind: string,
    text: string,
    fence?: LeaseFence,
    extension = "txt",
  ): ArtifactRef {
    return this.withLock(id, (directory) => {
      if (fence) this.assertFenceUnlocked(directory, fence);
      const path = this.artifactPath(directory, kind, sha256Hex(text), extension, true);
      const existing = readBoundedFile(path);
      if (existing !== undefined && existing !== text)
        throw new Error("optimization_lab: immutable artifact corruption");
      if (existing === undefined) writeAtomicFile(path, text);
      return { hash: sha256Hex(text), path };
    });
  }
  getText(id: string, kind: string, hash: string, extension = "txt"): string {
    return this.withLock(id, (directory) => {
      const path = this.artifactPath(directory, kind, hash, extension, false);
      const text = readBoundedFile(path);
      if (text === undefined || sha256Hex(text) !== hash)
        throw new Error("optimization_lab: artifact missing or corrupt");
      return text;
    });
  }
  private artifactPath(
    directory: string,
    kind: string,
    hash: string,
    extension: string,
    create: boolean,
  ): string {
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/.test(kind) ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      !/^[a-z]{1,8}$/.test(extension)
    )
      throw new Error("optimization_lab: invalid artifact identity");
    const folder = join(directory, kind);
    if (create || existsSync(folder)) this.ensureDirectory(folder);
    return join(folder, `${hash}.${extension}`);
  }
}
