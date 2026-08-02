/**
 * End-to-end reachability of the model-picker entries.
 *
 * Every individual piece of this feature had passing tests while the entries
 * were invisible in the product, because the flag defaulted off and the IPC
 * handler returned `[]` before any of them ran. Unit tests that each stub the
 * layer above cannot catch that: the bug lives in the composition.
 *
 * So this walks the actual chain the renderer walks — resolved flags → binary
 * probe → catalog entries — with nothing stubbed except the PATH.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isFeatureEnabled, resolveFeatureFlags } from "@cjhyy/code-shell-core/extension";
import { availableExternalRuntimes } from "./external-runtime-availability.js";
import { externalRuntimeModelEntries } from "../shared/external-runtime-models.js";

/** A PATH containing both runtime binaries. */
function pathWithBoth(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-reachable-"));
  for (const name of ["codex", "claude"]) {
    const file = join(dir, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  return { path: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("model picker reachability", () => {
  test("with stock settings and both binaries, the picker gains entries", () => {
    // The regression this exists for: all layers green, zero entries shown.
    const flags = resolveFeatureFlags({});
    expect(isFeatureEnabled(flags, "external_agent_runtime")).toBe(true);

    const { path, cleanup } = pathWithBoth();
    try {
      const entries = externalRuntimeModelEntries(availableExternalRuntimes(path));
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((entry) => entry.kind === "codex")).toBe(true);
      expect(entries.some((entry) => entry.kind === "claude-code")).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("host tools are on too, or the runtime has an empty tool surface", () => {
    // external_agent_runtime alone yields a runtime that can start and do
    // nothing — no skills, no memory, no files. Shipping that reads as broken.
    expect(isFeatureEnabled(resolveFeatureFlags({}), "external_host_tools")).toBe(true);
  });

  test("turning the flag off still hides everything", () => {
    // The escape hatch is the reason default-on is defensible.
    const flags = resolveFeatureFlags({ external_agent_runtime: false });
    expect(isFeatureEnabled(flags, "external_agent_runtime")).toBe(false);
  });

  test("no binaries means no entries, flag or not", () => {
    // A machine without Codex must see exactly what it saw before — this is
    // what replaced the flag as the real guard on "don't depend on a binary".
    const dir = mkdtempSync(join(tmpdir(), "codeshell-reachable-empty-"));
    try {
      expect(externalRuntimeModelEntries(availableExternalRuntimes(dir))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
