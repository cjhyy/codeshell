import type { UsageReceipt, UsageSummary, UsageTotals } from "./types.js";

function totals(): UsageTotals {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    knownEstimatedCostUsd: 0,
    unknownCostRequests: 0,
    unknownUsageRequests: 0,
  };
}

function add(target: UsageTotals, receipt: UsageReceipt): void {
  target.requests++;
  const usage = receipt.usage;
  if (usage) {
    target.promptTokens += usage.promptTokens;
    target.completionTokens += usage.completionTokens;
    target.totalTokens += usage.totalTokens;
    target.cacheReadTokens += usage.cacheReadTokens ?? 0;
    target.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
  } else target.unknownUsageRequests++;
  if (receipt.estimatedCostUsd === null) target.unknownCostRequests++;
  else target.knownEstimatedCostUsd += receipt.estimatedCostUsd;
}

export function summarizeReceipts(
  receipts: readonly UsageReceipt[],
  metadata: Omit<UsageSummary, keyof UsageTotals | "byModel" | "bySession" | "byPurpose">,
): UsageSummary {
  const result: UsageSummary = {
    ...totals(),
    ...metadata,
    byModel: [],
    bySession: [],
    byPurpose: [],
  };
  const models = new Map<string, UsageSummary["byModel"][number]>();
  const sessions = new Map<string, UsageSummary["bySession"][number]>();
  const purposes = new Map<string, UsageSummary["byPurpose"][number]>();
  for (const receipt of receipts) {
    add(result, receipt);
    const key = JSON.stringify([receipt.provider, receipt.providerKind, receipt.model]);
    const model = models.get(key) ?? {
      ...totals(),
      provider: receipt.provider,
      providerKind: receipt.providerKind,
      model: receipt.model,
    };
    const session = sessions.get(receipt.accountingSessionId) ?? {
      ...totals(),
      sessionId: receipt.sessionId,
      accountingSessionId: receipt.accountingSessionId,
    };
    const purpose = purposes.get(receipt.purpose) ?? { ...totals(), purpose: receipt.purpose };
    for (const group of [model, session, purpose]) add(group, receipt);
    models.set(key, model);
    sessions.set(receipt.accountingSessionId, session);
    purposes.set(receipt.purpose, purpose);
  }
  result.byModel = [...models.values()];
  result.bySession = [...sessions.values()];
  result.byPurpose = [...purposes.values()];
  return result;
}

export function formatUsageCost(
  summary: Pick<UsageSummary, "knownEstimatedCostUsd" | "unknownCostRequests" | "partial">,
): string {
  const known = `~$${summary.knownEstimatedCostUsd.toFixed(6)}`;
  const cost = summary.unknownCostRequests
    ? `${known} + ${summary.unknownCostRequests} unknown`
    : known;
  return summary.partial ? `${cost} (partial)` : cost;
}
