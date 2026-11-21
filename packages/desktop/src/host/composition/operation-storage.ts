import { createLinkOperationReviewStore } from "@cjhyy/code-shell-core/internal";
import { readProtectedOperationKey } from "@cjhyy/code-shell-core/internal/operations";
import {
  operationRootIdentity,
  operationRegistryRevision,
  type OperationProjectScope,
} from "../../main/operation-authority.js";
import type { OperationSnapshot } from "../../main/desktop-host/private-operations.js";
import { claimBusinessCommit } from "./business-calls.js";

import { preparedOperationCipher, type PreparedOperationKey } from "./operation-key.js";
export type { PreparedOperationKey } from "./operation-key.js";
export interface ResolveOperation {
  owner: OperationSnapshot["owner"];
  sessionId: string;
  id: string;
  revision: string;
  expires: number;
  scope: OperationProjectScope;
  key: PreparedOperationKey | null;
  permit: Int32Array;
}
export class OperationStorage {
  constructor(
    private readonly root: string,
    private readonly registry = operationRegistryRevision,
    private readonly identity = operationRootIdentity,
  ) {}
  wrappedKey() {
    return readProtectedOperationKey(this.root);
  }
  review(sessionId: string, key: PreparedOperationKey | null) {
    const store = createLinkOperationReviewStore(this.root, {
      ledgerCipher: preparedOperationCipher(key),
    });
    const snapshot = store.review(sessionId);
    const { sessionId: id, status, workspace, workspaceProfile } = snapshot.owner.state;
    return {
      ...snapshot,
      owner: { ...snapshot.owner, state: { sessionId: id, status, workspace, workspaceProfile } },
    };
  }
  resolve(req: ResolveOperation) {
    const store = createLinkOperationReviewStore(this.root, {
      ledgerCipher: preparedOperationCipher(req.key),
    });
    store.resolve(req.sessionId, req.owner, req.id, req.revision, () => {
      if (
        this.registry() !== req.scope.authority ||
        this.identity(req.scope.cwd) !== req.scope.root ||
        Date.now() >= req.expires
      )
        throw new Error("Operation project changed");
      claimBusinessCommit(req.permit);
    });
    return true;
  }
}
