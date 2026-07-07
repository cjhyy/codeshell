import { describe, expect, test } from "bun:test";
import type { CodeshellApi, PtyStartResult } from "./types";

type RendererPtyStartResult = Awaited<ReturnType<CodeshellApi["ptyStart"]>>;

describe("preload pty contract", () => {
  test("ptyStart exposes success and structured failure results", () => {
    const ok: RendererPtyStartResult = { ok: true, pid: 123 };
    const failed: RendererPtyStartResult = { ok: false, detail: "bad cwd" };
    const samples: PtyStartResult[] = [ok, failed];

    expect(samples).toEqual([
      { ok: true, pid: 123 },
      { ok: false, detail: "bad cwd" },
    ]);
  });
});
