import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mobileAssetPath, resolveSafe, devProxyPath } from "./mobile-static";

test("devProxyPath: /mobile 映射到 vite 根,根资源原样转发", () => {
  // 页面本身
  expect(devProxyPath("/mobile")).toBe("/");
  expect(devProxyPath("/mobile/")).toBe("/");
  expect(devProxyPath("/mobile?pairing=tok")).toBe("/?pairing=tok");
  // /mobile 子路径 → 去前缀
  expect(devProxyPath("/mobile/assets/x.js")).toBe("/assets/x.js");
  // vite 根资源(白屏根因)→ 原样转发,不被吞
  expect(devProxyPath("/@vite/client")).toBe("/@vite/client");
  expect(devProxyPath("/@react-refresh")).toBe("/@react-refresh");
  expect(devProxyPath("/main.tsx")).toBe("/main.tsx");
  expect(devProxyPath("/main.tsx?t=123")).toBe("/main.tsx?t=123");
  expect(devProxyPath("/node_modules/.vite/deps/react.js")).toBe("/node_modules/.vite/deps/react.js");
});

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "mobile-static-"));
  writeFileSync(join(root, "index.html"), "<!doctype html>");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

test("mobileAssetPath strips /mobile prefix + query", () => {
  expect(mobileAssetPath("/mobile")).toBe("");
  expect(mobileAssetPath("/mobile/")).toBe("");
  expect(mobileAssetPath("/mobile/assets/app.js")).toBe("assets/app.js");
  expect(mobileAssetPath("/mobile?pairing=tok")).toBe("");
  expect(mobileAssetPath("/mobile/assets/app.js?v=1")).toBe("assets/app.js");
});

test("resolveSafe maps empty path → index.html", () => {
  expect(resolveSafe(root, "")).toBe(join(root, "index.html"));
});

test("resolveSafe serves a real nested asset", () => {
  expect(resolveSafe(root, "assets/app.js")).toBe(join(root, "assets", "app.js"));
});

test("resolveSafe returns null for missing files", () => {
  expect(resolveSafe(root, "nope.js")).toBeNull();
});

test("resolveSafe rejects path traversal", () => {
  expect(resolveSafe(root, "../secret")).toBeNull();
  expect(resolveSafe(root, "../../etc/passwd")).toBeNull();
  expect(resolveSafe(root, "assets/../../escape")).toBeNull();
  expect(resolveSafe(root, "/etc/passwd")).toBeNull();
});
