import {
  ScopedRunLedger,
  GITHUB_OPERATION_CONFLICT_SCOPE,
  isOperationLedgerRequest,
  type OperationLedgerRequest,
} from "@cjhyy/code-shell-core/internal/operations";
import {
  OperationKeyChanged,
  preparedOperationCipher,
  type PreparedOperationKey,
} from "./operation-key.js";
import { claimBusinessCommit } from "./business-calls.js";

export class RunOperationStorage {
  private readonly runs = new Map<string, ScopedRunLedger>();
  constructor(private readonly root: string) {}
  end(token: string) {
    this.runs.delete(token);
    return true;
  }
  run({
    token,
    request,
    key,
    permit,
  }: {
    token: string;
    request: OperationLedgerRequest;
    key: PreparedOperationKey | null;
    permit: Int32Array;
  }) {
    if (
      typeof token !== "string" ||
      token.length !== 36 ||
      !isOperationLedgerRequest(request) ||
      Atomics.load(permit, 0) !== 0
    )
      throw new Error("Operation Run revoked");
    const existing = this.runs.get(token);
    if (existing) return existing.run(request, () => claimBusinessCommit(permit));
    if (this.runs.size >= 128) throw new Error("Too many active operation Runs");
    const ledger = new ScopedRunLedger(
      this.root,
      request.sessionId,
      request.runId,
      preparedOperationCipher(key),
      key?.wrapped,
      GITHUB_OPERATION_CONFLICT_SCOPE,
      request.ephemeral,
    );
    try {
      const result = ledger.run(request, () => claimBusinessCommit(permit));
      if (key || request.method === "sealForFinalization") this.runs.set(token, ledger);
      return result;
    } catch (error) {
      // Another application instance can initialize the shared ledger between keyring
      // preparation and the file lock. The cipher failed before consuming this call's permit.
      if (error instanceof OperationKeyChanged && Atomics.load(permit, 0) === 0)
        return "retryCanonicalKey";
      throw error;
    }
  }
}
