import { describe, it, expect } from "bun:test";
import { probeCli } from "./cc-capability.js";

describe("probeCli", () => {
  it("reports available + version when the probe runner resolves a version", async () => {
    const r = await probeCli("claude", async () => ({
      ok: true,
      stdout: "2.1.186 (Claude Code)\n",
    }));
    expect(r.available).toBe(true);
    expect(r.version).toBe("2.1.186 (Claude Code)");
  });
  it("reports not-found when the runner throws ENOENT", async () => {
    const r = await probeCli("claude", async () => {
      const e: any = new Error("nope");
      e.code = "ENOENT";
      throw e;
    });
    expect(r.available).toBe(false);
    expect(r.reason).toBe("not-found");
  });
  it("reports not-executable on non-ENOENT failure", async () => {
    const r = await probeCli("claude", async () => ({ ok: false, stdout: "" }));
    expect(r.available).toBe(false);
    expect(r.reason).toBe("not-executable");
  });
});
