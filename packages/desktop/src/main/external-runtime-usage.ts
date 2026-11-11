import { createHash } from "node:crypto";
import { join } from "node:path";
import { UsageLedger, type TokenUsage, type TerminalReason } from "@cjhyy/code-shell-core";

/** A CLI submission can contain several models and API calls. */
export const EXTERNAL_CLI_USAGE_MODEL = "cli-turn-aggregate";

export function captureExternalRuntimeUsage(input: {
  root: string;
  sessionId: string;
  runId: string;
  submissionId: string;
  provider: string;
  costState: unknown;
  /** Recheck directory/run custody, then return its current accounting reference. */
  currentCostState(): unknown;
}): (usage: TokenUsage | undefined, reason: TerminalReason) => void {
  const ledger = new UsageLedger({ storageDir: join(input.root, ".usage-ledger") });
  // Only the operation lease may establish accounting ownership. Never mint a
  // replacement owner here or scan historical receipts on the send path.
  if (!ledger.adoptSession(input.sessionId, input.costState, input.root))
    throw new Error("External usage has no current accounting owner");
  const owner = ledger.owner(input.sessionId, input.runId, [], "external", input.root);
  const requestId = createHash("sha256")
    .update(
      JSON.stringify([input.root, owner.accountingSessionId, input.provider, input.submissionId]),
    )
    .digest("hex");
  return (usage, reason) => {
    if (
      !ledger.adoptSession(input.sessionId, input.currentCostState(), input.root) ||
      ledger.owner(input.sessionId, input.runId, [], "external", input.root).accountingSessionId !==
        owner.accountingSessionId
    )
      throw new Error("External usage accounting owner changed");
    const { receipt } = ledger.recordExternalWithStatus(owner, {
      source: "external-cli-turn-v1",
      requestId,
      provider: input.provider,
      providerKind: "external-cli",
      model: EXTERNAL_CLI_USAGE_MODEL,
      ...(usage ? { usage } : {}),
    });
    if (reason !== "completed") ledger.finish(receipt, "failed");
  };
}
