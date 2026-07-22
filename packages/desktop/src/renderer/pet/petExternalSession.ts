import type { PetExternalSessionLocator, PetSessionProjection } from "../../preload/types";

/** Return a complete external-CLI locator or null. `agentSessionId` is the
 * canonical external id; cwd is never inferred from labels, so stale
 * projections stay disabled and fail closed. */
export function petExternalSessionLocator(
  session: Pick<PetSessionProjection, "agentSessionId" | "external">,
): PetExternalSessionLocator | null {
  const external = session.external;
  if (
    !external ||
    (external.cli !== "codex" && external.cli !== "claude") ||
    typeof external.cwd !== "string" ||
    !external.cwd.trim() ||
    typeof session.agentSessionId !== "string" ||
    !session.agentSessionId.trim()
  ) {
    return null;
  }
  return {
    cli: external.cli,
    cwd: external.cwd,
    sessionId: session.agentSessionId,
  };
}
