import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "./engine.js";
import { initialToolsFixtureModule } from "./initial-tools-preset.fixture.js";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { LLMResponse } from "../types.js";

test("actual Engine appends completion provenance to external_file_changes without loss", async () => {
  const root = mkdtempSync(join(tmpdir(), "engine-file-provenance-"));
  let called = false;
  class FixtureClient extends LLMClientBase {
    protected initClient(): void {}
    async createMessage(): Promise<LLMResponse> {
      const call = !called;
      called = true;
      return {
        text: call ? "" : "done",
        toolCalls: call ? [{ id: "capture", toolName: "CaptureExternalFiles", args: {} }] : [],
        stopReason: call ? "tool_use" : "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    }
  }
  registerProvider("external-file-provenance-fixture", FixtureClient);
  const record = {
    jobId: "external",
    description: "fixture",
    cli: "codex" as const,
    cwd: root,
    status: "completed" as const,
    changedFiles: ["gone.ts"],
    provenance: {
      schemaVersion: 1 as const,
      cli: "codex" as const,
      observedAt: 123,
      capture: "completion" as const,
      files: [
        { path: "gone.ts", absolutePath: join(root, "gone.ts"), presence: "missing" as const },
      ],
    },
  };
  const engine = new Engine({
    llm: {
      provider: "external-file-provenance-fixture",
      model: "fixture",
      apiKey: "synthetic",
    } as never,
    modules: [initialToolsFixtureModule(["CaptureExternalFiles"])],
    cwd: root,
    sessionStorageDir: join(root, "sessions"),
    settingsScope: "isolated",
    headless: true,
    permissionMode: "bypassPermissions",
    maxTurns: 4,
    enabledBuiltinTools: [],
    behaviorProfiles: [
      {
        id: "fixture",
        disableSessionTitle: true,
        disableHooks: true,
        disableInstructions: true,
        disableMemoryContext: true,
        disableCapabilityContext: true,
        disableSourcesContext: true,
        disableMcp: true,
      },
    ],
  });
  engine.getHookRegistry().clear();
  engine.registerCustomTool(
    {
      name: "CaptureExternalFiles",
      description: "Captures completion metadata",
      inputSchema: { type: "object", properties: {} },
      source: "builtin",
      permissionDefault: "allow",
    },
    (_args, ctx) => {
      ctx?.recordExternalFileChanges?.(record);
      return { id: "capture", toolName: "CaptureExternalFiles", result: "observed" };
    },
  );
  try {
    const result = await engine.run("capture fixture", {
      sessionId: "provenance-fixture",
      behaviorMode: "fixture",
    });
    expect(result.reason).toBe("completed");
    const events = readFileSync(join(root, "sessions/provenance-fixture/transcript.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.find((event) => event.type === "external_file_changes")?.data).toEqual(record);
  } finally {
    await engine.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
