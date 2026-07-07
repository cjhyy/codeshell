import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ReactNode } from "react";
import type { RenderOptions } from "../render/root.js";

let capturedRenderOptions: RenderOptions | undefined;

mock.module("../render/root.js", () => ({
  default: async (_node: ReactNode, options?: RenderOptions) => {
    capturedRenderOptions = options;
    return {
      rerender: () => {},
      unmount: () => {},
      waitUntilExit: async () => {},
      cleanup: () => {},
    };
  },
  renderSync: () => ({
    rerender: () => {},
    unmount: () => {},
    waitUntilExit: async () => {},
    cleanup: () => {},
  }),
  createRoot: async () => ({
    render: () => {},
    unmount: () => {},
    waitUntilExit: async () => {},
  }),
}));

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
        }),
      ).rejects.toThrow("process.exit(0)");

      expect(capturedRenderOptions?.exitOnCtrlC).toBe(false);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
