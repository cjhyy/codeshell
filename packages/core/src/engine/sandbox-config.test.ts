/**
 * resolveSandboxConfig — decide the sandbox config for a run. Priority:
 *   1. config.sandbox (explicit host-passed) — wins.
 *   2. settings.sandbox.mode (project/user設置页) — so the setting actually
 *      takes effect (previously the engine never read it: a real broken link).
 *   3. per-run default: headless → auto, REPL/desktop → off.
 * Project-scoped: settings come from the run's resolved settings, so each
 * project's sandbox config applies to that project.
 */
import { describe, test, expect } from "bun:test";
import { resolveSandboxConfig } from "./sandbox-config.js";
import { defaultSandboxConfig } from "../tool-system/sandbox/index.js";

// Signature: resolveSandboxConfig(config, projectSandbox, globalSandbox, headless)
// Priority: config > project(有mode) > global(有mode) > per-run default.
describe("resolveSandboxConfig — three layers", () => {
  test("config.sandbox wins over everything", () => {
    const explicit = defaultSandboxConfig("seatbelt");
    expect(resolveSandboxConfig(explicit, { mode: "off" }, { mode: "auto" }, false)).toBe(explicit);
  });

  test("project (has mode) overrides global", () => {
    const r = resolveSandboxConfig(undefined, { mode: "seatbelt" }, { mode: "off" }, false);
    expect(r.mode).toBe("seatbelt");
  });

  test("project without mode → follow global (the 跟随 case)", () => {
    const r = resolveSandboxConfig(undefined, undefined, { mode: "auto" }, false);
    expect(r.mode).toBe("auto");
    const r2 = resolveSandboxConfig(undefined, {}, { mode: "auto" }, false); // {} = no mode = follow
    expect(r2.mode).toBe("auto");
  });

  test("global mode + network used when project follows", () => {
    const r = resolveSandboxConfig(undefined, undefined, { mode: "seatbelt", network: "deny" }, false);
    expect(r.mode).toBe("seatbelt");
    expect(r.network).toBe("deny");
  });

  test("neither project nor global set → per-run default (headless=auto, desktop=off)", () => {
    expect(resolveSandboxConfig(undefined, undefined, undefined, true).mode).toBe("auto");
    expect(resolveSandboxConfig(undefined, undefined, undefined, false).mode).toBe("off");
    expect(resolveSandboxConfig(undefined, {}, {}, false).mode).toBe("off"); // both no-mode
  });

  test("the effective layer carries its network/roots/reads through", () => {
    const r = resolveSandboxConfig(
      undefined,
      { mode: "seatbelt", network: "deny", writableRoots: ["/x"], deniedReads: ["~/.ssh"] },
      undefined,
      false,
    );
    expect(r.network).toBe("deny");
    expect(r.writableRoots).toContain("/x");
    expect(r.deniedReads).toContain("~/.ssh");
  });

  test("layer with mode but no other fields → inherit that mode's defaults", () => {
    const r = resolveSandboxConfig(undefined, undefined, { mode: "auto" }, false);
    expect(r.writableRoots.length).toBeGreaterThan(0);
  });
});
