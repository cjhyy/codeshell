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
  it("CURRENT_CONFIG_VERSION matches the highest registered step (2 today)", () => {
    expect(CURRENT_CONFIG_VERSION).toBe(2);
  });
  it("real migrateConfig stamps the current version on a bare config", () => {
    const r = migrateConfig({ providers: [] });
    expect(r.config[CONFIG_VERSION_KEY]).toBe(CURRENT_CONFIG_VERSION);
  });
});

describe("v0→v1: backfill gen provider catalogId", () => {
  it("backfills catalogId on legacy imageGen/videoGen providers by kind+tag", () => {
    const r = migrateConfig({
      imageGen: {
        defaultProvider: "openai",
        providers: [
          { id: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-x" },
          { id: "g", kind: "google", apiKey: "k" },
        ],
      },
      videoGen: { providers: [{ id: "fal", kind: "fal", apiKey: "f" }] },
    });
    const img = (r.config.imageGen as { providers: Array<Record<string, unknown>> }).providers;
    expect(img[0]!.catalogId).toBe("openai-images");
    expect(img[1]!.catalogId).toBe("google-images");
    const vid = (r.config.videoGen as { providers: Array<Record<string, unknown>> }).providers;
    expect(vid[0]!.catalogId).toBe("fal-video");
    // Other fields survive untouched.
    expect(img[0]!.apiKey).toBe("sk-x");
    expect((r.config.imageGen as Record<string, unknown>).defaultProvider).toBe("openai");
  });

  it("leaves entries that already have a catalogId alone", () => {
    const r = migrateConfig({
      imageGen: { providers: [{ id: "x", kind: "openai", catalogId: "custom-id" }] },
    });
    const img = (r.config.imageGen as { providers: Array<Record<string, unknown>> }).providers;
    expect(img[0]!.catalogId).toBe("custom-id");
  });

  it("leaves unmatched kinds untouched and does not invent sections", () => {
    const r = migrateConfig({
      imageGen: { providers: [{ id: "m", kind: "mystery", apiKey: "k" }] },
    });
    const img = (r.config.imageGen as { providers: Array<Record<string, unknown>> }).providers;
    expect(img[0]!.catalogId).toBeUndefined();
    expect(r.config.videoGen).toBeUndefined();
  });

  it("tolerates malformed gen sections", () => {
    const cfg = { imageGen: "nope", videoGen: { providers: "also nope" } };
    const r = migrateConfig(cfg);
    expect(r.config.imageGen).toBe("nope");
    expect((r.config.videoGen as Record<string, unknown>).providers).toBe("also nope");
  });

  it("video kind does not match image-tag entries (tag scoping)", () => {
    // "openai" exists only under tag:image — a videoGen provider with that
    // kind must NOT pick up the image catalog entry.
    const r = migrateConfig({
      videoGen: { providers: [{ id: "o", kind: "openai", apiKey: "k" }] },
    });
    const vid = (r.config.videoGen as { providers: Array<Record<string, unknown>> }).providers;
    expect(vid[0]!.catalogId).toBeUndefined();
  });
});

describe("v1→v2: clear mis-written sandbox auto default", () => {
  // The 设置页 used to write sandbox:{mode:auto, network:allow, writableRoots:[],
  // deniedReads:[]} (its display default) whenever the user saved the local-env
  // page — opting people into a sandbox they never chose. This migration removes
  // that fingerprint so they fall back to "follow/off". A user who actually
  // configured sandbox (changed network/roots/mode) is left untouched.
  it("removes the mis-written auto fingerprint", () => {
    const r = migrateConfig({
      [CONFIG_VERSION_KEY]: 1,
      sandbox: { mode: "auto", network: "allow", writableRoots: [], deniedReads: [] },
    });
    expect(r.config.sandbox).toBeUndefined();
    expect(r.changed).toBe(true);
  });

  it("keeps a user-configured sandbox (network changed)", () => {
    const r = migrateConfig({
      [CONFIG_VERSION_KEY]: 1,
      sandbox: { mode: "auto", network: "deny", writableRoots: [], deniedReads: [] },
    });
    expect(r.config.sandbox).toEqual({ mode: "auto", network: "deny", writableRoots: [], deniedReads: [] });
  });

  it("keeps a user-configured sandbox (explicit mode like seatbelt)", () => {
    const r = migrateConfig({
      [CONFIG_VERSION_KEY]: 1,
      sandbox: { mode: "seatbelt", network: "allow", writableRoots: [], deniedReads: [] },
    });
    expect((r.config.sandbox as { mode: string }).mode).toBe("seatbelt");
  });

  it("keeps a sandbox with non-empty roots/reads", () => {
    const r = migrateConfig({
      [CONFIG_VERSION_KEY]: 1,
      sandbox: { mode: "auto", network: "allow", writableRoots: ["/x"], deniedReads: [] },
    });
    expect(r.config.sandbox).toBeTruthy();
  });

  it("no sandbox field → untouched", () => {
    const r = migrateConfig({ [CONFIG_VERSION_KEY]: 1, foo: 1 });
    expect(r.config.sandbox).toBeUndefined();
    expect((r.config as { foo: number }).foo).toBe(1);
  });
});
