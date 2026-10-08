import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createManagedDocumentParserResolver } from "./runtime.js";

const temporary: string[] = [];
afterEach(() =>
  temporary.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
);
function fixture(version = "24.21.0") {
  const root = mkdtempSync(join(tmpdir(), "codeshell-parser-runtime-"));
  temporary.push(root);
  const directory = join(root, "node");
  mkdirSync(join(directory, "bin"), { recursive: true });
  const executable = join(directory, "bin", "node");
  const bytes = Buffer.from("Fixture executable: MUST NOT RUN");
  writeFileSync(executable, bytes);
  chmodSync(executable, 0o755);
  writeFileSync(join(directory, "LICENSE"), "Fixture license");
  writeFileSync(
    join(directory, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "node",
      version,
      platform: process.platform,
      arch: process.arch,
      executable: "bin/node",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      source: { url: "https://nodejs.org/dist/fixture.tar.gz", archiveSha256: "a".repeat(64) },
    }),
  );
  return { root, executable };
}

test("trusted parser resolver validates the managed runtime on every resolution without execution", async () => {
  const value = fixture();
  const resolver = createManagedDocumentParserResolver(value.root);
  expect(await resolver()).toBe(realpathSync(value.executable));
  writeFileSync(value.executable, "tampered executable");
  await expect(resolver()).rejects.toThrow("checksum");
});

test("missing, older and cancelled parser runtimes never fall back to PATH", async () => {
  const value = fixture("20.18.3");
  await expect(createManagedDocumentParserResolver(value.root)()).rejects.toThrow("22.13");
  await expect(createManagedDocumentParserResolver(join(value.root, "absent"))()).rejects.toThrow(
    "reinstall",
  );
  const controller = new AbortController();
  controller.abort(new Error("runtime cancelled"));
  await expect(createManagedDocumentParserResolver(value.root)(controller.signal)).rejects.toThrow(
    "runtime cancelled",
  );
});
