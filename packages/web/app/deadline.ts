import React from "react";

/** Re-render each second until `until` passes; no timer without a deadline. */
export function useNow(until: number | undefined): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (until === undefined) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (current: number) => {
      if (current < until) timer = setTimeout(tick, Math.min(1_000, until - current));
    };
    const tick = () => {
      const current = Date.now();
      setNow(current);
      schedule(current);
    };
    schedule(Date.now());
    return () => clearTimeout(timer);
  }, [until]);
  return now;
}

/** Remaining time as m:ss, rounded up so it never reads 0:00 early. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1_000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Countdown wording for a model question that auto-resolves at its deadline. */
export function autoResolveText(remainingMs: number, recommended: string | undefined): string {
  const time = formatRemaining(remainingMs);
  return recommended !== undefined
    ? `${time} 后未回答将自动选择「${recommended}」`
    : `${time} 后未回答将自动跳过`;
}
