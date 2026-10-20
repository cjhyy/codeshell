import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rpcResult } from "./rpc-result";

// The renderer's run controller reads `reason`/`text` from a RunResult and
// shows a rejection through its catch. Both only work on an unwrapped reply.
test("a native run reply resolves to its RunResult", () => {
  const result = { reason: "image_error", text: "ERROR: input attachment could not be read" };
  expect(rpcResult({ jsonrpc: "2.0", id: "desktop-rpc-1", result })).toEqual(result);
});

test("a native run error reply rejects with the host's explanation", () => {
  expect(() =>
    rpcResult({
      jsonrpc: "2.0",
      id: "desktop-rpc-1",
      error: { code: -32000, message: "配置正在更新，请稍后重试。" },
    }),
  ).toThrow("配置正在更新，请稍后重试。");
});

// The preload itself imports Electron and cannot load under Bun.
test("the preload run binding unwraps its JSON-RPC reply", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  expect(source).toMatch(/rpc\("agent\/run",[^;]*?\)\s*\.then\(rpcResult\)/s);
});
