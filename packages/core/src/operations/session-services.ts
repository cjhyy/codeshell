import { createSessionOperationController } from "./controller.js";
import { CapabilityResolver } from "./resolver.js";
import type { UsageLedger } from "../cost-ledger/store.js";
import type { ToolContext } from "../tool-system/context.js";

/** Trusted Host composition shared with runtimes that own their own model loop. */
export function createSessionOperationServices(
  root: string,
  sessionId: string,
  runId: string,
  usageLedger: UsageLedger,
  assertAuthorized?: () => void,
): NonNullable<ToolContext["operations"]> {
  return {
    assertAuthorized,
    controller: createSessionOperationController(root, sessionId, usageLedger, assertAuthorized),
    resolver: new CapabilityResolver(),
    sessionId,
    runId,
  };
}
