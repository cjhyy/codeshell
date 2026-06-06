import { describe, it, expect } from "bun:test";
import {
  migrateConfig,
  configVersionOf,
  CURRENT_CONFIG_VERSION,
  CONFIG_VERSION_KEY,
  type MigrationStep,
} from "./migrate-config.js";

// Sample migration chain for testing the framework mechanics independently of
// the (currently empty) production registry.
const steps: MigrationStep[] = [
  { from: 0, to: 1, migrate: (c) => ({ ...c, a: 1 }) },
  { from: 1, to: 2, migrate: (c) => ({ ...c, b: 2 }) },
];

describe("configVersionOf", () => {
  it("defaults missing/invalid version to 0", () => {
    expect(configVersionOf({})).toBe(0);
    expect(configVersionOf({ configVersion: "x" })).toBe(0);
    expect(configVersionOf({ configVersion: -1 })).toBe(0);
  });
  it("reads + floors a numeric version", () => {
    expect(configVersionOf({ configVersion: 3 })).toBe(3);
    expect(configVersionOf({ configVersion: 2.9 })).toBe(2);
  });
});

describe("migrateConfig (framework)", () => {
  it("applies all steps in order from version 0", () => {
    const r = migrateConfig({ keep: true }, steps);
    expect(r.fromVersion).toBe(0);
    expect(r.toVersion).toBe(2);
    expect(r.changed).toBe(true);
    expect(r.config).toEqual({ keep: true, a: 1, b: 2, [CONFIG_VERSION_KEY]: 2 });
  });

  it("resumes from a partial version (skips already-applied steps)", () => {
    const r = migrateConfig({ configVersion: 1, existing: "x" }, steps);
    expect(r.config.a).toBeUndefined(); // step 0→1 NOT re-run
    expect(r.config.b).toBe(2); // step 1→2 ran
    expect(r.config[CONFIG_VERSION_KEY]).toBe(2);
  });

  it("is a no-op (changed:false) when already at current", () => {
    const r = migrateConfig({ configVersion: 2, b: 2 }, steps);
    expect(r.changed).toBe(false);
    expect(r.config[CONFIG_VERSION_KEY]).toBe(2);
  });

  it("never mutates the input", () => {
    const input = { configVersion: 0 };
    migrateConfig(input, steps);
    expect(input).toEqual({ configVersion: 0 });
  });

  it("stamps the version even with an empty migration list (just adds the key)", () => {
    const r = migrateConfig({ x: 1 }, []);
    expect(r.config).toEqual({ x: 1, [CONFIG_VERSION_KEY]: 0 });
    expect(r.changed).toBe(true); // version key was added
  });
});

describe("production registry", () => {
  it("CURRENT_CONFIG_VERSION matches the highest registered step (0 today)", () => {
    expect(CURRENT_CONFIG_VERSION).toBe(0);
  });
  it("real migrateConfig stamps the current version on a bare config", () => {
    const r = migrateConfig({ providers: [] });
    expect(r.config[CONFIG_VERSION_KEY]).toBe(CURRENT_CONFIG_VERSION);
  });
});
