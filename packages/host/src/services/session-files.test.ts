import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Node Host exports and sync/async session reads reject replaced identities and close handles", () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const result = spawnSync(
    "node",
    ["scripts/run-isolated-node-smoke.mjs", "scripts/smoke-host-shared-session-files.mjs"],
    { cwd: root, encoding: "utf8" },
  );
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  expect(result.stdout).toContain("four session identity replacement cases passed");
});
