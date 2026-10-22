/**
 * An external runtime's model is chosen and called by the runtime, so the
 * session has no CodeShell `llmConfig` to infer image support from. Every
 * vision-gated tool (browser_observe image/vision) therefore failed closed and
 * never captured pixels for Codex / Claude Code. The host now declares the
 * capability, and only the host can.
 */
import { describe, expect, test } from "bun:test";
import { createSessionToolHost, type CreateSessionToolHostOptions } from "./session-tool-host.js";
import { ToolRegistry } from "./registry.js";
import { toolContextSupportsVision } from "./model-vision.js";

const PIXELS = "QUJD";

function host(overrides: Partial<CreateSessionToolHostOptions>, screenshots: string[]) {
  const cwd = process.cwd();
  return createSessionToolHost({
    businessSessionId: "sess-vision",
    cwd,
    registry: new ToolRegistry({ builtinTools: ["browser_observe"] }),
    permissionMode: "default",
    presetRules: [{ tool: "browser_observe", decision: "allow" }],
    projectTrusted: false,
    settingsScope: "isolated",
    planMode: false,
    exposure: { mode: "allowlist", toolNames: new Set(["browser_observe"]) },
    visibility: { cwd, hasGoal: false, host: "desktop", isSubAgent: false },
    ...overrides,
    contextOverrides: {
      browser: {
        screenshot: async () => {
          screenshots.push("shot");
          return { ok: true, base64: PIXELS, mediaType: "image/png" };
        },
      } as never,
      ...overrides.contextOverrides,
    },
  });
}

async function observe(h: ReturnType<typeof host>) {
  try {
    return await h.execute({ id: "v1", name: "browser_observe", input: { mode: "vision" } });
  } finally {
    await h.dispose();
  }
}

describe("SessionToolHost vision declaration", () => {
  test("a host that declares vision gets the screenshot as an image block", async () => {
    const shots: string[] = [];
    const result = await observe(host({ modelSupportsVision: true }, shots));
    expect(shots).toEqual(["shot"]);
    expect(result.contentBlocks).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: PIXELS } },
    ]);
  });

  test("without a declaration it fails closed, as before", async () => {
    const shots: string[] = [];
    const result = await observe(host({}, shots));
    expect(shots).toEqual([]);
    expect(result.contentBlocks).toBeUndefined();
  });

  test("contextOverrides cannot declare vision on the host's behalf", async () => {
    const shots: string[] = [];
    const result = await observe(
      host({ contextOverrides: { modelSupportsVision: true } as never }, shots),
    );
    expect(shots).toEqual([]);
    expect(result.contentBlocks).toBeUndefined();
  });
});

describe("toolContextSupportsVision", () => {
  const visionModel = {
    provider: "anthropic",
    providerKind: "anthropic",
    model: "claude-sonnet-4-6",
  } as never;

  test("falls back to the selected connection's capability", () => {
    expect(toolContextSupportsVision({ llmConfig: visionModel })).toBe(true);
    expect(toolContextSupportsVision({})).toBe(false);
    expect(toolContextSupportsVision(undefined)).toBe(false);
  });

  test("a host declaration is authoritative in both directions", () => {
    expect(toolContextSupportsVision({ modelSupportsVision: true })).toBe(true);
    expect(toolContextSupportsVision({ llmConfig: visionModel, modelSupportsVision: false })).toBe(
      false,
    );
  });
});
