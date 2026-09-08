import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelAgentTaskHost, type PanelAgentTaskScope } from "./agent-task-host.js";
import type { PanelAgentTaskView } from "./agent-task-service.js";

test("native Node Core task executes a real Write only after host approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-core-task-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const proof = join(workspace, "task-proof.txt");
  const requests: any[] = [];
  const approvals: any[] = [];
  const modelErrors: unknown[] = [];
  const model = createServer((req, res) => {
    void (async () => {
      expect(req.url).toBe("/v1/chat/completions");
      expect(req.headers.authorization).toBe("Bearer isolated-panel-fixture");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (delta: unknown, finish_reason: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: "panel-fixture", object: "chat.completion.chunk", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      if (!body.tools?.length) {
        // Core may summarize completed tool activity with a separate text-only request.
        frame({ role: "assistant", content: "Wrote the proof file" });
        frame({}, "stop");
      } else if (!body.messages.some((message: any) => message.role === "tool")) {
        frame({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "write-proof",
              type: "function",
              function: {
                name: "Write",
                arguments: JSON.stringify({
                  file_path: proof,
                  content: "written by independent panel Core task\n",
                }),
              },
            },
          ],
        });
        frame({}, "tool_calls");
      } else {
        frame({ role: "assistant", content: "The panel task wrote its file." });
        frame({}, "stop");
      }
      res.end("data: [DONE]\n\n");
    })().catch((error) => {
      modelErrors.push(error);
      res.destroy();
    });
  });
  const host = createPanelAgentTaskHost({
    execPath: "node",
    workerEntryPath: createRequire(import.meta.url).resolve(
      "@cjhyy/code-shell-core/bin/agent-server-stdio",
    ),
    buildEnv: () => ({
      PATH: process.env.PATH,
      HOME: home,
      CODE_SHELL_HOME: join(home, ".code-shell"),
      CODE_SHELL_DATA_ROOT: join(root, "data"),
      CODE_SHELL_CREDENTIAL_ACCESS: "local",
      CODE_SHELL_CAPABILITY_MODULES: `${import.meta.resolve("@cjhyy/code-shell-capability-coding")}#createCodingModule`,
    }),
    models: () => ({
      defaultModel: "panel-fixture",
      models: [
        {
          id: "panel-fixture",
          providerId: "openai",
          provider: "OpenAI",
          model: "gpt-4o-mini",
          label: "Fixture",
        },
      ],
    }),
  });
  const scope: PanelAgentTaskScope = {
    instanceId: "native-instance",
    ownerId: "native-owner",
    appId: "sample",
    appTitle: "Sample",
    projectPath: workspace,
    cwd: workspace,
    permissions: ["agent.task"],
    availableSkills: [],
    isAuthorized: async () => true,
    emit: (event, payload) => {
      if (event === "agent.task.approvalRequested") approvals.push(payload);
    },
  };
  try {
    await mkdir(join(workspace, ".code-shell"), { recursive: true });
    await mkdir(home, { recursive: true });
    model.listen(0, "127.0.0.1");
    await once(model, "listening");
    const port = (model.address() as { port: number }).port;
    await writeFile(
      join(workspace, ".code-shell/settings.local.json"),
      JSON.stringify({
        credentials: [
          {
            id: "fixture-key",
            catalogId: "openai",
            apiKey: "isolated-panel-fixture",
            baseUrl: `http://127.0.0.1:${port}/v1`,
          },
        ],
        modelConnections: [
          {
            id: "panel-fixture",
            catalogId: "openai",
            tag: "text",
            model: "gpt-4o-mini",
            credentialId: "fixture-key",
          },
        ],
        defaults: { text: "panel-fixture" },
        permissions: { defaultMode: "default", rules: [{ tool: "Write", decision: "ask" }] },
        autoUpdates: false,
      }),
    );
    const started = (await host.call(scope, "agent.task.start", {
      prompt: "Write the task proof file now.",
      label: "Task proof",
      toolNames: ["Write"],
      maxTurns: 3,
    })) as PanelAgentTaskView;
    const deadline = Date.now() + 20_000;
    const waitFor = async (predicate: () => Promise<boolean> | boolean) => {
      while (!(await predicate())) {
        if (Date.now() > deadline)
          throw new Error(
            `Native task timed out: ${JSON.stringify(await host.call(scope, "agent.task.get", { id: started.id }))}`,
          );
        await new Promise((done) => setTimeout(done, 20));
      }
    };
    await waitFor(() => approvals.length > 0);
    expect(await readFile(proof, "utf8").catch(() => null)).toBeNull();
    expect(approvals[0]).toMatchObject({ taskId: started.id, toolName: "Write" });
    await host.call(scope, "agent.task.approvalRespond", {
      taskId: started.id,
      requestId: approvals[0].requestId,
      approved: true,
    });
    await waitFor(
      async () =>
        ((await host.call(scope, "agent.task.get", { id: started.id })) as PanelAgentTaskView)
          .status === "completed",
    );
    expect(await readFile(proof, "utf8")).toBe("written by independent panel Core task\n");
    expect(
      ((await host.call(scope, "agent.task.get", { id: started.id })) as PanelAgentTaskView).result
        ?.text,
    ).toContain("wrote its file");
    const toolRequests = requests.filter((body) => body.tools?.length);
    expect(toolRequests.length).toBe(2);
    for (const body of toolRequests)
      expect(body.tools.map((item: any) => item.function.name)).toEqual(["Write"]);
    const persisted = await readdir(join(root, "data/sessions"), { recursive: true }).catch(
      () => [],
    );
    expect(persisted.some((file) => file.endsWith("state.json"))).toBe(false);
    expect(modelErrors).toEqual([]);
  } finally {
    host.close();
    model.closeAllConnections();
    await new Promise<void>((done) => model.close(() => done()));
    await new Promise((done) => setTimeout(done, 100));
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
