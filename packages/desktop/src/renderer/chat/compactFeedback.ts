import type { TFunction } from "../i18n/I18nProvider";

export interface CompactFeedbackInput {
  before: number;
  after: number;
  strategy: string;
}

const STRATEGY_LABEL_KEYS = {
  compacted: "chat.compact.strategy.compacted",
  summary: "chat.compact.strategy.summary",
  snip: "chat.compact.strategy.snip",
  window: "chat.compact.strategy.window",
  micro: "chat.compact.strategy.micro",
  emergency: "chat.compact.strategy.emergency",
} as const;

type KnownCompactStrategy = keyof typeof STRATEGY_LABEL_KEYS;

function isKnownCompactStrategy(strategy: string): strategy is KnownCompactStrategy {
  return Object.prototype.hasOwnProperty.call(STRATEGY_LABEL_KEYS, strategy);
}

export function compactStrategyLabel(strategy: string, t: TFunction): string {
  return isKnownCompactStrategy(strategy) ? t(STRATEGY_LABEL_KEYS[strategy]) : strategy;
}

export function compactReductionPercent(before: number, after: number): number {
  if (!Number.isFinite(before) || before <= 0) return 0;
  const saved = Math.max(0, before - after);
  return Math.round((saved / before) * 100);
}

export function compactWasNoop(result: CompactFeedbackInput): boolean {
  return result.after >= result.before;
}

function formatTokenCount(tokens: number, locale?: string): string {
  const safe = Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)) : 0;
  return new Intl.NumberFormat(locale).format(safe);
}

function compactSuccessParams(result: CompactFeedbackInput, t: TFunction, locale?: string) {
  return {
    before: formatTokenCount(result.before, locale),
    after: formatTokenCount(result.after, locale),
    percent: compactReductionPercent(result.before, result.after),
    strategy: compactStrategyLabel(result.strategy, t),
  };
}

export function compactOutcomeMessage(
  result: CompactFeedbackInput,
  t: TFunction,
  locale?: string,
): string {
  if (compactWasNoop(result)) {
    return t("chat.compact.unchanged", {
      tokens: formatTokenCount(result.after, locale),
    });
  }
  return t("chat.compact.done", compactSuccessParams(result, t, locale));
}

export function compactBoundaryDetail(
  result: CompactFeedbackInput,
  t: TFunction,
  locale?: string,
): string {
  return t("chat.compact.boundaryDetail", compactSuccessParams(result, t, locale));
}
