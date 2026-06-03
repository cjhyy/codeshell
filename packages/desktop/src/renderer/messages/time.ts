/**
 * Time formatting for message footers (ask/answer times).
 *
 * Two helpers:
 *  - formatClockTime: bare wall-clock time-of-day ("14:32").
 *  - formatMessageTime: an *absolute* timestamp with a context-aware date
 *    prefix — today shows only the time, yesterday shows "昨天", earlier this
 *    (calendar) week shows the weekday, anything older shows the full date.
 *
 * Both return null for absent timestamps so callers can omit the affordance on
 * replayed / historical transcripts (FoldItem carries no original timestamp).
 */

function isFiniteMs(ms?: number): ms is number {
  return typeof ms === "number" && Number.isFinite(ms);
}

/**
 * Bare wall-clock time-of-day, e.g. "14:32". Returns null for absent /
 * non-finite timestamps.
 */
export function formatClockTime(ms?: number): string | null {
  if (!isFiniteMs(ms)) return null;
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Local midnight (00:00) of the day containing `d`. */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Local midnight of the Monday that opens the calendar week containing `d`.
 * getDay() is 0=Sun..6=Sat; we treat Monday as the week's first day (zh
 * convention), so Sunday rolls back 6 days, Monday 0, … Saturday 5.
 */
function startOfWeekMonday(d: Date): number {
  const dayMidnight = startOfDay(d);
  const dow = new Date(dayMidnight).getDay(); // 0..6, Sun..Sat
  const daysFromMonday = (dow + 6) % 7; // Mon→0, Sun→6
  return dayMidnight - daysFromMonday * 86_400_000;
}

/**
 * Absolute timestamp with a context-aware date prefix:
 *   - today              → "14:32"
 *   - yesterday          → "昨天 14:32"
 *   - earlier this week  → "星期一 14:32"   (weekday, Monday-start week)
 *   - older              → "2026/05/20 14:32"
 *
 * `now` is injectable for testing; defaults to the current time. Returns null
 * for absent / non-finite timestamps.
 */
export function formatMessageTime(ms?: number, now: number = Date.now()): string | null {
  if (!isFiniteMs(ms)) return null;
  const d = new Date(ms);
  const clock = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const nowDate = new Date(now);
  const todayStart = startOfDay(nowDate);
  const yesterdayStart = todayStart - 86_400_000;
  const weekStart = startOfWeekMonday(nowDate);
  const tsDayStart = startOfDay(d);

  if (tsDayStart >= todayStart) return clock; // today (and any same-day future)
  if (tsDayStart >= yesterdayStart) return `昨天 ${clock}`;
  if (tsDayStart >= weekStart) {
    const weekday = d.toLocaleDateString("zh-CN", { weekday: "long" });
    return `${weekday} ${clock}`;
  }
  const date = d.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // zh-CN long date uses "2026/05/20" with the chosen options; normalize any
  // locale separator quirks to slashes so the "/" the UI keys off is present.
  return `${date.replace(/[-.]/g, "/")} ${clock}`;
}
