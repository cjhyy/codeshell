import { expect, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

// No endpoint, model, credential, filesystem-backed SettingsManager, or sandbox
// configuration is used. Block outbound APIs before importing the pure helper.
const deny = () => { throw new Error("owned migration audit forbids network"); };
globalThis.fetch = deny as any;
http.request = deny as any;
http.get = deny as any;
https.request = deny as any;
https.get = deny as any;
net.connect = deny as any;
net.createConnection = deny as any;
tls.connect = deny as any;

const { migrateConfig, configVersionOf, CURRENT_CONFIG_VERSION } = await import(
  "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/settings/migrate-config.ts"
);

test("ordinary legacy image/video entries receive tag-scoped catalog metadata without mutating input", () => {
  const input = {
    imageGen: { defaultProvider: "owned-image", providers: [{ id: "owned-image", kind: "openai", baseUrl: "https://example.invalid/v1", defaultModel: "owned-model" }] },
    videoGen: { providers: [{ id: "owned-video", kind: "fal", baseUrl: "https://example.invalid/video" }] },
  };
  const original = JSON.stringify(input);
  const result = migrateConfig(input);
  expect(result.fromVersion).toBe(0);
  expect(result.toVersion).toBe(CURRENT_CONFIG_VERSION);
  expect(result.changed).toBe(true);
  expect((result.config.imageGen as any).providers[0].catalogId).toBe("openai-images");
  expect((result.config.videoGen as any).providers[0].catalogId).toBe("fal-video");
  expect((result.config.imageGen as any).providers[0].defaultModel).toBe("owned-model");
  expect(JSON.stringify(input)).toBe(original);
});

test("an existing author catalog choice and an unmatched custom kind survive", () => {
  const result = migrateConfig({ imageGen: { providers: [
    { id: "chosen", kind: "openai", catalogId: "owned-catalog", baseUrl: "https://example.invalid" },
    { id: "custom", kind: "owned-kind", baseUrl: "https://example.invalid" },
  ] } });
  expect((result.config.imageGen as any).providers[0].catalogId).toBe("owned-catalog");
  expect((result.config.imageGen as any).providers[1].catalogId).toBeUndefined();
  expect(result.config.videoGen).toBeUndefined();
});

test("a current-version config remains a no-op and applying migration twice is stable", () => {
  const once = migrateConfig({ imageGen: { providers: [{ id: "owned", kind: "google", baseUrl: "https://example.invalid" }] } });
  const twice = migrateConfig(once.config);
  expect(twice.changed).toBe(false);
  expect(twice.config).toEqual(once.config);
  expect(configVersionOf(twice.config)).toBe(CURRENT_CONFIG_VERSION);
});

test("a partial version does not rerun the earlier catalog backfill", () => {
  const result = migrateConfig({ configVersion: 1, imageGen: { providers: [{ id: "owned", kind: "openai", baseUrl: "https://example.invalid" }] } });
  expect(result.fromVersion).toBe(1);
  expect((result.config.imageGen as any).providers[0].catalogId).toBeUndefined();
  expect(result.config.configVersion).toBe(CURRENT_CONFIG_VERSION);
});
