import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ReactNode } from "react";
import type { Instance, RenderOptions } from "../render/root.js";

let capturedRenderOptions: RenderOptions | undefined;

async function renderForTesting(
  _node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Promise<Instance> {
  capturedRenderOptions = options && "write" in options ? undefined : options;
  return {
    rerender: () => {},
    unmount: () => {},
    waitUntilExit: async () => {},
    cleanup: () => {},
  };
}

describe("startInkRepl", () => {
  afterEach(() => {
    capturedRenderOptions = undefined;
    delete process.env.CODESHELL_NO_MODEL_SYNC;
  });

  test("lets App own Ctrl+C instead of the render root exiting immediately", async () => {
    process.env.CODESHELL_NO_MODEL_SYNC = "1";
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? ""})`);
    }) as never);

    try {
      const { startInkRepl } = await import("./index.js");
      await expect(
        startInkRepl({
          client: {} as never,
          model: "test-model",
          effort: "medium",
          maxTurns: 1,
          cwd: process.cwd(),
          maxContextTokens: 1000,
          sessionId: "test-session",
          renderForTesting,
        }),
      ).rejects.toThrow("process.exit(0)");

      expect(capturedRenderOptions?.exitOnCtrlC).toBe(false);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
