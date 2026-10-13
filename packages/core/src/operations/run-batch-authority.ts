import type {
  DesktopOperationBatchAuthorityInput,
  DesktopOperationBatchAuthorityResult,
} from "./desktop-batch-authority-client.js";

/** A failed tool permanently revokes this concrete worker Run, even if Main is unreachable. */
export function createRunBatchAuthority(input: {
  request(
    data: DesktopOperationBatchAuthorityInput,
    options: { signal?: AbortSignal },
  ): Promise<DesktopOperationBatchAuthorityResult>;
  token: string;
  sessionId: string;
  runId: string;
  originIntent(): string;
  signal?: AbortSignal;
}) {
  let failed = false;
  const request = (
    phase: DesktopOperationBatchAuthorityInput["phase"],
    connectionId: string,
    parameters: Record<string, unknown>,
    options: { signal?: AbortSignal } = { signal: input.signal },
  ) =>
    input.request(
      {
        sessionId: input.sessionId,
        runId: input.runId,
        originIntent: input.originIntent(),
        token: input.token,
        phase,
        connectionId,
        parameters,
      },
      options,
    );
  return {
    async batchAuthority(
      phase: "resolve" | "check",
      connectionId: string,
      parameters: Record<string, unknown>,
    ) {
      if (failed) throw new Error("Batch stopped after a failed or cancelled tool");
      try {
        return await request(phase, connectionId, parameters);
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    async onToolFailure() {
      if (failed) return;
      failed = true;
      // Cleanup does not inherit an already-aborted tool signal. Main validates
      // the same private nonce/run and seals; transport still has its deadline.
      try {
        await request("cancel", "finalization", {}, {});
      } catch {
        /* Local latch remains closed. */
      }
    },
    async hasIncompleteBatch() {
      if (failed) return true;
      try {
        const result = await request("finish", "finalization", {});
        return result.kind !== "batch" || result.allVerified !== true;
      } catch {
        failed = true;
        return true;
      }
    },
  };
}
