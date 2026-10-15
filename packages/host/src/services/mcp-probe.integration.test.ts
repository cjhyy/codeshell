import { afterAll, afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installFixtureNetworkGuard } from "../../../../tests/helpers/network-fixture.js";
const network = installFixtureNetworkGuard();
afterAll(() => network.restore());
const { probeMcp } = await import("@cjhyy/code-shell-host");
const { probeHubMcp } = await import("../../../server/src/hub/mcp-probe.js");
const { probeMcpServer, invalidateMcpProbeCache } =
  await import("../../../desktop/src/main/mcp-probe-service.js");
const dirs: string[] = [];
afterEach(() => {
  invalidateMcpProbeCache();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(mode = "normal") {
  const dir = mkdtempSync(join(tmpdir(), "host-mcp-probe-"));
  dirs.push(dir);
  const cwd = join(dir, "workspace");
  mkdirSync(cwd);
  const marker = join(dir, "started.json"),
    script = join(dir, "server.mjs");
  writeFileSync(
    script,
    `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
// Worker confinement is installed before accepting any MCP request.
const denied = () => { throw new Error("fixture worker denied network"); };
globalThis.fetch = denied; http.request = denied; https.request = denied; net.Socket.prototype.connect = denied;
const mode = ${JSON.stringify(mode)};
const marker = ${JSON.stringify(marker)};
let child;
if (mode === "descendants") {
  child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  process.on("SIGTERM", () => {});
}
writeFileSync(marker, JSON.stringify({ pid: process.pid, childPid: child?.pid, cwd: process.cwd() }));
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (mode === "hang" || mode === "descendants") return;
  if (msg.method === "initialize") reply(msg.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
  if (msg.method === "tools/list") {
    const page = Number(msg.params?.cursor ?? 0);
    const length = mode === "frame" ? 600000 : mode === "total" ? 350000 : 0;
    reply(msg.id, { tools: [{ name: "tool_" + page, description: "fixture-secret argument-secret " + "x".repeat(length), inputSchema: { type: "object", properties: {} } }], ...(mode === "pages" || mode === "total" ? { nextCursor: String(page + 1) } : mode === "repeat" ? { nextCursor: "repeat" } : {}) });
  }
});
`,
  );
  const config = {
    name: "fixture",
    command: process.execPath,
    args: [script, "argument-secret"],
    env: { TOKEN: "fixture-secret" },
  };
  return { dir, cwd, marker, config };
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error("fixture did not settle");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

test("Desktop and Hub use one real stdio handshake, workspace, preview and redaction path", async () => {
  const f = fixture();
  expect(probeHubMcp).toBe(probeMcp);
  const hub = await probeHubMcp(
    { ...f.config, disabledTools: ["tool_0"] },
    { cwd: f.cwd, signal: new AbortController().signal },
  );
  const desktop = await probeMcpServer(f.config, { cwd: f.cwd });
  expect(hub.status).toBe("ok");
  expect(desktop.status).toBe("ok");
  expect(hub.toolCount).toBe(desktop.toolCount);
  expect(hub.tools?.[0]?.allowed).toBe(false);
  expect(desktop.tools).toEqual(hub.tools?.map(({ name, description }) => ({ name, description })));
  expect(JSON.stringify([hub, desktop])).not.toContain("fixture-secret");
  expect(JSON.stringify([hub, desktop])).not.toContain("argument-secret");
  const child = JSON.parse(readFileSync(f.marker, "utf8"));
  expect(child.cwd).toBe(realpathSync(f.cwd));
  await until(() => !alive(child.pid));
});
test.each([
  ["pages", "ok"],
  ["repeat", "invalid_protocol"],
  ["frame", "response_too_large"],
  ["total", "response_too_large"],
] as const)("bounds pagination and responses (%s)", async (mode, expected) => {
  const f = fixture(mode);
  const result = await probeMcp(f.config, { cwd: f.cwd, timeoutMs: 3000 });
  if (expected === "ok") {
    expect(result).toMatchObject({ status: "ok", toolCount: 8, truncated: true });
  } else {
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe(expected);
  }
  const child = JSON.parse(readFileSync(f.marker, "utf8"));
  await until(() => !alive(child.pid));
});
test("timeouts reclaim a process group, including a descendant ignoring SIGTERM", async () => {
  const f = fixture(process.platform === "win32" ? "hang" : "descendants");
  const result = await probeMcp(f.config, { cwd: f.cwd, timeoutMs: 500 });
  expect(result.error?.code).toBe("timeout");
  const child = JSON.parse(readFileSync(f.marker, "utf8"));
  await until(() => !alive(child.pid) && (!child.childPid || !alive(child.childPid)));
});
test("caller cancellation closes the active child; an already revoked request never spawns", async () => {
  const f = fixture("hang");
  const controller = new AbortController();
  const pending = probeMcp(f.config, { cwd: f.cwd, signal: controller.signal, timeoutMs: 3000 });
  await until(() => existsSync(f.marker));
  controller.abort();
  expect((await pending).status).toBe("cancelled");
  const child = JSON.parse(readFileSync(f.marker, "utf8"));
  await until(() => !alive(child.pid));
  rmSync(f.marker);
  expect((await probeMcp(f.config, { cwd: f.cwd, signal: controller.signal })).status).toBe(
    "cancelled",
  );
  expect(existsSync(f.marker)).toBe(false);
});
test("Desktop cache is scoped to workspace/config and never accepts a missing workspace", async () => {
  const f = fixture();
  expect((await probeMcpServer(f.config, { cwd: f.cwd })).status).toBe("ok");
  rmSync(f.marker);
  expect((await probeMcpServer(f.config, { cwd: f.cwd })).status).toBe("ok");
  expect(existsSync(f.marker)).toBe(false);
  const other = join(f.dir, "other");
  mkdirSync(other);
  expect((await probeMcpServer(f.config, { cwd: other })).status).toBe("ok");
  expect(JSON.parse(readFileSync(f.marker, "utf8")).cwd).toBe(realpathSync(other));
  rmSync(f.marker);
  expect(
    (await probeMcpServer({ ...f.config, env: { TOKEN: "changed" } }, { cwd: other })).status,
  ).toBe("ok");
  expect(existsSync(f.marker)).toBe(true);
  expect((await probeMcpServer(f.config)).status).toBe("error");
});

test("in-process servers preserve the unsupported classification without opening a sibling", async () => {
  const f = fixture();
  const result = await probeMcp({ name: "builtin", transport: "inprocess" }, { cwd: f.cwd });
  expect(result.error?.code).toBe("unsupported_transport");
  expect(existsSync(f.marker)).toBe(false);
});
