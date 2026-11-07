import { useEffect, useState } from "react";

/** Re-render each second until `until` passes; no timer without a deadline. */
export function useNow(until: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
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

/** Remaining time as m:ss, rounded up so the label never reads 0:00 early. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1_000));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}
