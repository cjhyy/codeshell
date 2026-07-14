import { chmodSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { isCommandAvailable } from "./manager";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

test("coding LSP finds an executable on PATH without shelling out", () => {
  dir = mkdtempSync(join(tmpdir(), "lsp-path-"));
  const bin = join(dir, "fake-lsp");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);

  expect(isCommandAvailable("fake-lsp", { PATH: dir })).toBe(true);
  expect(isCommandAvailable(bin, { PATH: "" })).toBe(true);
});

test("isCommandAvailable treats shell metacharacters as a literal command name", () => {
  dir = mkdtempSync(join(tmpdir(), "lsp-path-"));
  const sentinel = join(dir, "pwned");

  expect(isCommandAvailable(`fake-lsp; touch ${sentinel}`, { PATH: dir })).toBe(false);
  expect(existsSync(sentinel)).toBe(false);
});
