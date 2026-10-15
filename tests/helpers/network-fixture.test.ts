import { expect, test } from "bun:test";
import { installFixtureNetworkGuard } from "./network-fixture.js";

test("guard refuses missing redirect flags and foreign origins without repairing producer requests", async () => {
  let calls = 0;
  const guard = installFixtureNetworkGuard((async (input: any, init?: RequestInit) => {
    expect(new Request(input, init).redirect).toBe("error");
    calls++;
    return new Response("fixture");
  }) as typeof fetch);
  guard.allowOrigin("http://127.0.0.1:34725");
  try {
    expect(() => fetch("http://127.0.0.1:34725/mcp")).toThrow("redirect:error");
    expect(() => fetch("https://outside.invalid", { redirect: "error" })).toThrow("non-fixture");
    expect(calls).toBe(0);
    expect(
      await (await fetch(new Request("http://127.0.0.1:34725/mcp", { redirect: "error" }))).text(),
    ).toBe("fixture");
    expect(calls).toBe(1);
  } finally {
    guard.restore();
  }
});
test("nested guards reject out-of-order restoration, preserve the active guard, and restore idempotently", () => {
  const original = globalThis.fetch;
  const first = installFixtureNetworkGuard();
  const second = installFixtureNetworkGuard();
  try {
    expect(() => first.restore()).toThrow("reverse installation order");
  } finally {
    second.restore();
    first.restore();
  }
  first.restore();
  expect(globalThis.fetch).toBe(original);
  expect(() => first.allowOrigin("http://127.0.0.1:34725")).toThrow("closed");
});
