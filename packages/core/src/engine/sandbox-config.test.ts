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

describe("resolveSandboxConfig", () => {
  test("config.sandbox wins over everything", () => {
    const explicit = defaultSandboxConfig("seatbelt");
    const r = resolveSandboxConfig(explicit, { mode: "off" }, false);
    expect(r).toBe(explicit);
  });

  test("falls back to settings.sandbox.mode when config absent (the fix)", () => {
    const r = resolveSandboxConfig(undefined, { mode: "auto" }, false);
    expect(r.mode).toBe("auto");
  });

  test("settings.sandbox carries network/writableRoots/deniedReads through", () => {
    const r = resolveSandboxConfig(
      undefined,
      { mode: "seatbelt", network: "deny", writableRoots: ["/x"], deniedReads: ["~/.ssh"] },
      false,
    );
    expect(r.mode).toBe("seatbelt");
    expect(r.network).toBe("deny");
    expect(r.writableRoots).toContain("/x");
    expect(r.deniedReads).toContain("~/.ssh");
  });

  test("settings sandbox object without mode → treated as unset, use default", () => {
    // {} (no mode) shouldn't force a mode; fall to per-run default.
    expect(resolveSandboxConfig(undefined, {}, false).mode).toBe("off"); // desktop/REPL
    expect(resolveSandboxConfig(undefined, {}, true).mode).toBe("auto"); // headless
  });

  test("no config, no settings → headless=auto, interactive=off", () => {
    expect(resolveSandboxConfig(undefined, undefined, true).mode).toBe("auto");
    expect(resolveSandboxConfig(undefined, undefined, false).mode).toBe("off");
  });

  test("settings only overrides fields it sets; rest from default for that mode", () => {
    // mode=auto but no writableRoots → inherit default's writableRoots
    const r = resolveSandboxConfig(undefined, { mode: "auto" }, false);
    expect(r.writableRoots.length).toBeGreaterThan(0);
  });
});
