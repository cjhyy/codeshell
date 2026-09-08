import { afterEach, describe, expect, test } from "bun:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@cjhyy/code-shell-core";
import { createHubMcpConfiguration, type HubMcpConfigurationOptions } from "./mcp-configuration.js";

const fixtures: {
  directory: string;
  http: Server;
  api: ReturnType<typeof createHubMcpConfiguration>;
}[] = [];
const extraServers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async ({ directory, http, api }) => {
      await api.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }),
  );
  await Promise.all(
    extraServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function fixture(options: Partial<HubMcpConfigurationOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "hub-mcp-test-"));
  const configDir = join(directory, ".code-shell");
  mkdirSync(configDir);
  const projectFile = join(configDir, "settings.json");
  const localFile = join(configDir, "settings.local.json");
  writeFileSync(
    projectFile,
    JSON.stringify({
      mcpServers: {
        "fixture-inherited": {
          transport: "streamable-http",
          url: "https://example.test/mcp?token=hidden-query",
          headers: { Authorization: "inherited-secret", "X-Keep": "keep-secret" },
          env: { REMOVE_ME: "inherited-env", KEEP_ME: "kept-env" },
          args: ["argument-secret"],
          enabled: false,
        },
      },
    }),
  );
  writeFileSync(
    localFile,
    JSON.stringify({
      mcpServers: {
        "fixture-local": {
          command: "not-an-installed-fixture-command",
          args: ["local-argument-secret"],
          env: { TOKEN: "local-token-secret" },
          enabled: false,
        },
      },
      unrelated: { keep: true },
    }),
  );
  const api = createHubMcpConfiguration({
    cwd: directory,
    isAuthorized: async () => true,
    ownerId: async (req) => String(req.headers["x-test-owner"] ?? "owner"),
    ...options,
  });
  const http = createServer((req, res) => {
    void api.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  fixtures.push({ directory, http, api });
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const request = (path: string, method = "GET", body?: unknown, extra: RequestInit = {}) =>
    fetch(`${url}/api/v1/mcp${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
      ...extra,
    });
  const put = async (name: string, body: unknown) =>
    request(`/servers/${encodeURIComponent(name)}`, "PUT", body);
  const effective = () => new SettingsManager(directory, "full").get().mcpServers;
  return { directory, projectFile, localFile, api, url, request, put, effective };
}

async function eventually(check: () => boolean, milliseconds = 2000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stdioFixture(directory: string, options: { hang?: boolean; descendants?: boolean } = {}) {
  const marker = join(directory, "probe-marker.json");
  const script = join(directory, "mcp-fixture.mjs");
  writeFileSync(
    script,
    `import {writeFileSync} from 'node:fs';import readline from 'node:readline';import {spawn} from 'node:child_process';
${options.descendants ? "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});" : "const child=null;"}
writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,childPid:child?.pid,cwd:process.cwd()}));
${options.hang ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);" : ""}
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);${options.hang ? "return;" : ""}
if(m.method==='initialize')send({id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}});
if(m.method==='tools/list')send({id:m.id,result:{tools:[{name:'fixture_echo',description:'Test '+process.env.TOKEN+' argument-secret',inputSchema:{type:'object',properties:{}}},{name:'restricted_tool',inputSchema:{type:'object',properties:{}}}]}});
});`,
  );
  return { marker, script };
}

describe("Hub MCP configuration", () => {
  test("reads safe actual configuration without returning stored args, headers, env, or URL secrets", async () => {
    const f = await fixture();
    const response = await f.request("");
    const body = await response.json();
    const raw = JSON.stringify(body);
    expect(response.status).toBe(200);
    for (const secret of [
      "hidden-query",
      "inherited-secret",
      "keep-secret",
      "inherited-env",
      "kept-env",
      "argument-secret",
      "local-token-secret",
    ])
      expect(raw.includes(secret)).toBe(false);
    const server = body.servers.find((item: any) => item.name === "fixture-inherited");
    expect(server).toMatchObject({
      source: "settings",
      scope: "project",
      argsCount: 1,
      headerKeys: ["Authorization", "X-Keep"],
      envKeys: ["REMOVE_ME", "KEEP_ME"],
      url: "https://example.test/mcp",
      urlHasHiddenParts: true,
    });
  });

  test("removes inherited secret keys with tombstones, preserves other values and unrelated changes, then restores inheritance", async () => {
    const f = await fixture();
    expect(
      (
        await f.put("fixture-inherited", {
          headers: { Authorization: null, "X-Keep": "" },
          env: { REMOVE_ME: null },
        })
      ).status,
    ).toBe(200);
    expect(f.effective()["fixture-inherited"]!.headers).toEqual({ "X-Keep": "keep-secret" });
    expect(f.effective()["fixture-inherited"]!.env).toEqual({ KEEP_ME: "kept-env" });
    expect((await f.put("fixture-inherited", { disabledTools: ["restricted"] })).status).toBe(200);
    expect(f.effective()["fixture-inherited"]!.headers).toEqual({ "X-Keep": "keep-secret" });
    const raw = JSON.parse(readFileSync(f.localFile, "utf8"));
    expect(raw.mcpServers["fixture-inherited"].headers.Authorization).toBeNull();
    expect(raw.mcpServers["fixture-inherited"].env.REMOVE_ME).toBeNull();
    expect(raw.unrelated).toEqual({ keep: true });
    expect((await f.request("/servers/fixture-inherited/inherit", "POST", {})).status).toBe(200);
    expect(f.effective()["fixture-inherited"]!.headers?.Authorization).toBe("inherited-secret");
    expect(f.effective()["fixture-inherited"]!.env?.REMOVE_ME).toBe("inherited-env");
  });

  test("deletes effective inherited service, reports removal and restores original; deleting local service does not resurrect it", async () => {
    const f = await fixture();
    const removed = await f.request("/servers/fixture-inherited", "DELETE");
    expect(removed.status).toBe(200);
    expect((await removed.json()).removed).toContainEqual({
      name: "fixture-inherited",
      scope: "project",
    });
    expect(f.effective()["fixture-inherited"]).toBeUndefined();
    expect((await f.request("/servers/fixture-inherited/inherit", "POST", {})).status).toBe(200);
    expect(f.effective()["fixture-inherited"]).toBeDefined();
    expect((await f.request("/servers/fixture-local", "DELETE")).status).toBe(200);
    expect(f.effective()["fixture-local"]).toBeUndefined();
  });

  test("keeps stored values when blank and supports explicit header case replacement without duplicates", async () => {
    const f = await fixture();
    expect((await f.put("fixture-inherited", { headers: { Authorization: "" } })).status).toBe(200);
    expect(f.effective()["fixture-inherited"]!.headers?.Authorization).toBe("inherited-secret");
    expect(
      (await f.put("fixture-inherited", { headers: { authorization: "replacement-secret" } }))
        .status,
    ).toBe(200);
    expect(f.effective()["fixture-inherited"]!.headers).toEqual({
      "X-Keep": "keep-secret",
      authorization: "replacement-secret",
    });
    expect((await f.put("fixture-local", { env: { TOKEN: null }, args: [] })).status).toBe(400);
    expect(
      (await f.put("fixture-local", { env: { TOKEN: null }, args: [], reuseStoredSecrets: true }))
        .status,
    ).toBe(200);
    expect(f.effective()["fixture-local"]!.env?.TOKEN).toBeUndefined();
    expect(f.effective()["fixture-local"]!.args).toEqual([]);
  });

  test("does not overwrite a concurrent writer's unrelated nested key", async () => {
    let file = "";
    const f = await fixture({
      withMutation: async (write) => {
        if (file) {
          const current = JSON.parse(readFileSync(file, "utf8"));
          current.mcpServers["fixture-local"].env.EXTRA = "concurrent-secret";
          writeFileSync(file, JSON.stringify(current));
        }
        return write();
      },
    });
    file = f.localFile;
    expect((await f.put("fixture-local", { env: { TOKEN: "replaced-secret" } })).status).toBe(200);
    expect(f.effective()["fixture-local"]!.env).toEqual({
      TOKEN: "replaced-secret",
      EXTRA: "concurrent-secret",
    });
  });

  test("rejects unsafe schema, endpoint credential reuse and duplicate names atomically", async () => {
    const f = await fixture();
    const before = readFileSync(f.localFile, "utf8");
    for (const body of [
      { headers: { Authorization: "bad\nheader" } },
      { url: "https://different.test/mcp" },
      { arbitraryCommand: "no" },
      { env: { "BAD-NAME": "value" } },
    ])
      expect((await f.put("fixture-inherited", body)).status).toBe(400);
    expect(
      (
        await f.request("/servers", "POST", {
          name: "fixture-local",
          transport: "stdio",
          command: "node",
        })
      ).status,
    ).toBe(409);
    expect(readFileSync(f.localFile, "utf8")).toBe(before);
    expect(
      (
        await f.put("fixture-inherited", {
          url: "https://different.test/mcp",
          reuseStoredSecrets: true,
        })
      ).status,
    ).toBe(200);
  });

  test("rechecks authorization after the body and does not mutate on revoked login or host busy", async () => {
    const f = await fixture({ isAuthorized: async () => false });
    const before = readFileSync(f.localFile, "utf8");
    expect((await f.put("fixture-local", { enabled: true })).status).toBe(401);
    expect(readFileSync(f.localFile, "utf8")).toBe(before);
    const busy = await fixture({
      withMutation: async () => {
        throw Object.assign(new Error("请等待任务完成。"), { status: 409 });
      },
    });
    expect((await busy.put("fixture-local", { enabled: true })).status).toBe(409);
    expect(busy.effective()["fixture-local"]!.enabled).toBe(false);
  });

  test("runs stdio only for explicit probe with the server workspace and masked tool descriptions", async () => {
    const f = await fixture();
    const { marker, script } = stdioFixture(f.directory);
    expect(
      (
        await f.request("/servers", "POST", {
          name: "fixture-probe",
          transport: "stdio",
          command: process.execPath,
          args: [script, "argument-secret"],
          env: { TOKEN: "probe-env-secret" },
          disabledTools: ["restricted_tool"],
          enabled: false,
        })
      ).status,
    ).toBe(200);
    expect((await f.request("")).status).toBe(200);
    expect(existsSync(marker)).toBe(false);
    const response = await f.request("/servers/fixture-probe/probe", "POST", {});
    const result = await response.json();
    expect(result.status).toBe("ok");
    expect(result.toolCount).toBe(2);
    expect(result.tools[1]).toMatchObject({ name: "restricted_tool", allowed: false });
    expect(JSON.stringify(result).includes("probe-env-secret")).toBe(false);
    expect(JSON.stringify(result).includes("argument-secret")).toBe(false);
    const processState = JSON.parse(readFileSync(marker, "utf8"));
    expect(processState.cwd).toBe(realpathSync(f.directory));
    await eventually(() => !alive(processState.pid));
    expect(f.effective()["fixture-probe"]!.enabled).toBe(false);
  });

  test("bounds timeout and terminates a stdio process group, including a child that ignores SIGTERM", async () => {
    if (process.platform === "win32") return;
    const f = await fixture({ probeTimeoutMs: 400 });
    const { marker, script } = stdioFixture(f.directory, { hang: true, descendants: true });
    await f.request("/servers", "POST", {
      name: "fixture-hang",
      command: process.execPath,
      args: [script],
      enabled: false,
    });
    const started = Date.now();
    const result = await (await f.request("/servers/fixture-hang/probe", "POST", {})).json();
    expect(result.status).toBe("error");
    expect(result.error.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2500);
    const child = JSON.parse(readFileSync(marker, "utf8"));
    await eventually(() => !alive(child.pid) && !alive(child.childPid));
  });

  test("cancels an explicit browser request or revoked owner and bounds concurrent probes per owner", async () => {
    const f = await fixture({ probeTimeoutMs: 4000 });
    const { marker, script } = stdioFixture(f.directory, { hang: true });
    await f.request("/servers", "POST", {
      name: "fixture-hang",
      command: process.execPath,
      args: [script],
      enabled: false,
    });
    const disconnectedRequest = httpRequest(`${f.url}/api/v1/mcp/servers/fixture-hang/probe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "2" },
    });
    disconnectedRequest.on("error", () => {});
    disconnectedRequest.end("{}");
    await eventually(() => existsSync(marker));
    expect((await f.request("/servers/fixture-hang/probe", "POST", {})).status).toBe(429);
    const child = JSON.parse(readFileSync(marker, "utf8"));
    expect((await f.request("/servers/fixture-hang/cancel-probe", "POST", {})).status).toBe(200);
    disconnectedRequest.destroy();
    await eventually(() => !alive(child.pid));
    rmSync(marker);
    const next = f.request("/servers/fixture-hang/probe", "POST", {});
    await eventually(() => existsSync(marker));
    f.api.cancelOwner("owner");
    expect((await (await next).json()).status).toBe("cancelled");
    const second = JSON.parse(readFileSync(marker, "utf8"));
    await eventually(() => !alive(second.pid));
  });

  test("uses the real HTTP MCP handshake and reports auth errors without reflecting the server response", async () => {
    const mcp = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
      }
      if (req.headers.authorization !== "Bearer http-fixture-secret") {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("reflected-upstream-secret");
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (input.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      const result =
        input.method === "initialize"
          ? {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "http-fixture", version: "1" },
            }
          : {
              tools: [
                {
                  name: "http_echo",
                  description: "http-fixture-secret private-query-token xY",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
    });
    extraServers.push(mcp);
    await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(mcp.address() as { port: number }).port}/mcp`;
    const f = await fixture();
    await f.request("/servers", "POST", {
      name: "fixture-http",
      transport: "streamable-http",
      url: `${url}?access=private-query-token`,
      headers: { Authorization: "Bearer http-fixture-secret", "X-Short-Key": "xY" },
      enabled: false,
    });
    const good = await (await f.request("/servers/fixture-http/probe", "POST", {})).json();
    expect(good.status).toBe("ok");
    expect(good.toolCount).toBe(1);
    expect(JSON.stringify(good).includes("http-fixture-secret")).toBe(false);
    expect(JSON.stringify(good).includes("private-query-token")).toBe(false);
    expect(JSON.stringify(good).includes("xY")).toBe(false);
    await f.put("fixture-http", { headers: { Authorization: null } });
    const bad = await (await f.request("/servers/fixture-http/probe", "POST", {})).json();
    expect(bad.error.code).toBe("unauthorized");
    expect(JSON.stringify(bad).includes("reflected-upstream-secret")).toBe(false);
  });
});

function lifecycleGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("MCP authorization lifecycle", () => {
  test("revocation inside the mutation gate prevents persistence", async () => {
    let authorized = true;
    const f = await fixture({
      isAuthorized: async () => authorized,
      withMutation: async (write) => {
        authorized = false;
        return write();
      },
    });
    const before = readFileSync(f.localFile, "utf8");
    expect(
      (await f.request("/servers/fixture-local/enabled", "PUT", { enabled: true })).status,
    ).toBe(401);
    expect(readFileSync(f.localFile, "utf8")).toBe(before);
  });

  test("close prevents a queued mutation from committing", async () => {
    const ready = lifecycleGate();
    const resume = lifecycleGate();
    const f = await fixture({
      withMutation: async (write) => {
        ready.resolve();
        await resume.promise;
        return write();
      },
    });
    const before = readFileSync(f.localFile, "utf8");
    const pending = f.request("/servers/fixture-local/enabled", "PUT", { enabled: true });
    await ready.promise;
    await f.api.close();
    resume.resolve();
    expect((await pending).status).toBe(503);
    expect(readFileSync(f.localFile, "utf8")).toBe(before);
  });

  test("a revoke during ownership lookup prevents starting the MCP connection", async () => {
    const ready = lifecycleGate();
    const resume = lifecycleGate();
    let authorized = true;
    const f = await fixture({
      isAuthorized: async () => authorized,
      ownerId: async () => {
        ready.resolve();
        await resume.promise;
        return "owner";
      },
    });
    const pending = f.request("/servers/fixture-local/probe", "POST", {});
    await ready.promise;
    authorized = false;
    f.api.cancelOwner("owner");
    resume.resolve();
    expect((await pending).status).toBe(401);
  });

  test("revocation during reload hides an already committed mutation response", async () => {
    const ready = lifecycleGate();
    const resume = lifecycleGate();
    let authorized = true;
    const f = await fixture({
      isAuthorized: async () => authorized,
      withMutation: async (write) => {
        const value = await write();
        ready.resolve();
        await resume.promise;
        return value;
      },
    });
    const pending = f.request("/servers/fixture-local/enabled", "PUT", { enabled: true });
    await ready.promise;
    authorized = false;
    resume.resolve();
    const response = await pending;
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "登录已失效，请重新登录。" });
    expect(f.effective()["fixture-local"]?.enabled).toBe(true);
  });
});
