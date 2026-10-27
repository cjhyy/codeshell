import { expect, test } from "bun:test";
import type { ToolContext } from "@cjhyy/code-shell-core/extension";
import { externalRuntimeToolContextForSession } from "./external-runtime-tool-context.js";

test("external tools retain their session and exact credential approval identity", async () => {
  const calls: unknown[][] = [];
  const panels = new Map<string, NonNullable<ToolContext["panels"]>>();
  const bridge = {
    panelBridgeForSession(sessionId: string) {
      const panel = {} as NonNullable<ToolContext["panels"]>;
      panels.set(sessionId, panel);
      return panel;
    },
    async injectCredentialForSession(...args: [string, string, ("full" | "project")?, string?]) {
      expect(this).toBe(bridge);
      calls.push(args);
      return { ok: false, error: "credential changed after approval" };
    },
  };
  const browser = {} as ToolContext["browser"];
  const first = externalRuntimeToolContextForSession(bridge, "session-a", browser);
  const second = externalRuntimeToolContextForSession(bridge, "session-b", undefined);
  expect(first.panels).toBe(panels.get("session-a"));
  expect(second.panels).toBe(panels.get("session-b"));
  expect(first.browser).toBe(browser);
  expect(await first.injectCredentialToBrowser!("account", "project", "approved-record")).toEqual({
    ok: false,
    error: "credential changed after approval",
  });
  await second.injectCredentialToBrowser!("legacy-account");
  expect(calls).toEqual([
    ["session-a", "account", "project", "approved-record"],
    ["session-b", "legacy-account", undefined, undefined],
  ]);
});
