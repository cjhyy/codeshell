import { describe, test, expect } from "bun:test";
import { classifyLocalInstallError } from "./marketplace-service.js";

/**
 * Local-install error classification (protects the unsubmitted overwrite UI
 * flow). The contract: core bakes the authoritative plugin name into a
 * "plugin '<name>' already installed" error; the UI must extract that exact
 * name and surface { alreadyInstalled: true } so the overwrite prompt names the
 * right plugin. If core ever changes this error wording, the fragile regex
 * would silently break the overwrite flow — this test pins it.
 */
describe("classifyLocalInstallError", () => {
  test("already-installed error → { alreadyInstalled, authoritative name }", () => {
    const r = classifyLocalInstallError("plugin 'superpowers' already installed");
    expect(r).toEqual({ ok: false, alreadyInstalled: true, name: "superpowers" });
  });

  test("extracts the name core derived (manifest name), not the picker's filename guess", () => {
    // zip picked as "my-download.zip" but the manifest name is "mimi-video".
    const r = classifyLocalInstallError("plugin 'mimi-video' already installed");
    expect(r).toMatchObject({ alreadyInstalled: true, name: "mimi-video" });
  });

  test("handles names with spaces/hyphens (non-greedy capture stops at the quote)", () => {
    const r = classifyLocalInstallError("plugin 'My Cool-Plugin' already installed");
    expect(r).toMatchObject({ alreadyInstalled: true, name: "My Cool-Plugin" });
  });

  test("unrelated error → humanized { ok:false, error } without alreadyInstalled", () => {
    const r = classifyLocalInstallError("some random failure");
    expect(r).toEqual({ ok: false, error: "some random failure" });
    expect("alreadyInstalled" in r).toBe(false);
  });

  test("GIT_NOT_FOUND is humanized to actionable guidance", () => {
    const r = classifyLocalInstallError("GIT_NOT_FOUND: git not on PATH");
    expect(r.ok).toBe(false);
    if (!("alreadyInstalled" in r)) {
      expect(r.error).toContain("Git");
      expect(r.error).toContain("git-scm.com");
    }
  });
});
