import { type BusinessGrant } from "../../host/composition/business-calls.js";
import { randomUUID } from "node:crypto";
import type {
  PreparedOperationKey,
  ResolveOperation,
} from "../../host/composition/operation-storage.js";
import type { DesktopHostIdentity } from "../../shared/desktop-host-protocol.js";
import {
  operationRootIdentity,
  operationRegistryRevision,
  type OperationProjectScope,
} from "../operation-authority.js";
import type {
  CaptureOperation,
  PrivateOperationCommand,
  OperationSnapshot,
} from "./private-operations.js";

/** Private parent pipe only. The first preview pins a document and Session epoch through native confirmation. */
export class HostOperationReviews {
  private readonly pending = new Map<Int32Array, () => void>();
  authorityChanged() {
    for (const [permit, check] of this.pending) {
      try {
        check();
      } catch {
        Atomics.compareExchange(permit, 0, 0, -1);
      }
    }
  }
  private readonly previews = new Map<
    string,
    {
      frame: string;
      sessionId: string;
      snapshot: OperationSnapshot;
      scope: OperationProjectScope;
      guard: ReturnType<CaptureOperation>;
      expires: number;
    }
  >();
  constructor(
    private readonly store: {
      wrappedKey?(): Promise<string | null>;
      review(
        sessionId: string,
        key: PreparedOperationKey | null,
      ): OperationSnapshot | Promise<OperationSnapshot>;
      resolve(req: ResolveOperation): boolean | Promise<boolean>;
    },
    private readonly revisions = operationRegistryRevision,
    private readonly identity = operationRootIdentity,
  ) {}
  private drop(token: string) {
    this.previews.get(token)?.guard.release?.();
    this.previews.delete(token);
  }
  async withPending<T>(
    guard: ReturnType<CaptureOperation>,
    grant: BusinessGrant,
    work: () => Promise<T>,
  ) {
    try {
      guard.assertCurrent();
      grant.assertCurrent();
      this.pending.set(grant.permit, guard.assertCurrent);
      return await work();
    } finally {
      this.pending.delete(grant.permit);
      guard.release?.();
    }
  }
  async run(
    method: PrivateOperationCommand,
    caller: DesktopHostIdentity,
    params: Record<string, unknown>,
    capture: CaptureOperation,
    grant: BusinessGrant,
  ) {
    grant.assertCurrent();
    for (const [token, entry] of this.previews) if (entry.expires <= Date.now()) this.drop(token);
    const { sessionId } = params;
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128)
      throw new Error("Invalid operation Session");
    if (method === "host/operationReview") {
      const scope = params.scope as OperationProjectScope;
      if (
        !scope ||
        typeof scope.cwd !== "string" ||
        this.revisions() !== scope.authority ||
        this.identity(scope.cwd) !== scope.root
      )
        throw new Error("Operation project changed");
      const guard = capture(caller, sessionId);
      try {
        guard.assertCurrent();
        const snapshot = await this.store.review(
          sessionId,
          (params.key as PreparedOperationKey | null) ?? null,
        );
        guard.assertCurrent();
        grant.assertCurrent();
        if (snapshot.owner.state.status === "active")
          throw new Error("Stop the active Session before review");
        for (const [token, owner] of this.previews)
          if (owner.frame === caller.frameToken) this.drop(token);
        if (this.previews.size >= 8) throw new Error("Too many operation reviews");
        const token = randomUUID();
        this.previews.set(token, {
          frame: caller.frameToken,
          sessionId,
          snapshot,
          scope,
          guard,
          expires: Date.now() + 60000,
        });
        return { token, snapshot };
      } catch (error) {
        guard.release?.();
        throw error;
      }
    }
    const { token, id, revision } = params;
    const preview = typeof token === "string" ? this.previews.get(token) : undefined;
    if (
      !preview ||
      typeof token !== "string" ||
      typeof id !== "string" ||
      typeof revision !== "string" ||
      preview.frame !== caller.frameToken ||
      preview.sessionId !== sessionId ||
      !preview.snapshot.records.some(
        (entry) => entry.id === id && entry.revision === revision && entry.canResolve,
      )
    )
      throw new Error("Operation review expired or changed");
    this.previews.delete(token);
    const current = () => {
      preview.guard.assertCurrent();
      if (
        this.revisions() !== preview.scope.authority ||
        this.identity(preview.scope.cwd) !== preview.scope.root ||
        preview.expires <= Date.now()
      )
        throw new Error("Operation project changed");
    };
    try {
      current();
      this.pending.set(grant.permit, current);
      if (method === "host/operationReadKey") {
        if (!this.store.wrappedKey) throw new Error("Operation storage unavailable");
        const wrapped = await this.store.wrappedKey();
        current();
        grant.assertCurrent();
        if (typeof wrapped !== "string") throw new Error("Reviewed operation key unavailable");
        return { wrapped };
      }
      return await this.store.resolve({
        sessionId,
        owner: preview.snapshot.owner,
        id,
        revision,
        expires: preview.expires,
        scope: preview.scope,
        key: (params.key as PreparedOperationKey | null) ?? null,
        permit: grant.permit,
      });
    } finally {
      this.pending.delete(grant.permit);
      preview.guard.release?.();
    }
  }
}
