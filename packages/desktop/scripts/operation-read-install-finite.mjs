/** Separate guarded Node installer so Playwright's controller keeps its own transport. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  prepareFiniteHookFixture,
  prepareFiniteHookBoundsFixture,
} from "../../../scripts/fixtures/finite-hook-package.mjs";
const home = process.argv[2],
  bounds = process.argv[3] === "--resource-bounds";
assert.equal(home, process.env.HOME);
await import("./operation-read-guard.mjs");
const config = JSON.parse(await readFile(join(home, "read-fixture.json"), "utf8"));
const settingsBytes = await readFile(join(home, "positive-settings.json"), "utf8");
const fixture = await (bounds ? prepareFiniteHookBoundsFixture : prepareFiniteHookFixture)({
  coreUrl: config.coreUrl,
  home,
  cwd: join(home, "synthetic-project"),
  settingsScope: "full",
  settingsBytes,
  largeResources: bounds,
});
await writeFile(join(home, "finite-installed.json"), JSON.stringify(fixture), { mode: 0o600 });
