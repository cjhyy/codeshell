import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../packages/core/src/engine/engine.js";
import { ChatSession } from "../../packages/core/src/protocol/chat-session.js";
import { LLMClientBase } from "../../packages/core/src/llm/client-base.js";
import { registerProvider } from "../../packages/core/src/llm/client-factory.js";
import type { CreateMessageOptions } from "../../packages/core/src/llm/types.js";
import type { InputAttachmentMeta, StreamEvent } from "../../packages/core/src/types.js";

const modelRequests = new Map<string, string[]>();

class InputDisplayClient extends LLMClientBase {
  protected initClient(): void {}
  async createMessage(options: CreateMessageOptions) {
    modelRequests.get(this.config.apiKey ?? "")?.push(JSON.stringify(options.messages));
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
  mode: "normal" | "attachment-only" | "injected" | "agent" | "steer",
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
  const apiKey = `synthetic-${createHash("sha256").update(root).digest("hex")}`;
  const requests: string[] = [];
  modelRequests.set(apiKey, requests);
  const engine = new Engine({
    cwd: root,
    sessionStorageDir: sessionRoot,
    settingsScope: "isolated",
    headless: true,
    maxTurns: mode === "steer" ? 3 : 2,
    enabledBuiltinTools: [],
    llm: {
      provider: "output-user-display-fixture",
      providerKind: "openai",
      model: "gpt-4o",
      apiKey,
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
    apiKey,
  });
  engine.switchModel("fixture", { persist: false });
  if (engine.getConfig().llm.providerKind !== "openai")
    throw new Error("Fixture lost vision provider kind");
  const events: StreamEvent[] = [];
  let steerAccepted = false;
  const hidden = mode === "agent" || mode === "injected";
  const prompt = hidden
    ? "<system-reminder>PRIVATE_MACHINE_INPUT</system-reminder>"
    : mode === "normal" || mode === "steer"
      ? "Inspect these attachments"
      : "";
  try {
    const options = {
      sessionId,
      behaviorMode: "fixture",
      clientMessageId: "fixture-input",
      ...(!hidden && mode !== "steer"
        ? { attachments, ...(prompt ? { displayText: prompt } : {}) }
        : {}),
      ...(mode === "injected" ? { injected: true } : {}),
      ...(mode === "agent" ? { agentDirection: { envelopeIds: [], correlationIds: [] } } : {}),
      onStream: (event: StreamEvent) => {
        events.push(event);
        if (mode === "steer" && !steerAccepted && event.type === "text_delta") {
          const queued = engine.enqueueSteer(
            sessionId,
            prompt,
            "fixture-steer",
            "fixture-steer-client",
            attachments,
          );
          if (!queued.accepted) throw new Error("Actual Engine rejected active attachment steer");
          steerAccepted = true;
        }
      },
    };
    // Exercise the real Host queue/envelope, not only raw Engine callbacks.
    const result =
      mode === "steer"
        ? await new ChatSession({ id: sessionId, engine }).enqueueTurn(
            "Start before steering",
            options,
          )
        : await engine.run(prompt, options);
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
    if (
      !hidden &&
      !requests.some(
        (request) =>
          request.includes(png.toString("base64")) && request.includes(attachments[0].path),
      )
    )
      throw new Error("The actual model request did not consume the prepared attachments");
    if (mode === "steer" && (!steerAccepted || requests.length < 2))
      throw new Error("Fixture never consumed steer in a subsequent model request");
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
    modelRequests.delete(apiKey);
    await engine.dispose();
  }
}
