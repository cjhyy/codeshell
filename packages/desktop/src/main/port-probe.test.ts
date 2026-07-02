import { describe, test, expect, afterEach } from "bun:test";
import { createServer, type Server } from "node:net";
import { probeLocalhostPorts, probePort } from "./port-probe";

/**
 * Port discovery for the browser panel's "open a running dev server" suggestions
 * must not spray no-cors fetches from the renderer (control-console noise + 403
 * false-reads on opaque responses). It lives in main as a real TCP connect:
 * connect-ok = something is listening, no HTTP, no CORS.
 */
async function listenOnEphemeral(): Promise<{ server: Server; port: number }> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

describe("port-probe (main, real TCP)", () => {
  let servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    servers = [];
  });

  test("probePort → true for a port with a listener", async () => {
    const { server, port } = await listenOnEphemeral();
    servers.push(server);
    expect(await probePort(port)).toBe(true);
  });

  test("probePort → false for a closed port (no listener)", async () => {
    // Grab an ephemeral port then close it, so it's almost certainly free.
    const { server, port } = await listenOnEphemeral();
    await new Promise<void>((r) => server.close(() => r()));
    expect(await probePort(port)).toBe(false);
  });

  test("probePort resolves (never hangs/throws) on an unlikely-open port", async () => {
    // A high port very unlikely to have a listener; must resolve false, not throw.
    const result = await probePort(65533);
    expect(typeof result).toBe("boolean");
  });

  test("probeLocalhostPorts returns only the open ports, sorted", async () => {
    const a = await listenOnEphemeral();
    const b = await listenOnEphemeral();
    servers.push(a.server, b.server);
    // Include one closed port in the candidate set.
    const closed = await listenOnEphemeral();
    await new Promise<void>((r) => closed.server.close(() => r()));

    const open = await probeLocalhostPorts([b.port, a.port, closed.port]);
    expect(open).toEqual([a.port, b.port].sort((x, y) => x - y));
  });

  test("probeLocalhostPorts ignores non-positive / invalid ports", async () => {
    const open = await probeLocalhostPorts([0, -1, 70000, NaN]);
    expect(open).toEqual([]);
  });
});
