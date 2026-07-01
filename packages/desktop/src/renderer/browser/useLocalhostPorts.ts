import { useEffect, useMemo, useState } from "react";

// Port discovery is done in main via real TCP connect (see main/port-probe.ts).
// The old renderer no-cors fetch sprayed failed requests into the DevTools
// console and mis-read opaque responses as 403; main's connect probe is silent
// and accurate. The candidate port list also lives in main now.
export function useLocalhostPorts(): number[] {
  const [open, setOpen] = useState<number[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.codeshell
      .probeLocalhostPorts()
      .then((live) => {
        if (!cancelled) setOpen(live);
      })
      .catch(() => {
        if (!cancelled) setOpen([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return useMemo(() => open, [open]);
}
