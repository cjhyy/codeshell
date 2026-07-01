import type { TranslationKey } from "../i18n/dict";
import type { TranslateParams } from "../i18n/translate";

type T = (k: TranslationKey, o?: TranslateParams) => string;

/** Relative time for cron next/last run — "约 3 小时后" / "2 小时前". `now` is
 *  injectable for testing. Returns "—" for null. Keys resolved via t(). */
export function fmtRelative(ms: number | null, t: T, now = Date.now()): string {
  if (ms == null) return "—";
  const diff = ms - now;
  const future = diff >= 0;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60_000);
  const hr = Math.round(abs / 3_600_000);
  const day = Math.round(abs / 86_400_000);
  if (min < 1) return t("auto.rel.now");
  if (min < 60) return t(future ? "auto.rel.inMinutes" : "auto.rel.minutesAgo", { n: min });
  if (hr < 24) return t(future ? "auto.rel.inHours" : "auto.rel.hoursAgo", { n: hr });
  return t(future ? "auto.rel.inDays" : "auto.rel.daysAgo", { n: day });
}
