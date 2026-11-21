import {
  createGithubIssueBatch,
  readOperationSessionOwner,
  githubIssueBatchPolicy,
  type DesktopOperationBatchAuthorityInput,
} from "@cjhyy/code-shell-core/internal";
import type { CredentialMetadata } from "@cjhyy/code-shell-core";
import {
  operationCredentialRevision,
  operationOwnerIdentity,
  operationRegistryRevision,
  operationRootIdentity,
  type OperationProjectScope,
} from "../../main/operation-authority.js";
import type { BatchCommand } from "../../main/desktop-host/private-operations.js";
import { preparedOperationCipher, type PreparedOperationKey } from "./operation-key.js";
import { claimBusinessCommit } from "./business-calls.js";

export interface BatchScope extends OperationProjectScope {
  owner: string;
  policy: string;
  profile?: string;
}
export interface BatchPayload {
  sessionId: string;
  token: string;
  frame: string;
  credentials: string;
  permit: Int32Array;
  proposal?: {
    origin: string;
    connection: CredentialMetadata;
    scope: BatchScope;
    items: unknown;
    key: PreparedOperationKey;
  };
  request?: DesktopOperationBatchAuthorityInput;
  generation?: number;
}
export class OperationBatches {
  private readonly entries = new Map<
    string,
    {
      frame: string;
      sessionId: string;
      scope: BatchScope;
      connectionId: string;
      origin: string;
      handle: ReturnType<typeof createGithubIssueBatch>;
      generation?: number;
      runId?: string;
    }
  >();
  constructor(
    private readonly root: string,
    private readonly registry = operationRegistryRevision,
  ) {}
  run(method: BatchCommand, data: BatchPayload) {
    const { sessionId, frame, token } = data;
    if (
      typeof token !== "string" ||
      token.length < 16 ||
      token.length > 128 ||
      typeof sessionId !== "string" ||
      typeof frame !== "string"
    )
      throw new Error("Invalid batch identity");
    const validate = (scope: BatchScope) => {
      if (
        this.registry() !== scope.authority ||
        operationRootIdentity(scope.cwd) !== scope.root ||
        operationOwnerIdentity(readOperationSessionOwner(this.root, sessionId)) !== scope.owner ||
        githubIssueBatchPolicy(scope.cwd, scope.profile) !== scope.policy ||
        operationCredentialRevision(scope.cwd) !== data.credentials
      )
        throw new Error("Batch authority changed");
    };
    if (method === "host/batchReserve") {
      const proposal = data.proposal;
      if (
        !proposal ||
        this.entries.size >= 128 ||
        this.entries.has(token) ||
        Array.from(this.entries.values()).some((entry) => entry.sessionId === sessionId)
      )
        throw new Error("Batch is already reserved");
      const { origin, scope, key, connection, items } = proposal;
      if (readOperationSessionOwner(this.root, sessionId).state.status === "active")
        throw new Error("Batch Session is running");
      // The same closure is reused by Core on later calls; reservation alone consumes this call's permit.
      let reserving = true,
        claimed = false;
      const handle = createGithubIssueBatch({
        root: this.root,
        sessionId,
        originIntent: origin,
        connection,
        items,
        cipher: preparedOperationCipher(key),
        initialProtectedKey: key.wrapped,
        assertCurrent: () => {
          if (reserving) {
            validate(scope);
            if (!claimed) {
              claimBusinessCommit(data.permit);
              claimed = true;
            }
          }
        },
      });
      reserving = false;
      this.entries.set(token, {
        frame,
        sessionId,
        origin,
        scope,
        connectionId: connection.id,
        handle,
      });
      return { id: handle.id, count: handle.count };
    }
    const entry = this.entries.get(token);
    if (!entry && method === "host/batchClose") return true;
    if (!entry || entry.frame !== frame || entry.sessionId !== sessionId)
      throw new Error("Batch is absent or ended");
    if (method === "host/batchClose") {
      entry.handle.close();
      this.entries.delete(token);
      return true;
    }
    const req = data.request,
      generation = data.generation;
    try {
      const current = readOperationSessionOwner(this.root, sessionId);
      if (
        !req ||
        req.sessionId !== sessionId ||
        req.originIntent !== entry.origin ||
        current.state.status !== "active" ||
        current.state.runId !== req.runId ||
        !Number.isSafeInteger(generation) ||
        (entry.generation !== undefined && entry.generation !== generation) ||
        (entry.runId !== undefined && entry.runId !== req.runId)
      )
        throw new Error("Batch no longer belongs to the active Run");
      validate(entry.scope);
      claimBusinessCommit(data.permit);
      entry.generation = generation;
      entry.runId = req.runId;
      if (method === "host/batchFinish" && req.phase === "finish") return entry.handle.finish();
      if (
        method !== "host/batchResolve" ||
        !["resolve", "check"].includes(req.phase) ||
        req.connectionId !== entry.connectionId
      )
        throw new Error("Invalid batch action");
      return entry.handle.resolve(req.parameters);
    } catch (error) {
      entry.handle.close();
      this.entries.delete(token);
      throw error;
    }
  }
}
