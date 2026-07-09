import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMClientBase } from "../llm/client-base.js";
import { registerProvider } from "../llm/client-factory.js";
import type { CreateMessageOptions } from "../llm/types.js";
import type { ContentBlock, LLMResponse, Message } from "../types.js";
import type { InputAttachmentMeta } from "../protocol/types.js";
import { Engine } from "./engine.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const fakeProvider = "fake-structured-image-gate";
const scenarios = new Map<string, { calls: Message[][] }>();

class StructuredImageGateClient extends LLMClientBase {
  protected initClient(): void {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const scenario = scenarios.get(this.model);
    if (!scenario) throw new Error(`missing fake scenario: ${this.model}`);
    scenario.calls.push(structuredClone(options.messages));
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    this.recordUsage(usage, options);
    return { text: "ok", toolCalls: [], stopReason: "stop", usage };
  }
}

registerProvider(fakeProvider, StructuredImageGateClient);

function makeAttachment(cwd: string, sessionId = "sid"): InputAttachmentMeta {
  const relPath = `.code-shell/attachments/${sessionId}/shot.png`;
  return {
    id: "att_1",
    sessionId,
    kind: "image",
    origin: "paste",
    path: relPath,
    absPath: join(cwd, relPath),
    relPath,
    mime: "image/png",
    size: 1,
    sha256: "0".repeat(64),
    createdAt: 1,
  };
}

function writeAttachment(cwd: string, sessionId = "sid"): InputAttachmentMeta {
  const attachment = makeAttachment(cwd, sessionId);
  mkdirSync(join(cwd, ".code-shell", "attachments", sessionId), { recursive: true });
  writeFileSync(attachment.absPath!, Buffer.from(PNG_B64, "base64"));
  return attachment;
}

function makeEngine(cwd: string, model: string, providerKind?: "openai"): Engine {
  const engine = new Engine({
    llm: {
      provider: fakeProvider,
      ...(providerKind ? { providerKind } : {}),
      model,
      apiKey: "test",
    } as never,
    cwd,
    sessionStorageDir: join(cwd, "sessions"),
    enabledBuiltinTools: [],
    maxTurns: 1,
    headless: true,
    permissionMode: "bypassPermissions",
  });
  (engine as any).hooks.clear();
  return engine;
}

function imageBlocks(messages: Message[]): ContentBlock[] {
  return messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((block) => block.type === "image") : [],
  );
}

describe("Engine structured image attachment vision gate", () => {
  it("rejects structured image attachments for non-vision models before LLM call", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "engine-structured-image-gate-"));
    const model = `${fakeProvider}-nonvision-${Date.now()}-${Math.random()}`;
    const scenario = { calls: [] as Message[][] };
    scenarios.set(model, scenario);

    try {
      const attachment = writeAttachment(cwd, "sid");
      const engine = makeEngine(cwd, model);
      const result = await engine.run("describe this image", {
        sessionId: "sid",
        cwd,
        attachments: [attachment],
      });

      expect(result.reason).toBe("image_error");
      expect(result.text).toContain("does not accept image input");
      expect(scenario.calls).toHaveLength(0);
    } finally {
      scenarios.delete(model);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("merges legacy and structured image attachments for vision models", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "engine-structured-image-merge-"));
    const model = "gpt-4o";
    const scenario = { calls: [] as Message[][] };
    scenarios.set(model, scenario);

    try {
      const attachment = writeAttachment(cwd, "sid");
      const engine = makeEngine(cwd, model, "openai");
      const task =
        `compare both images\n\n` +
        `<codeshell-image mime="image/png" name="legacy.png">\n` +
        `data:image/png;base64,${PNG_B64}\n` +
        `</codeshell-image>`;
      const result = await engine.run(task, {
        sessionId: "sid",
        cwd,
        attachments: [attachment],
      });

      expect(result.reason).toBe("completed");
      const images = scenario.calls
        .map((call) => imageBlocks(call))
        .find((blocks) => blocks.length);
      expect(images).toHaveLength(2);
      expect(images!.every((block) => block.source?.data === PNG_B64)).toBe(true);
    } finally {
      scenarios.delete(model);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
