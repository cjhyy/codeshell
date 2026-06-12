import { describe, test, expect } from "bun:test";
import { pluginsNeedingInstall, type CorePlugin } from "./bootstrap-core-plugins.js";

/**
 * Pure decision logic for the first-run soft pre-install (feedback#22).
 * The contract under test: marker wins (never touch again), pre-existing
 * installs get recorded not reinstalled, everything else is attempted.
 */
describe("pluginsNeedingInstall", () => {
  const core: CorePlugin[] = [{ plugin: "skill-creator", marketplace: "mimi-plugins" }];

  test("fresh machine → core plugin is attempted", () => {
    const r = pluginsNeedingInstall(core, {}, []);
    expect(r.toInstall).toEqual(core);
    expect(r.alreadyInstalled).toEqual([]);
  });

  test("marker present → never attempted again (install-once, even after user uninstall)", () => {
    const r = pluginsNeedingInstall(
      core,
      { "skill-creator@mimi-plugins": "2026-06-13T00:00:00Z" },
      [],
    );
    expect(r.toInstall).toEqual([]);
    expect(r.alreadyInstalled).toEqual([]);
  });

  test("user already installed it manually → recorded as pre-existing, not reinstalled", () => {
    const r = pluginsNeedingInstall(core, {}, ["skill-creator@mimi-plugins"]);
    expect(r.toInstall).toEqual([]);
    expect(r.alreadyInstalled).toEqual(core);
  });

  test("unrelated installed plugins don't block the attempt", () => {
    const r = pluginsNeedingInstall(core, {}, ["superpowers@official"]);
    expect(r.toInstall).toEqual(core);
  });

  test("failed attempt (no marker written) → retried on the next call", () => {
    // Simulates the silent-retry contract: a failure writes no marker, so the
    // same inputs produce the same attempt next startup.
    const first = pluginsNeedingInstall(core, {}, []);
    const second = pluginsNeedingInstall(core, {}, []);
    expect(first.toInstall).toEqual(second.toInstall);
  });
});
