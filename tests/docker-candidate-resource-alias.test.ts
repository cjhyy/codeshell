import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

test("actual Node validates immutable resource alias custody and adversarial variants", () => {
  // Bun 1.3.11 on macOS canonicalizes a hard link to another alias's path.
  // The candidate runs Node; preserve its exact realpath/O_NOFOLLOW semantics.
  const result = spawnSync(
    realpathSync(Bun.which("node")!),
    [
      fileURLToPath(new URL("../scripts/run-isolated-node-smoke.mjs", import.meta.url)),
      "--test",
      fileURLToPath(
        new URL("./fixtures/docker-candidate-resource-alias-case.mjs", import.meta.url),
      ),
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.stdout).toMatch(/tests 7/);
  expect(result.stdout).toMatch(/pass 7/);
  expect(result.stdout).toMatch(/skipped 0/);
});
