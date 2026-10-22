/**
 * End-to-end parity for CodeShell tools called by an external runtime: a fake
 * Codex app-server speaks the real MCP wire protocol to the real loopback bridge,
 * which reaches the real SessionToolHost and ToolExecutor.
 *
 *  - Images: browser_observe(vision) must deliver the screenshot as MCP image
 *    content. It used to fail twice over — the host declared no vision, so the
 *    tool never captured pixels, and the bridge only ever replied with text.
 *  - Hooks: a user's configured pre_tool_use hook must bind these calls as it
 *    binds the Native Engine, and an untrusted project's own hooks must not.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "@cjhyy/code-shell-core";
import { startExternalRuntimeSession, type ExternalRuntimeSession } from "./session-factory.js";

const PIXELS = Buffer.from("fake screenshot bytes").toString("base64");
const originalHome = process.env.HOME;
const dirs: string[] = [];
let session: ExternalRuntimeSession | undefined;
afterEach(async () => {
  await session?.close();
  session = undefined;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A Codex app-server stand-in that issues `requests` over the configured bridge. */
function codexFixture(directory: string, requests: unknown[]) {
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
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: "t" } } });
  if (message.method !== "turn/start") return;
  send({ id: message.id, result: { turn: { id: "u" } } });
  void (async () => {
    const config = name => {
      const flag = process.argv.find(value => value.startsWith(name + "="));
      return JSON.parse(flag.slice(flag.indexOf("=") + 1));
    };
    const url = new URL(config("mcp_servers.codeshell_tools.url"));
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Unexpected origin");
    const token = process.env[config("mcp_servers.codeshell_tools.bearer_token_env_var")];
    const responses = [];
    for (const [index, request] of ${JSON.stringify(requests)}.entries()) {
      const response = await fetch(url, { method: "POST", headers: {
        authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json"
      }, body: JSON.stringify({ jsonrpc: "2.0", id: index + 1, ...request }) });
      responses.push(await response.json());
    }
    writeFileSync(${JSON.stringify(responseFile)}, JSON.stringify(responses));
    send({ method: "turn/completed", params: { threadId: "t", turn: { id: "u", status: "completed" } } });
  })().catch(error => send({ method: "turn/completed", params: { threadId: "t", turn: { id: "u", status: "failed", error: { message: error.message } } } }));
});
`,
  );
  return { program, responseFile };
}

const observeVision = {
  method: "tools/call",
  params: { name: "browser_observe", arguments: { mode: "vision" } },
};

async function runBrowserObserve(options: {
  cwd: string;
  projectTrusted: boolean;
  modelSupportsVision?: boolean;
}): Promise<{ response: any; screenshots: number }> {
  let screenshots = 0;
  const { program, responseFile } = codexFixture(options.cwd, [observeVision]);
  session = await startExternalRuntimeSession({
    kind: "codex",
    cwd: options.cwd,
    businessSessionId: "tool-parity",
    registry: new ToolRegistry({ builtinTools: ["browser_observe"] }),
    permissionMode: "default",
    settingsScope: "full",
    presetRules: [{ tool: "browser_observe", decision: "allow" }],
    projectTrusted: options.projectTrusted,
    planMode: false,
    visibility: { cwd: options.cwd, hasGoal: false, host: "desktop", isSubAgent: false },
    contextOverrides: {
      browser: {
        screenshot: async () => {
          screenshots += 1;
          return { ok: true, base64: PIXELS, mediaType: "image/png" };
        },
      } as never,
    },
    ...(options.modelSupportsVision === undefined
      ? {}
      : { modelSupportsVision: options.modelSupportsVision }),
    codexClient: { command: process.execPath, args: [program] },
  });
  const turn = await session.send({ text: "Look at the page." });
  await turn.done;
  const [response] = JSON.parse(readFileSync(responseFile, "utf8"));
  return { response, screenshots };
}

describe("external runtime tool parity", () => {
  test("browser_observe(vision) reaches the runtime as MCP image content", async () => {
    process.env.HOME = tempDir("cs-parity-home-");
    const cwd = tempDir("cs-parity-vision-");

    const { response, screenshots } = await runBrowserObserve({ cwd, projectTrusted: true });

    expect(screenshots).toBe(1);
    expect(response.result.isError).toBe(false);
    expect(response.result.content).toEqual([
      { type: "text", text: "[screenshot loaded]" },
      { type: "image", data: PIXELS, mimeType: "image/png" },
    ]);
  });

  test("a host that declares a text-only model still skips the pixels", async () => {
    process.env.HOME = tempDir("cs-parity-home-");
    const cwd = tempDir("cs-parity-textonly-");

    const { response, screenshots } = await runBrowserObserve({
      cwd,
      projectTrusted: true,
      modelSupportsVision: false,
    });

    expect(screenshots).toBe(0);
    expect(response.result.content).toHaveLength(1);
    expect(response.result.content[0].type).toBe("text");
  });

  test.each([
    ["a trusted", true],
    ["an untrusted", false],
  ] as const)(
    "%s project's own pre_tool_use hook binds the call only when trusted",
    async (_label, projectTrusted) => {
      process.env.HOME = tempDir("cs-parity-home-");
      const cwd = tempDir("cs-parity-hooks-");
      mkdirSync(join(cwd, ".code-shell"), { recursive: true });
      writeFileSync(
        join(cwd, ".code-shell", "settings.json"),
        JSON.stringify({
          hooks: [
            {
              event: "pre_tool_use",
              matcher: "browser_observe",
              command: "echo 'screenshots are off-limits' >&2; exit 2",
            },
          ],
        }),
      );

      const { response, screenshots } = await runBrowserObserve({ cwd, projectTrusted });

      if (projectTrusted) {
        expect(screenshots).toBe(0);
        expect(response.result.isError).toBe(true);
        expect(response.result.content[0].text).toContain("Blocked by pre_tool_use hook");
        expect(response.result.content[0].text).toContain("screenshots are off-limits");
      } else {
        // hooks is a DANGEROUS_PROJECT_FIELD: an untrusted repo cannot make the
        // host run its commands, so the call proceeds.
        expect(screenshots).toBe(1);
        expect(response.result.isError).toBe(false);
      }
    },
  );

  test("the user's own hook binds the runtime even in an untrusted project", async () => {
    const home = tempDir("cs-parity-home-");
    process.env.HOME = home;
    mkdirSync(join(home, ".code-shell"), { recursive: true });
    writeFileSync(
      join(home, ".code-shell", "settings.json"),
      JSON.stringify({
        hooks: [{ event: "pre_tool_use", command: "echo 'user policy' >&2; exit 2" }],
      }),
    );
    const cwd = tempDir("cs-parity-user-hook-");

    const { response, screenshots } = await runBrowserObserve({ cwd, projectTrusted: false });

    expect(screenshots).toBe(0);
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain("user policy");
  });
});
