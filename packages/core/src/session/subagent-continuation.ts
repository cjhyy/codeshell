import type { SubAgentContinuation } from "../types.js";

/** Reject corrupt or legacy metadata rather than restoring a wider child scope. */
export function parseSubAgentContinuation(
  value: unknown,
  parentSessionId: unknown,
): SubAgentContinuation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (
    data.version !== 1 ||
    typeof data.parentSessionId !== "string" ||
    !data.parentSessionId ||
    data.parentSessionId !== parentSessionId ||
    (data.agentType !== null && (typeof data.agentType !== "string" || !data.agentType.trim())) ||
    typeof data.description !== "string" ||
    !Number.isSafeInteger(data.maxTurns) ||
    (data.maxTurns as number) <= 0 ||
    typeof data.readOnlySession !== "boolean"
  ) {
    return undefined;
  }
  const optionalStrings = ["name", "model", "appendSystemPrompt"] as const;
  for (const key of optionalStrings) {
    if (data[key] !== undefined && typeof data[key] !== "string") return undefined;
  }
  const allowlists = ["toolAllowlist", "skillAllowlist", "mcpAllowlist"] as const;
  for (const key of allowlists) {
    const list = data[key];
    if (
      list !== undefined &&
      (!Array.isArray(list) || list.some((item) => typeof item !== "string" || !item.trim()))
    ) {
      return undefined;
    }
  }
  if (
    data.sandboxMode !== undefined &&
    !["off", "auto", "seatbelt", "bwrap"].includes(data.sandboxMode as string)
  ) {
    return undefined;
  }
  // Reconstruct a canonical detached value: persisted JSON omits undefined keys,
  // and caller mutations must not change the frozen snapshot held by a Session.
  const result: SubAgentContinuation = {
    version: 1,
    parentSessionId: data.parentSessionId,
    agentType: data.agentType as string | null,
    description: data.description,
    maxTurns: data.maxTurns as number,
    readOnlySession: data.readOnlySession,
  };
  for (const key of optionalStrings) {
    if (data[key] !== undefined) result[key] = data[key] as string;
  }
  for (const key of allowlists) {
    if (data[key] !== undefined) result[key] = [...(data[key] as string[])];
  }
  if (data.sandboxMode !== undefined) {
    result.sandboxMode = data.sandboxMode as SubAgentContinuation["sandboxMode"];
  }
  return result;
}
