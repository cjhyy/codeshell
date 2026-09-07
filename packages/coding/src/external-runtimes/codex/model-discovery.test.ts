import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCodexModels } from "./model-discovery.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeServer(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-model-discovery-"));
  dirs.push(dir);
  const file = join(dir, "server.mjs");
  const requestsFile = join(dir, "requests.jsonl");
  const closedFile = join(dir, "closed");
  const environmentFile = join(dir, "environment.json");
  writeFileSync(
    file,
    `import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
writeFileSync(${JSON.stringify(environmentFile)}, JSON.stringify({
  cwd: process.cwd(), sentinel: process.env.DISCOVERY_TEST_SENTINEL,
  noProxy: process.env.NO_PROXY, lowerNoProxy: process.env.no_proxy,
}));
const input = createInterface({ input: process.stdin });
input.on("close", () => {
  writeFileSync(${JSON.stringify(closedFile)}, "closed");
  process.exit(0);
});
input.on("line", (line) => {
  const m = JSON.parse(line);
  appendFileSync(${JSON.stringify(requestsFile)}, line + "\\n");
  ${script}
});
`,
  );
  return {
    options: { command: process.execPath, args: [file], cwd: dir },
    closed: () => existsSync(closedFile),
    requests: () =>
      readFileSync(requestsFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    environment: () => JSON.parse(readFileSync(environmentFile, "utf8")),
  };
}

function respondWith(result: unknown) {
  return fakeServer(`
    if (m.method === "initialize") send({ id: m.id, result: {} });
    if (m.method === "model/list") send({ id: m.id, result: ${JSON.stringify(result)} });
  `);
}

describe("discoverCodexModels", () => {
  test("handshakes, follows pagination, filters hidden models and deduplicates in server order", async () => {
    const first = { model: "gpt-6-astra", displayName: "GPT-6-Astra", isDefault: true };
    const second = { model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", isDefault: false };
    const server = fakeServer(`
      if (m.method === "initialize") send({ id: m.id, result: {} });
      if (m.method === "model/list") send({ id: m.id, result: m.params.cursor
        ? { data: [${JSON.stringify(first)}, ${JSON.stringify(second)}], nextCursor: null }
        : { data: [${JSON.stringify(first)}, {
          model: "hidden-model", displayName: "Hidden", isDefault: false, hidden: true,
        }], nextCursor: "page-2" }
      });
    `);

    expect(await discoverCodexModels(server.options)).toEqual([first, second]);
    const requests = server.requests();
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "model/list",
      "model/list",
    ]);
    expect(requests[2].params).toEqual({ includeHidden: false, limit: 100 });
    expect(requests[3].params).toEqual({ includeHidden: false, limit: 100, cursor: "page-2" });
    expect(server.closed()).toBe(true);
  });

  test("preserves the requested cwd and environment while adding loopback proxy bypass", async () => {
    const server = respondWith({ data: [], nextCursor: null });
    await discoverCodexModels({
      ...server.options,
      env: { DISCOVERY_TEST_SENTINEL: "preserved", no_proxy: "example.test" },
    });
    expect(server.environment()).toEqual({
      cwd: realpathSync(server.options.cwd),
      sentinel: "preserved",
      noProxy: "example.test,127.0.0.1,localhost,::1",
    });
  });

  test("returns a valid empty catalog without substituting a fallback", async () => {
    const server = respondWith({ data: [], nextCursor: null });
    expect(await discoverCodexModels(server.options)).toEqual([]);
    expect(server.closed()).toBe(true);
  });

  test.each([
    null,
    { models: [] },
    { data: {} },
    { data: [null] },
    { data: [{ model: 123, displayName: "Model" }] },
    { data: [{ model: "  ", displayName: "Model" }] },
    { data: [{ model: "gpt-test", displayName: " " }] },
    { data: [{ model: "gpt-test", displayName: "Model", isDefault: "true" }] },
    { data: [], nextCursor: 42 },
  ])("rejects malformed model data and closes the server: %j", async (result) => {
    const server = respondWith(result);
    await expect(discoverCodexModels(server.options)).rejects.toThrow(/Invalid Codex model\/list/);
    expect(server.closed()).toBe(true);
  });

  test("closes the server after a model/list error", async () => {
    const server = fakeServer(`
      if (m.method === "initialize") send({ id: m.id, result: {} });
      if (m.method === "model/list") send({ id: m.id, error: { code: -32601, message: "unsupported" } });
    `);
    await expect(discoverCodexModels(server.options)).rejects.toThrow(/unsupported/);
    expect(server.closed()).toBe(true);
  });

  test("rejects repeated pagination cursors and closes the server", async () => {
    const server = respondWith({ data: [], nextCursor: "same-page" });
    await expect(discoverCodexModels(server.options)).rejects.toThrow(/pagination cursor/);
    expect(server.requests().filter((request) => request.method === "model/list")).toHaveLength(2);
    expect(server.closed()).toBe(true);
  });

  test("bounds pagination even when every cursor is different", async () => {
    const server = fakeServer(`
      if (m.method === "initialize") send({ id: m.id, result: {} });
      if (m.method === "model/list") send({
        id: m.id, result: { data: [], nextCursor: String(Number(m.params.cursor ?? 0) + 1) },
      });
    `);
    await expect(discoverCodexModels(server.options)).rejects.toThrow(/pagination limit/);
    expect(server.requests().filter((request) => request.method === "model/list")).toHaveLength(
      100,
    );
    expect(server.closed()).toBe(true);
  });

  test("uses one deadline across initialization and listing, then closes the server", async () => {
    const server = fakeServer(`
      if (m.method === "initialize") setTimeout(() => send({ id: m.id, result: {} }), 120);
      if (m.method === "model/list") setTimeout(() => send({
        id: m.id, result: { data: [], nextCursor: null },
      }), 300);
    `);
    await expect(discoverCodexModels({ ...server.options, timeoutMs: 400 })).rejects.toThrow(
      /within|timed out/,
    );
    expect(server.requests().some((request) => request.method === "model/list")).toBe(true);
    expect(server.closed()).toBe(true);
  });

  test("times out initialization without sending model/list and closes the server", async () => {
    const server = fakeServer("");
    await expect(discoverCodexModels({ ...server.options, timeoutMs: 200 })).rejects.toThrow(
      /within|timed out/,
    );
    expect(server.requests().map((request) => request.method)).toEqual(["initialize"]);
    expect(server.closed()).toBe(true);
  });

  test("rejects promptly when the Codex executable does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-missing-codex-"));
    dirs.push(dir);
    await expect(
      discoverCodexModels({ command: join(dir, "missing-codex"), timeoutMs: 200 }),
    ).rejects.toThrow(/failed to start/);
  });

  test("timeout cleanup kills a server that ignores EOF and SIGTERM before rejecting", async () => {
    const server = fakeServer(`
      if (m.method === "initialize") {
        writeFileSync("pid", String(process.pid));
        input.removeAllListeners("close");
        input.on("close", () => writeFileSync("closed", "closed"));
        process.on("SIGTERM", () => writeFileSync("sigterm", "ignored"));
        setInterval(() => {}, 1_000);
      }
    `);
    await expect(discoverCodexModels({ ...server.options, timeoutMs: 200 })).rejects.toThrow(
      /within|timed out/,
    );
    expect(server.closed()).toBe(true);
    expect(existsSync(join(server.options.cwd, "sigterm"))).toBe(true);
    const pid = Number(readFileSync(join(server.options.cwd, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH|No such process/);
  });
});
