/** Host-owned immutable instruction revisions. Never edits a scanned Skill. */
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { codeShellHome } from "../session/session-manager.js";
import { mutateJsonFile } from "../utils/file-mutex.js";
import { readSkillSnapshot } from "./snapshot.js";

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const listeners = new Map<string, Set<() => void>>();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ScopeSchema = z
  .object({
    cwd: z.string().min(1).max(4096),
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(256),
    sessionId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type InstructionScope = z.infer<typeof ScopeSchema>;
export const InstructionSnapshotSchema = z
  .object({
    bindingId: z.string().uuid(),
    cwd: z.string().min(1).max(4096),
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    body: z.string().max(512 * 1024),
    bodyHash: hash,
    sourceRevision: hash,
    revision: hash,
    sessionId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type InstructionSnapshot = z.infer<typeof InstructionSnapshotSchema>;
const BindingSchema = z
  .object({
    snapshot: InstructionSnapshotSchema,
    scope: ScopeSchema,
    evidenceHash: hash,
    receiptIds: z.array(z.string().uuid()).min(1).max(1200),
    createdAt: z.number().int(),
    revokedAt: z.number().int().nullable(),
  })
  .strict();
export type InstructionBinding = z.infer<typeof BindingSchema>;
const StateSchema = z
  .object({ version: z.literal(1), bindings: z.array(BindingSchema).max(1000) })
  .strict();
export interface InstructionBindingProvider {
  resolve(scope: InstructionScope, sessionOnly?: boolean): InstructionSnapshot[];
  isCurrent(snapshot: InstructionSnapshot): boolean;
  subscribe(snapshots: readonly InstructionSnapshot[], revoked: () => void): () => void;
}
const ReceiptSchema = z
  .object({
    id: z.string().uuid(),
    cwd: z.string().min(1).max(4096),
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    sourceRevision: hash,
    bodyHash: hash,
    sessionId: z.string().min(1).max(128),
    completed: z.boolean(),
  })
  .strict();
export type InstructionValidationReceipt = z.infer<typeof ReceiptSchema>;
export function instructionHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}
function sameScope(a: InstructionScope, b: InstructionScope): boolean {
  return (
    a.cwd === b.cwd &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.sessionId === b.sessionId
  );
}
/** The store owns accepted content independently of experiment artifact retention. */
export class InstructionBindingStore {
  readonly root: string;
  private readonly file: string;
  constructor(root = join(codeShellHome(), "instruction-bindings")) {
    this.root = root;
    this.file = join(root, "bindings.json");
  }
  private readBindings(): InstructionBinding[] {
    let fd: number;
    try {
      fd = openSync(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_STATE_BYTES)
        throw new Error("Invalid instruction binding state");
      return StateSchema.parse(JSON.parse(readFileSync(fd, "utf8"))).bindings;
    } finally {
      closeSync(fd);
    }
  }
  private mutate<T>(fn: (bindings: InstructionBinding[]) => T, write = false): T {
    if (!write) return fn(this.readBindings());
    return mutateJsonFile(this.file, {
      parse: (raw) => StateSchema.parse(raw ? JSON.parse(raw) : { version: 1, bindings: [] }),
      mutation: (state) => {
        const result = fn(state.bindings);
        if (write) StateSchema.parse(state);
        return { value: write ? state : undefined, result };
      },
      serialize: (state) => JSON.stringify(state),
      mode: 0o600,
      maxBytes: MAX_STATE_BYTES,
    }) as T;
  }
  readReceipt(id: string): InstructionValidationReceipt {
    z.string().uuid().parse(id);
    const fd = openSync(
      join(this.root, "receipts", `${id}.json`),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 16 * 1024) throw new Error("Invalid instruction receipt");
      return ReceiptSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
    } finally {
      closeSync(fd);
    }
  }
  list(cwd: string): InstructionBinding[] {
    return this.mutate((rows) => rows.filter((row) => row.scope.cwd === realpathSync(cwd)));
  }
  adopt(input: {
    scope: InstructionScope;
    name: string;
    sourceRevision: string;
    body: string;
    evidenceHash: string;
    receiptIds: string[];
  }): InstructionBinding {
    const scope = { ...ScopeSchema.parse(input.scope), cwd: realpathSync(input.scope.cwd) };
    hash.parse(input.evidenceHash);
    const current = readSkillSnapshot(input.name, scope.cwd);
    if (
      !current ||
      current.revisionKind !== "bundle" ||
      current.extraFiles?.length !== 0 ||
      current.revision !== input.sourceRevision
    )
      throw new Error("Source Skill revision changed; revalidate before adoption");
    const bodyHash = instructionHash(input.body);
    if (!input.receiptIds.length) throw new Error("Isolated loading receipts are required");
    for (const id of input.receiptIds) {
      z.string().uuid().parse(id);
      const receipt = this.readReceipt(id);
      if (
        receipt.id !== id ||
        !receipt.completed ||
        realpathSync(receipt.cwd) !== realpathSync(scope.cwd) ||
        receipt.provider !== scope.provider ||
        receipt.model !== scope.model ||
        receipt.name !== input.name ||
        receipt.sourceRevision !== input.sourceRevision ||
        receipt.bodyHash !== bodyHash
      )
        throw new Error("Isolated instruction receipt does not match adoption");
    }
    const revision = instructionHash(
      JSON.stringify({ name: input.name, sourceRevision: input.sourceRevision, bodyHash }),
    );
    return this.mutate((rows) => {
      const active = rows.find(
        (row) =>
          row.revokedAt === null && row.snapshot.name === input.name && sameScope(row.scope, scope),
      );
      if (active) {
        if (active.snapshot.revision === revision && active.evidenceHash === input.evidenceHash)
          return active;
        throw new Error("An instruction binding already occupies this scope; revoke it first");
      }
      const row = BindingSchema.parse({
        snapshot: {
          bindingId: randomUUID(),
          cwd: scope.cwd,
          provider: scope.provider,
          model: scope.model,
          ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
          name: input.name,
          body: input.body,
          bodyHash,
          sourceRevision: input.sourceRevision,
          revision,
        },
        scope,
        evidenceHash: input.evidenceHash,
        receiptIds: input.receiptIds,
        createdAt: Date.now(),
        revokedAt: null,
      });
      if (rows.length >= 1000) throw new Error("Instruction binding store is full");
      if (
        Buffer.byteLength(JSON.stringify({ version: 1, bindings: [...rows, row] }), "utf8") >
        MAX_STATE_BYTES
      )
        throw new Error("Instruction binding store exceeds its byte limit");
      rows.push(row);
      return row;
    }, true);
  }
  revoke(cwd: string, bindingId: string, expectedRevision: string): InstructionBinding {
    const result = this.mutate((rows) => {
      const row = rows.find(
        (row) => row.snapshot.bindingId === bindingId && row.scope.cwd === realpathSync(cwd),
      );
      if (!row || row.snapshot.revision !== expectedRevision)
        throw new Error("Instruction binding revision conflict");
      row.revokedAt ??= Date.now();
      return row;
    }, true);
    for (const notify of listeners.get(this.file) ?? []) notify();
    return result;
  }
  resolve(scope: InstructionScope, sessionOnly = false): InstructionSnapshot[] {
    const rows = this.list(scope.cwd).filter(
      (row) =>
        row.revokedAt === null &&
        (!sessionOnly || (row.scope.sessionId && row.scope.sessionId === scope.sessionId)) &&
        row.scope.provider === scope.provider &&
        row.scope.model === scope.model &&
        (!row.scope.sessionId || row.scope.sessionId === scope.sessionId),
    );
    const byName = new Map<string, InstructionBinding>();
    for (const row of rows) {
      const current = readSkillSnapshot(row.snapshot.name, scope.cwd);
      if (!current || current.revision !== row.snapshot.sourceRevision)
        throw new Error("Adopted source Skill changed; revoke or revalidate the binding");
      const prior = byName.get(row.snapshot.name);
      if (!prior || row.scope.sessionId) byName.set(row.snapshot.name, row);
    }
    return [...byName.values()].map((row) => structuredClone(row.snapshot));
  }
  private areCurrent(snapshots: readonly InstructionSnapshot[]): boolean {
    const rows = new Map(this.readBindings().map((row) => [row.snapshot.bindingId, row]));
    return snapshots.every((snapshot) => {
      const parsed = InstructionSnapshotSchema.safeParse(snapshot);
      if (!parsed.success) return false;
      const row = rows.get(parsed.data.bindingId);
      return Boolean(
        row &&
        row.revokedAt === null &&
        JSON.stringify(row.snapshot) === JSON.stringify(parsed.data) &&
        instructionHash(parsed.data.body) === parsed.data.bodyHash &&
        readSkillSnapshot(row.snapshot.name, row.scope.cwd)?.revision ===
          parsed.data.sourceRevision,
      );
    });
  }
  isCurrent(snapshot: InstructionSnapshot): boolean {
    return this.areCurrent([snapshot]);
  }
  provider(): InstructionBindingProvider {
    return {
      resolve: (scope, sessionOnly) => this.resolve(scope, sessionOnly),
      isCurrent: (snapshot) => this.isCurrent(snapshot),
      subscribe: (snapshots, revoked) => {
        if (!snapshots.length) return () => {};
        let fired = false;
        const check = () => {
          if (fired) return;
          let invalid = true;
          try {
            invalid = !this.areCurrent(snapshots);
          } catch {
            /* fail closed */
          }
          if (invalid) {
            fired = true;
            try {
              revoked();
            } catch {
              /* The Engine rejects the invalid snapshot again before its next run. */
            }
          }
        };
        const owned = listeners.get(this.file) ?? new Set<() => void>();
        listeners.set(this.file, owned);
        owned.add(check);
        const timer = setInterval(check, 1000);
        timer.unref?.();
        return () => {
          clearInterval(timer);
          owned.delete(check);
          if (!owned.size) listeners.delete(this.file);
        };
      },
    };
  }
}
