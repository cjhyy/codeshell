import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImGatewayService } from "./im-gateway-service.js";

describe("ImGatewayService", () => {
  test("creates an owner-only editable config and reports missing channels", () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-service-"));
    const configPath = join(root, "nested", "config.json");
    const service = new ImGatewayService({ configPath });

    expect(service.status().configExists).toBe(false);
    expect(service.ensureConfig()).toBe(configPath);
    expect(existsSync(configPath)).toBe(true);
    const template = JSON.parse(readFileSync(configPath, "utf8"));
    expect(template.telegram.enabled).toBe(false);
    expect(template.wechat.enabled).toBe(false);
    expect(service.status().channels).toEqual([]);
    if (process.platform !== "win32") expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  test("reports configured channels without exposing their secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-im-gateway-status-"));
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        telegram: {
          botToken: "secret-token",
          allowedChatIds: ["owner-chat"],
        },
      }),
      { mode: 0o600 },
    );
    if (process.platform !== "win32") chmodSync(configPath, 0o600);

    const status = new ImGatewayService({ configPath }).status();
    expect(status.channels).toEqual(["telegram"]);
    expect(status.error).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("secret-token");
  });
});
