import { expect, test } from "bun:test";
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-"))
  throw new Error("Use guarded Bun runner");
const repo = process.cwd();
const { installLocalNetworkGuard } = await import(`${repo}/scripts/runtime-cost-smoke-isolation.mjs`);
installLocalNetworkGuard("http://127.0.0.1:9");
const { HubOutboundTransport } = await import(`${repo}/packages/server/src/hub/outbound-transport.ts`);
test("normal Hub outbound caps simulated backlog, retires only the lagging peer and cannot send again to it", () => {
  // Deliberately mocked backlog: this is a pure Hub-policy normal control,
  // separate from the actual Node TCP/WS measurements in outbound-native.mjs.
  const slow = { OPEN: 1, readyState: 1, bufferedAmount: 8 * 1024 * 1024 + 1, sent: [] as string[], terminated: 0,
    send(line: string, cb?: (error?: Error) => void) { this.sent.push(line); cb?.(); }, terminate() { this.terminated++; this.readyState = 3; this.bufferedAmount = 0; } };
  const healthy = { ...slow, bufferedAmount: 0, sent: [] as string[], terminated: 0 };
  const drops: any[] = [];
  const outbound = new HubOutboundTransport({ tabs: () => [slow, healthy], onDrop: (drop: any) => drops.push(drop) });
  expect(outbound.send(slow, "{}" )).toBe(false);
  expect(slow.terminated).toBe(1);
  expect(slow.sent).toEqual([]);
  expect(drops.map((drop) => drop.reason)).toEqual(["socket-backlog"]);
  expect(outbound.send(healthy, "{}" )).toBe(true);
  expect(healthy.sent).toEqual(["{}"]);
  expect(healthy.terminated).toBe(0);
  expect(outbound.send(slow, "{}" )).toBe(false);
  expect(slow.terminated).toBe(1);
});
