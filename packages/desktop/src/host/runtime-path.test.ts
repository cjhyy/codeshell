import { expect, test } from "bun:test";
import { createRuntimePath } from "./runtime-path.js";
import { isDesktopHostControl } from "../shared/desktop-host-protocol.js";

test("the native utility waits to spawn until its own Main supplies the prepared PATH once", async () => {
  const env = { PATH: "gui", UNRELATED: "keep" };
  const path = createRuntimePath(true, env);
  const starts: string[] = [];
  path.whenReady(() => starts.push(env.PATH));
  await Promise.resolve();
  expect(starts).toEqual([]);
  path.install("prepared");
  path.install("late");
  await path.ready;
  expect(starts).toEqual(["prepared"]);
  expect(path.searchPath("earlier worker snapshot")).toBe("prepared");
  expect(env).toEqual({ PATH: "prepared", UNRELATED: "keep" });
  path.whenReady(() => starts.push(env.PATH));
  expect(starts).toHaveLength(2);
});

test("standalone Host uses the caller's environment and ignores late PATH messages", () => {
  const env = { PATH: "original" };
  const path = createRuntimePath(false, env);
  let started = false;
  path.whenReady(() => {
    started = true;
  });
  expect(started).toBe(true);
  path.install("foreign");
  expect(env.PATH).toBe("original");
  expect(path.searchPath("fixture")).toBe("fixture");
});

test("native PATH control accepts only the exact message and rejects NUL", () => {
  expect(isDesktopHostControl({ type: "runtime-path", path: "fixture" })).toBe(true);
  expect(isDesktopHostControl({ type: "runtime-path", path: "a\0b" })).toBe(false);
  expect(isDesktopHostControl({ type: "runtime-path", path: "ok", env: {} })).toBe(false);
});
