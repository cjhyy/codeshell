import { connect } from "node:net";

/**
 * Localhost dev-server discovery for the browser panel. Runs in main as a real
 * TCP connect — connecting successfully means something is listening. Unlike the
 * old renderer `fetch(..., {mode:"no-cors"})` this makes no HTTP request, so
 * there's no CORS, no opaque-response 403 false-read, and nothing sprayed into
 * the DevTools console.
 */

const PROBE_TIMEOUT_MS = 300;

function isProbablePort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535;
}

/**
 * True when 127.0.0.1:<port> accepts a TCP connection. Resolves (never rejects)
 * — a refused/timed-out/errored connect is just "closed".
 */
export function probePort(port: number): Promise<boolean> {
  if (!isProbablePort(port)) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (open: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(open);
    };
    const socket = connect({ port, host: "127.0.0.1" });
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** Probe a candidate list concurrently; return the open ports, ascending. */
export async function probeLocalhostPorts(ports: number[]): Promise<number[]> {
  const candidates = ports.filter(isProbablePort);
  const results = await Promise.all(
    candidates.map(async (port) => ({ port, open: await probePort(port) })),
  );
  return results
    .filter((r) => r.open)
    .map((r) => r.port)
    .sort((a, b) => a - b);
}
