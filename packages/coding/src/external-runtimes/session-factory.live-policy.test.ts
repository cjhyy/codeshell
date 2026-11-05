import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "@cjhyy/code-shell-core";
import {
  startExternalRuntimeSession,
  type ExternalRuntimeKind,
  type ExternalRuntimeSession,
  type ExternalRuntimeSessionOptions,
} from "./session-factory.js";

const directories: string[] = [];
const sessions: ExternalRuntimeSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** Both fake CLIs use their real factory-supplied MCP configuration and transport. */
function runtimeFixture(kind: ExternalRuntimeKind, directory: string, responseFile: string) {
  const requests = [
    { method: "tools/list", params: {} },
    { method: "tools/call", params: { name: "browser_observe", arguments: { mode: "vision" } } },
    {
      method: "tools/call",
      params: { name: "ToolSearch", arguments: { query: "select:browser_observe,Agent" } },
    },
    { method: "tools/call", params: { name: "Agent", arguments: {} } },
    {
      method: "tools/call",
      params: {
        name: "Panel",
        arguments: {
          action: "invoke",
          panel_id: "panel-app:unreviewed-fixture",
          tool_name: "unreviewed_action",
        },
      },
    },
  ];
  const probe = `
async function probe(urlValue, authorization) {
  const url = new URL(urlValue);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/mcp") {
    throw new Error("Unexpected fixture MCP origin");
  }
  const responses = [];
  for (const [index, request] of ${JSON.stringify(requests)}.entries()) {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...request }),
    });
    responses.push(await response.json());
  }
  writeFileSync(${JSON.stringify(responseFile)}, JSON.stringify(responses));
}
`;
  const program = join(directory, `${kind}-fixture.mjs`);
  if (kind === "codex") {
    writeFileSync(
      program,
      `import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
${probe}
const config = name => {
  const value = process.argv.find(arg => arg.startsWith(name + "="));
  return JSON.parse(value.slice(value.indexOf("=") + 1));
};
let turn = 0;
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return send({ id: request.id, result: {} });
  if (request.method === "thread/start") return send({ id: request.id, result: { thread: { id: "policy-thread" } } });
  if (request.method !== "turn/start") return;
  const id = "policy-turn-" + ++turn;
  send({ id: request.id, result: { turn: { id } } });
  const finish = error => send({ method: "turn/completed", params: {
    threadId: "policy-thread", turn: { id, status: error ? "failed" : "completed",
      ...(error ? { error: { message: String(error) } } : {}) }
  } });
  void probe(config("mcp_servers.codeshell_tools.url"),
    "Bearer " + process.env[config("mcp_servers.codeshell_tools.bearer_token_env_var")])
    .then(() => finish(), finish);
});
`,
    );
    return { codexClient: { command: process.execPath, args: [program] } };
  }
  writeFileSync(
    program,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
${probe}
readFileSync(0, "utf8");
const argv = process.argv.slice(2);
const config = JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8"));
const entry = config.mcpServers.codeshell_tools;
send({ type: "system", subtype: "init", session_id: "policy-session" });
await probe(entry.url, entry.headers.Authorization);
send({ type: "result", subtype: "success", is_error: false });
`,
  );
  chmodSync(program, 0o755);
  return { claudeCommand: program };
}

type ProbeResponse = {
  result: {
    tools?: Array<{ name: string }>;
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
};

test.each(["codex", "claude-code"] as const)(
  "%s observes live Host Profile tool policy through the factory and MCP bridge",
  async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), `codeshell-${kind}-live-policy-`));
    directories.push(directory);
    const responseFile = join(directory, "responses.json");
    let profile: ReturnType<NonNullable<ExternalRuntimeSessionOptions["getProfileOverrides"]>> = {
      builtin: { browser_observe: "on", Agent: "on" },
    };
    let screenshots = 0;
    const session = await startExternalRuntimeSession({
      kind,
      cwd: directory,
      businessSessionId: `live-policy-${kind}`,
      registry: new ToolRegistry({
        builtinTools: ["browser_observe", "ToolSearch", "Agent", "Panel"],
      }),
      permissionMode: "default",
      settingsScope: "full",
      presetRules: ["browser_observe", "ToolSearch", "Agent", "Panel"].map((tool) => ({
        tool,
        decision: "allow",
      })),
      projectTrusted: true,
      planMode: false,
      visibility: { cwd: directory, hasGoal: false, host: "desktop", isSubAgent: false },
      getProfileOverrides: () => profile,
      contextOverrides: {
        browser: {
          screenshot: async () => {
            screenshots++;
            return {
              ok: true,
              base64: Buffer.from("fixture pixels").toString("base64"),
              mediaType: "image/png",
            };
          },
        } as never,
      },
      ...runtimeFixture(kind, directory, responseFile),
    });
    sessions.push(session);

    // Reuse one Host/bridge throughout. A policy captured only during factory
    // startup would leave the disabled phase callable and discoverable.
    for (const enabled of [true, false, true]) {
      profile = { builtin: { browser_observe: enabled ? "on" : "off", Agent: "on" } };
      const before = screenshots;
      expect(session.listTools().some((tool) => tool.name === "browser_observe")).toBe(enabled);
      rmSync(responseFile, { force: true });
      await (
        await session.send({ text: "Probe the current Host policy." })
      ).done;
      const [listed, observed, searched, excluded, forbiddenAction] = JSON.parse(
        readFileSync(responseFile, "utf8"),
      ) as ProbeResponse[];

      expect(listed!.result.tools!.some((tool) => tool.name === "browser_observe")).toBe(enabled);
      expect(observed!.result.isError).toBe(!enabled);
      expect(screenshots - before).toBe(enabled ? 1 : 0);
      expect(searched!.result.isError).toBeFalsy();
      const searchText = searched!.result.content!.map((part) => part.text ?? "").join("\n");
      expect(searchText.includes("schemaRef: select:browser_observe")).toBe(enabled);
      // A Profile cannot widen the reviewed runtime exposure or Panel actions.
      expect(listed!.result.tools!.some((tool) => tool.name === "Agent")).toBe(false);
      expect(searchText).not.toContain("schemaRef: select:Agent");
      expect(excluded!.result.isError).toBe(true);
      expect(excluded!.result.content![0]!.text).toContain("not exposed");
      expect(forbiddenAction!.result.isError).toBe(true);
      expect(forbiddenAction!.result.content![0]!.text).toContain("outside the scope exposed");
    }
  },
);
