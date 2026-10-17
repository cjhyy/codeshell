import { test, expect } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch } from "../../../packages/coding/src/tools/apply-patch/applier.ts";
import { parsePatch } from "../../../packages/coding/src/tools/apply-patch/parser.ts";

function fixture(run: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "cs-audit-patch-"));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}
function patch(text: string, cwd: string) {
  return applyPatch(parsePatch(`*** Begin Patch\n${text}\n*** End Patch\n`).hunks, { cwd });
}

test("A01 successful move loses the source executable permission; update control retains it", () => fixture(async (dir) => {
  const source = join(dir, "run.sh");
  writeFileSync(source, "#!/bin/sh\necho before\n");
  chmodSync(source, 0o755);
  await patch("*** Update File: run.sh\n-echo before\n+echo middle", dir);
  expect(statSync(source).mode & 0o777).toBe(0o755);
  await patch("*** Update File: run.sh\n*** Move to: moved.sh\n-echo middle\n+echo after", dir);
  expect(existsSync(source)).toBe(false);
  expect(readFileSync(join(dir, "moved.sh"), "utf8")).toBe("#!/bin/sh\necho after\n");
  expect(statSync(join(dir, "moved.sh")).mode & 0o111).toBe(0);
}));

test("A02 rollback after deleting a binary file changes the original bytes", () => fixture(async (dir) => {
  const source = join(dir, "image.bin");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x80]);
  writeFileSync(source, bytes);
  writeFileSync(join(dir, "blocker"), "not a directory");
  await expect(patch("*** Delete File: image.bin\n*** Add File: blocker/new.txt\n+doomed", dir)).rejects.toThrow();
  expect(existsSync(source)).toBe(true);
  expect(readFileSync(source).equals(bytes)).toBe(false);
  expect(readFileSync(source)).toEqual(Buffer.from(bytes.toString("utf8"), "utf8"));
}));

test("A02 rollback also recreates a deleted executable without its mode", () => fixture(async (dir) => {
  const source = join(dir, "run.sh");
  writeFileSync(source, "#!/bin/sh\necho safe\n");
  chmodSync(source, 0o755);
  writeFileSync(join(dir, "blocker"), "not a directory");
  await expect(patch("*** Delete File: run.sh\n*** Add File: blocker/new.txt\n+doomed", dir)).rejects.toThrow();
  expect(readFileSync(source, "utf8")).toBe("#!/bin/sh\necho safe\n");
  expect(statSync(source).mode & 0o111).toBe(0);
}));
