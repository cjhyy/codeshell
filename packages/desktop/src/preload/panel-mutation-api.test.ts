import { expect, test } from "bun:test";
import { createPanelMutationApi } from "./panel-mutation-api.js";

test("preload forwards conditional mutation arguments and structured blockers without reinterpretation", async () => {
  const calls: unknown[][] = [];
  const receipt = {
    ok: false,
    error: "exit unconfirmed",
    blockers: [{ kind: "service", count: 1, label: "feed: stop-unconfirmed; process group 4242" }],
  };
  const api = createPanelMutationApi({
    invoke: async (...args) => {
      calls.push(args);
      return receipt;
    },
  });
  expect(await api.setPanelAppProjectBinding("/project", "fixture", false, "revision")).toBe(
    receipt,
  );
  expect(await api.uninstallPanelApp("fixture", "/project")).toBe(receipt);
  expect(calls).toEqual([
    ["panel-apps:setProjectBinding", "/project", "fixture", false, "revision"],
    ["panel-apps:uninstall", "fixture", "/project"],
  ]);
});
