import { expect, test } from "bun:test";
import { readCurrentWorkspace } from "./workspace-reads.js";
import type { HostRequestContext } from "./authority.js";

const context: HostRequestContext = {
  identity: { webContentsId: 1, frameGeneration: 1, frameToken: "test", windowKind: "workbench" },
  assertCurrent() {},
};
test("an in-flight file read cannot return after a project root is unmounted and mounted again", async () => {
  let revision = 1;
  const lookup = async () => ({ path: "/mounted", revision });
  const fresh = await readCurrentWorkspace(lookup, context, async ({ revision }) => revision);
  expect(fresh).toBe(1);
  await expect(
    readCurrentWorkspace(lookup, context, async () => {
      revision += 2;
      return "stale file contents";
    }),
  ).rejects.toThrow("revoked");
});
