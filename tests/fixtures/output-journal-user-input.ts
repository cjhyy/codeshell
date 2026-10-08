import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../packages/core/src/engine/engine.js";
import { LLMClientBase } from "../../packages/core/src/llm/client-base.js";
import { registerProvider } from "../../packages/core/src/llm/client-factory.js";
import type { CreateMessageOptions } from "../../packages/core/src/llm/types.js";
import type { InputAttachmentMeta, StreamEvent } from "../../packages/core/src/types.js";

class InputDisplayClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions) {
    for (let index = 0; index < 12; index++) options.onChunk?.({ type: "text", text: "reply " });
    return {
      text: "reply ".repeat(12),
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}
registerProvider("output-user-display-fixture", InputDisplayClient);

/** Actual Engine/attachment policy; callers use their existing recovery adapter. */
export async function outputUserInputFixture(
  mode: "normal" | "attachment-only" | "injected" | "agent",
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-output-input-")));
  const sessionRoot = join(root, "sessions"),
    sessionId = "saved";
  const staged = join(root, ".code-shell", "attachments", sessionId);
  mkdirSync(staged, { recursive: true });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6ioAAAAASUVORK5CYII=",
    "base64",
  );
  const attachments: InputAttachmentMeta[] = [
    { name: "notes.txt", kind: "file", mime: "text/plain", bytes: Buffer.from("fixture notes") },
    { name: "pixel.png", kind: "image", mime: "image/png", bytes: png },
  ].map(({ name, kind, mime, bytes }, index) => {
    const path = `.code-shell/attachments/${sessionId}/${name}`,
      absPath = join(staged, name);
    writeFileSync(absPath, bytes);
    return {
      id: `attachment-${index}`,
      sessionId,
      kind: kind as "image" | "file",
      origin: "picker",
      path,
      absPath,
      mime,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      originalName: name,
      createdAt: 1,
    };
  });
  const engine = new Engine({
    cwd: root,
    sessionStorageDir: sessionRoot,
    settingsScope: "isolated",
    headless: true,
    maxTurns: 2,
    enabledBuiltinTools: [],
    llm: {
      provider: "output-user-display-fixture",
      providerKind: "openai",
      model: "gpt-4o",
      apiKey: "synthetic",
    } as never,
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
  await engine.ready();
  engine.getModelPool().register({
    key: "fixture",
    provider: "output-user-display-fixture",
    providerKind: "openai",
    model: "gpt-4o",
    apiKey: "synthetic",
  });
  engine.switchModel("fixture", { persist: false });
  if (engine.getConfig().llm.providerKind !== "openai")
    throw new Error("Fixture lost vision provider kind");
  const events: StreamEvent[] = [];
  const hidden = mode === "agent" || mode === "injected";
  const prompt = hidden
    ? "<system-reminder>PRIVATE_MACHINE_INPUT</system-reminder>"
    : mode === "normal"
      ? "Inspect these attachments"
      : "";
  try {
    const result = await engine.run(prompt, {
      sessionId,
      behaviorMode: "fixture",
      clientMessageId: "fixture-input",
      ...(!hidden ? { attachments, ...(prompt ? { displayText: prompt } : {}) } : {}),
      ...(mode === "injected" ? { injected: true } : {}),
      ...(mode === "agent" ? { agentDirection: { envelopeIds: [], correlationIds: [] } } : {}),
      onStream: (event) => {
        events.push(event);
      },
    });
    if (result.reason !== "completed")
      throw new Error(`Fixture run failed: ${result.reason}: ${result.text}`);
    const transcript = readFileSync(join(sessionRoot, sessionId, "transcript.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const journal = readFileSync(join(sessionRoot, sessionId, "output-journal.jsonl"), "utf8");
    if (
      !hidden &&
      !transcript.some(
        (event) =>
          Array.isArray(event.data?.content) &&
          event.data.content.some((block: { type: string }) => block.type === "image"),
      )
    )
      throw new Error("Fixture did not send a real image block through Engine");
    if (journal.includes(png.toString("base64"))) throw new Error("Journal duplicated image bytes");
    if (journal.includes("PRIVATE_MACHINE_INPUT")) throw new Error("Journal exposed hidden input");
    return {
      root,
      sessionRoot,
      sessionId,
      events,
      transcript,
      attachments,
      prompt,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  } finally {
    await engine.dispose();
  }
}
