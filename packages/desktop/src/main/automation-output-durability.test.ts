import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { guardProjectScopeNetwork } from "../../../server/src/panels/__fixtures__/project-scope-network.js";

guardProjectScopeNetwork(afterAll);
const { Engine, HeadlessApprovalBackend, makeUpdateAutomationMemoryTool } =
  await import("@cjhyy/code-shell-core");
const { SessionOutputPublisher, defaultSandboxConfig, readOutputJournal } =
  await import("@cjhyy/code-shell-core/internal");
const { LLMClientBase } = await import("../../../core/src/llm/client-base.js");
const { registerProvider } = await import("../../../core/src/llm/client-factory.js");

class AutomationOutputClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: any) {
    options.onChunk?.({ type: "text", text: "automation text" });
    return {
      text: "automation text",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}
registerProvider("automation-output-fixture", AutomationOutputClient);

// Execute the actual production runner with its real Engine and persistence,
// without booting Electron or loading operator project/browser configuration.
const source = readFileSync(new URL("./automation-host.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("automation.ts", source, ts.ScriptTarget.Latest, true);
const runner = parsed.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "buildDesktopAutomationRunner",
)!;
const compiled = ts.transpileModule(runner.getText(parsed).replace(/^export /, ""), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

test("actual headless automation runner persists cleanup failures with its captured source and rejects replacement", async () => {
  for (const replace of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), "automation-output-lifetime-"));
    const events: Array<{ id: string; event: any }> = [];
    let sid: string | undefined,
      released = 0;
    class CleanupFaultEngine extends Engine {
      constructor(options: any) {
        super({
          ...options,
          sessionStorageDir: join(directory, "sessions"),
          settingsScope: "isolated",
          enabledBuiltinTools: [],
          maxTurns: 1,
        });
        this.getHookRegistry().clear();
      }
      override async run(task: string, options: any) {
        await super.run(task, { ...options, behaviorMode: "isolatedTask" });
        if (replace) {
          const manager = this.getSessionManager();
          rmSync(join(manager.getStorageDir(), sid!), { recursive: true });
          manager.create(directory, "replacement", "fixture", sid!);
        }
        throw new Error("actual cleanup fault");
      }
    }
    const build = runInNewContext(`${compiled}\nbuildDesktopAutomationRunner`, {
      Error,
      Engine: CleanupFaultEngine,
      SessionOutputPublisher,
      HeadlessApprovalBackend,
      makeUpdateAutomationMemoryTool,
      defaultSandboxConfig,
      resolveDesktopAutomationWorkspace: () => ({ cwd: directory, projectTrusted: false }),
      SettingsManager: class {
        get() {
          return {};
        }
      },
      resolveLLMConfigForTag: () => ({
        provider: "automation-output-fixture",
        model: "fixture",
        apiKey: "synthetic",
      }),
      readAutomationMemory: () => "",
      appendAutomationMemory() {},
      AUTOMATION_PROMPT_NOTE: "fixture",
      AUTOMATION_DISABLED_TOOLS: [],
      stablePromptHash: () => "fixture",
    });
    const runtime = {
      acquire: async () => ({
        bridge: undefined,
        release() {
          released++;
        },
      }),
    };
    try {
      const run = build(
        (id: string, event: unknown) => events.push({ id, event }),
        (meta: { sessionId: string }) => {
          sid = meta.sessionId;
        },
        runtime,
      );
      await expect(
        run({
          job: { id: "job", prompt: "fixture" },
          prompt: "fixture",
          permissionMode: "default",
          sandboxMode: "auto",
          approvalBackend: new HeadlessApprovalBackend("approve-read-only"),
        }),
      ).rejects.toThrow(replace ? "replaced" : "actual cleanup fault");
      expect(sid).toBeDefined();
      const cleanup = events.filter(
        ({ event }) => event.type === "error" && event.error === "actual cleanup fault",
      );
      expect(cleanup).toHaveLength(replace ? 0 : 1);
      if (!replace) {
        const page = readOutputJournal(join(directory, "sessions"), sid!, {
          through: cleanup[0].event.outputCursor,
        });
        expect(page.status).toBe("ok");
        expect(page.complete).toBe(true);
        expect(page.frames.at(-1)?.producer?.kind).toBe("host");
        expect(page.frames.some((frame) => frame.runId)).toBe(true);
        expect(cleanup[0].event.runId).toBeUndefined();
      }
      expect(released).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
