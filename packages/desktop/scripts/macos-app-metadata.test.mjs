import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureMacosAppMetadata } from "./macos-app-metadata.mjs";

test(
  "native xattr inventory preserves Unicode, modes, resource forks and unfollowed symlinks",
  { skip: process.platform !== "darwin" },
  () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-dmg-metadata-")));
    try {
      const app = join(home, "owned-tree");
      mkdirSync(app, { mode: 0o700 });
      const file = join(app, "报告 with spaces.md");
      writeFileSync(file, "Owned data fork 中文", { mode: 0o600 });
      chmodSync(file, 0o640);
      execFileSync("/usr/bin/xattr", ["-w", "com.codeshell.fixture", "Owned metadata 中文", file]);
      execFileSync("/usr/bin/xattr", ["-w", "com.apple.ResourceFork", "Owned resource fork", file]);
      // A dangling link proves the collector does not dereference its target.
      symlinkSync("missing-owned-target", join(app, "Current"));
      const first = captureMacosAppMetadata(app, home);
      const item = first.records.find(([name]) => name === "./报告 with spaces.md");
      assert.equal(item[1], 0o640);
      const attrs = Object.fromEntries(item[3]);
      const hash = (value) => createHash("sha256").update(value).digest("hex");
      assert.equal(attrs["com.codeshell.fixture"], hash("Owned metadata 中文"));
      assert.equal(attrs["com.apple.ResourceFork"], hash("Owned resource fork"));
      assert.equal(first.records.find(([name]) => name === "./Current")[2], "missing-owned-target");
      assert.equal(captureMacosAppMetadata(app, home).sha256, first.sha256);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
