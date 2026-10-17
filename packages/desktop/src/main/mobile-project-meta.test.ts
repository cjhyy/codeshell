import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { toMobileProjectMeta } from "./mobile-project-meta.js";
// This relative module imports only node:fs/path, not Core's Engine/SDK barrel.
import { canonicalKey } from "../../../core/src/workspace/canonical-key.js";
import { projectForCwd } from "../../../web/src/lib/format.js";

test("Mobile metadata carries the real Host canonical-key policy for owned disk roots", async () => {
  expect(process.env.CODE_SHELL_TEST_HOME).toBeDefined();
  const directory = await mkdtemp(join(process.env.CODE_SHELL_TEST_HOME!, "project-policy-"));
  try {
    const upper = join(directory, "Example");
    const lower = join(directory, "example");
    await mkdir(upper);
    const sensitive = canonicalKey(upper) !== canonicalKey(lower);
    if (sensitive) await mkdir(lower);
    const project = (id: string, path: string) =>
      toMobileProjectMeta({
        id,
        name: id,
        roots: [{ id: `${id}-root`, path, name: "main", addedAt: 1 }],
        primaryRootId: `${id}-root`,
        createdAt: 1,
        updatedAt: 1,
        lastOpenedAt: 1,
        revision: 1,
      });
    const upperMeta = project("upper", upper);
    expect(upperMeta.pathCaseSensitive).toBe(sensitive);
    const projects = sensitive ? [upperMeta, project("lower", lower)] : [upperMeta];
    expect(projectForCwd(lower, projects)?.id).toBe(sensitive ? "lower" : "upper");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
