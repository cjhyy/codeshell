/**
 * Engine ↔ image-input integration tests.
 *
 * Covers the three states P2-6's design doc enumerates:
 *   1. Vision-on model + image-bearing task   → image block reaches the LLM.
 *   2. Vision-off model + image-bearing task  → engine refuses, LLM never called.
 *   3. Pure-text task                          → unchanged wire format.
 *
 * Strategy: register a fake LLM client via `registerProvider` so we can
 * inspect the exact `messages` payload Engine hands to the model. Avoids
 * touching the network and avoids skipping the real codepath through
 * `createMessage`. Snapshot-style `{ ok: true }` assertions would not
 * verify the actual checklist requirement; we inspect the message tree
 * directly.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Engine } from "../packages/core/src/engine/engine.js";
import {
  registerProvider,
  PROVIDER_REGISTRY,
} from "../packages/core/src/llm/client-factory.js";
import { LLMClientBase } from "../packages/core/src/llm/client-base.js";
import type { LLMResponse, Message } from "../packages/core/src/types.js";
import type { CreateMessageOptions } from "../packages/core/src/llm/types.js";

// 1×1 PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

function imageBlock(): string {
  return (
    `<codeshell-image mime="image/png" name="test.png">\n` +
    `data:image/png;base64,${PNG_BASE64}\n` +
    `</codeshell-image>`
  );
}

class CapturingClient extends LLMClientBase {
  public lastMessages: Message[] | null = null;
  public callCount = 0;

  protected initClient(): void {
    /* nothing to init */
  }

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    this.callCount += 1;
    // Deep copy via structuredClone so test assertions are stable even if
    // Engine mutates the array after handing it off (it shouldn't, but the
    // contract leaves it free to do so).
    this.lastMessages = structuredClone(options.messages);
    return {
      text: "ok",
      toolCalls: [],
      stopReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}

// Pull the singleton from the most recently constructed CapturingClient.
// The factory hands out a fresh instance per Engine, so capture it via a
// holder closure passed into registerProvider's constructor wrapper.
let lastClient: CapturingClient | null = null;
let savedProviders: Array<[string, new (cfg: any) => LLMClientBase]>;

beforeEach(() => {
  // Save then clear the provider registry so we own the "openai" mapping
  // for the duration of each test. Anything previously registered (the
  // real OpenAI client, leftover from another suite) gets restored in
  // afterEach so we don't pollute global state.
  savedProviders = Array.from(PROVIDER_REGISTRY.entries());
  PROVIDER_REGISTRY.clear();
  lastClient = null;

  class HoldingClient extends CapturingClient {
    constructor(cfg: any) {
      super(cfg);
      lastClient = this;
    }
  }
  registerProvider("openai", HoldingClient);
});

afterEach(() => {
  PROVIDER_REGISTRY.clear();
  for (const [k, v] of savedProviders) PROVIDER_REGISTRY.set(k, v);
});

function newEngine(opts: { model: string; cwd: string }): Engine {
  return new Engine({
    llm: {
      provider: "openai",
      providerKind: "openai",
      model: opts.model,
      apiKey: "test",
      enableStreaming: false,
    },
    cwd: opts.cwd,
    sessionStorageDir: join(opts.cwd, ".code-shell", "sessions"),
    // No tools — keep the loop short and avoid any hooks needing settings.
    enabledBuiltinTools: [],
    maxTurns: 1,
    headless: true,
    permissionMode: "bypassPermissions",
  });
}

describe("Engine + image input", () => {
  let cwd: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "engine-vision-"));
    // Isolate from the developer's real `~/.code-shell/settings.json`.
    // Without this, `Engine.populateModelPoolFromSettings` reads the
    // user's `activeKey` and swaps the model out from under the test,
    // which can land on a vision-capable id and silently invert the
    // refusal assertion.
    savedHome = process.env.HOME;
    process.env.HOME = cwd;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("vision-capable model + image task → LLM receives an image content block", async () => {
    // gpt-5 matches the OpenAI rule `^(?:o[1-9]|gpt-[5-9])` which sets
    // supportsVision=true. gpt-4o currently falls through to default in
    // the rules table (vision=false) — use gpt-5 here to exercise the
    // happy path. The capability table covers gpt-4o classification in
    // its own dedicated test.
    const engine = newEngine({ model: "gpt-5", cwd });
    const task = `describe this picture\n\n${imageBlock()}`;

    const result = await engine.run(task);

    // Sanity: LLM was actually called (not the refusal path).
    expect(result.reason).toBe("completed");
    expect(lastClient).not.toBeNull();
    expect(lastClient!.callCount).toBeGreaterThan(0);

    // Find the latest user message handed to the model. The engine inserts
    // a userContext message at index 0, so we look for role=user with an
    // array content (where the image must live).
    const userMsgs = lastClient!.lastMessages!.filter(
      (m) => m.role === "user" && Array.isArray(m.content),
    );
    expect(userMsgs.length).toBeGreaterThan(0);

    const lastUser = userMsgs[userMsgs.length - 1]!;
    const blocks = lastUser.content as Array<Record<string, unknown>>;
    const textBlock = blocks.find((b) => b.type === "text");
    const imgBlock = blocks.find((b) => b.type === "image");
    expect(textBlock).toEqual({ type: "text", text: "describe this picture" });
    expect(imgBlock).toBeDefined();
    expect(imgBlock).toMatchObject({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: PNG_BASE64,
      },
    });
  });

  it("vision-incapable model + image task → engine refuses, LLM never called", async () => {
    // deepseek-chat is not in the capability rules with vision=true and
    // falls through to DEFAULT_CAPABILITY.supportsVision === false.
    const engine = newEngine({ model: "deepseek-chat", cwd });
    const task = `look at this\n\n${imageBlock()}`;

    const result = await engine.run(task);

    expect(result.reason).toBe("image_error");
    expect(result.text).toMatch(/does not accept image input/i);
    // Critical invariant: LLM client must NOT have been invoked. Silent
    // text-only fallback (dropping the image) was the red-line failure
    // mode the design doc calls out.
    expect(lastClient).toBeNull();
  });

  it("pure-text task → unchanged behavior, no array-form content", async () => {
    const engine = newEngine({ model: "deepseek-chat", cwd });
    const task = "what is 2 + 2?";

    const result = await engine.run(task);

    expect(result.reason).toBe("completed");
    expect(lastClient).not.toBeNull();
    // The user-turn message must still be a plain string — image
    // attachments aren't supposed to upgrade the format on text-only
    // turns. The TurnLoop may push a final "last turn" system-reminder
    // user message after ours (when maxTurns is exhausted), so we look
    // for the message whose content is the exact original task.
    const userTask = lastClient!.lastMessages!.find(
      (m) => m.role === "user" && m.content === task,
    );
    expect(userTask).toBeDefined();
    expect(typeof userTask!.content).toBe("string");
    // Crucially: no message in the wire ever contained an array with
    // image blocks for this pure-text turn.
    for (const m of lastClient!.lastMessages!) {
      if (Array.isArray(m.content)) {
        const hasImage = m.content.some((b: any) => b?.type === "image");
        expect(hasImage).toBe(false);
      }
    }
  });
});
