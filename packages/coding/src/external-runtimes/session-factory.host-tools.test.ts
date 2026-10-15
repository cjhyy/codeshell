import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "@cjhyy/code-shell-core";
import { startExternalRuntimeSession, type ExternalRuntimeSession } from "./session-factory.js";

let directory: string | undefined;
let session: ExternalRuntimeSession | undefined;
afterEach(async () => {
  await session?.close();
  session = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

test("a Codex app-server discovers and calls Link and source tools over its configured MCP bridge", async () => {
  directory = mkdtempSync(join(tmpdir(), "codeshell-codex-host-tool-parity-"));
  const responseFile = join(directory, "responses.json");
  const program = join(directory, "codex-fixture.mjs");
  writeFileSync(
    program,
    `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: "parity-thread" } } });
  if (message.method !== "turn/start") return;
  send({ id: message.id, result: { turn: { id: "parity-turn" } } });
  void (async () => {
    const config = name => {
      const flag = process.argv.find(value => value.startsWith(name + "="));
      return JSON.parse(flag.slice(flag.indexOf("=") + 1));
    };
    const url = new URL(config("mcp_servers.codeshell_tools.url"));
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/mcp") throw new Error("Unexpected test MCP origin");
    const token = process.env[config("mcp_servers.codeshell_tools.bearer_token_env_var")];
    const requests = [
      { method: "tools/list", params: {} },
      { method: "tools/call", params: { name: "LinkAction", arguments: {} } },
      { method: "tools/call", params: { name: "ListSources", arguments: {} } },
      { method: "tools/call", params: { name: "ToolSearch", arguments: { query: "LinkAction" } } },
      { method: "tools/call", params: { name: "Agent", arguments: {} } },
    ];
    const responses = [];
    for (const [index, request] of requests.entries()) {
      const response = await fetch(url, { method: "POST", headers: {
        authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json"
      }, body: JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...request }) });
      responses.push(await response.json());
    }
    writeFileSync(${JSON.stringify(responseFile)}, JSON.stringify(responses));
    send({ method: "turn/completed", params: { threadId: "parity-thread", turn: { id: "parity-turn", status: "completed" } } });
  })().catch(error => send({ method: "turn/completed", params: { threadId: "parity-thread", turn: { id: "parity-turn", status: "failed", error: { message: error.message } } } }));
});
`,
  );
  session = await startExternalRuntimeSession({
    kind: "codex",
    cwd: directory,
    businessSessionId: "parity-session",
    registry: new ToolRegistry({
      builtinTools: ["LinkAction", "ToolSearch", "ListSources", "ReadSource", "Agent"],
    }),
    permissionMode: "default",
    settingsScope: "full",
    presetRules: ["LinkAction", "ToolSearch", "ListSources"].map((tool) => ({
      tool,
      decision: "allow",
    })),
    projectTrusted: false,
    planMode: false,
    visibility: { cwd: directory, hasGoal: false, host: "desktop", isSubAgent: false },
    codexClient: { command: process.execPath, args: [program] },
  });
  const turn = await session.send({
    text: "Inspect the host's connected services and source tools.",
  });
  await turn.done;
  const responses = JSON.parse(readFileSync(responseFile, "utf8"));
  expect(responses[0].result.tools.map((tool: { name: string }) => tool.name)).toEqual(
    expect.arrayContaining(["LinkAction", "ToolSearch", "ListSources", "ReadSource"]),
  );
  expect(responses[0].result.tools.some((tool: { name: string }) => tool.name === "Agent")).toBe(
    false,
  );
  expect(responses[1].result.isError).toBeFalsy();
  expect(JSON.parse(responses[1].result.content[0].text).kind).toBe("providers");
  expect(responses[2].result.isError).toBeFalsy();
  expect(responses[3].result.content[0].text).toContain("LinkAction");
  expect(responses[4].result.isError).toBe(true);
  expect(responses[4].result.content[0].text).toContain("not exposed");
});
