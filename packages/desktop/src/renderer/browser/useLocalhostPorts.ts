import { useEffect, useMemo, useState } from "react";

// Common dev-server ports (subset of Codex's list). We can't open raw TCP
// sockets from the renderer, so we probe each with a no-cors fetch and treat
// "reachable" (resolved or opaque) as up; CSP allows http://localhost:*.
const CANDIDATE_PORTS = [
  3000, 3001, 4000, 5000, 5173, 5174, 6006, 7000, 8000, 8080, 8888, 9000, 1420, 1313,
];

export function useLocalhostPorts(): number[] {
  const [open, setOpen] = useState<number[]>([]);
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      const live: number[] = [];
      await Promise.all(
        CANDIDATE_PORTS.map(async (port) => {
          try {
            await fetch(`http://localhost:${port}`, { mode: "no-cors", signal: AbortSignal.timeout(800) });
            live.push(port);
          } catch {
            /* not listening */
          }
        }),
      );
      if (!cancelled) setOpen(live.sort((a, b) => a - b));
    };
    void probe();
    return () => {
      cancelled = true;
    };
  }, []);
  return useMemo(() => open, [open]);
}
