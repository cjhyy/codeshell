import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveQuotaCredentials } from "./credentials.js";
import type { QuotaProvider } from "./types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codeshell-quota-credentials-"));
  roots.push(root);
  const env: NodeJS.ProcessEnv = { HOME: root };
  const files: string[] = [];
  let keychainReads = 0;
  const sources = {
    env,
    platform: "darwin" as const,
    readTextFile: async (path: string) => {
      // Even a resolver regression must never read an operator credential.
      if (!path.startsWith(`${root}/`)) throw new Error("fixture refused non-owned file");
      files.push(path);
      return readFile(path, "utf8");
    },
    readClaudeKeychain: async () => {
      keychainReads++;
      return JSON.stringify({ claudeAiOauth: { accessToken: "fixture-keychain-token" } });
    },
  };
  const write = (directory: string, file: string, value: unknown) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, file), JSON.stringify(value));
  };
  return { root, env, files, sources, write, keychainReads: () => keychainReads };
}

describe("selective quota credentials", () => {
  it("Codex-only uses CODEX_HOME without touching Claude files or Keychain", async () => {
    const f = fixture();
    f.env.CODEX_HOME = join(f.root, "codex-account");
    f.write(f.env.CODEX_HOME, "auth.json", {
      tokens: { access_token: "selected-codex", account_id: "selected-account" },
    });
    f.write(join(f.root, ".codex"), "auth.json", { tokens: { access_token: "wrong-codex" } });
    expect(await resolveQuotaCredentials(["codex"], f.sources)).toEqual({
      codexAccessToken: "selected-codex",
      codexAccountId: "selected-account",
    });
    expect(f.files).toEqual([join(f.env.CODEX_HOME, "auth.json")]);
    expect(f.keychainReads()).toBe(0);
  });

  it("Claude-only uses the default Keychain without reading Codex or a fallback file", async () => {
    const f = fixture();
    expect(await resolveQuotaCredentials(["claude"], f.sources)).toEqual({
      claudeAccessToken: "fixture-keychain-token",
    });
    expect(f.files).toEqual([]);
    expect(f.keychainReads()).toBe(1);
  });

  it("CLAUDE_CONFIG_DIR selects its own credential file without borrowing default Keychain", async () => {
    const f = fixture();
    f.env.CLAUDE_CONFIG_DIR = join(f.root, "claude-account");
    f.write(f.env.CLAUDE_CONFIG_DIR, ".credentials.json", {
      claudeAiOauth: { accessToken: "selected-claude" },
    });
    f.write(join(f.root, ".claude"), ".credentials.json", {
      claudeAiOauth: { accessToken: "wrong-claude" },
    });
    expect(await resolveQuotaCredentials(["claude"], f.sources)).toEqual({
      claudeAccessToken: "selected-claude",
    });
    expect(f.files).toEqual([join(f.env.CLAUDE_CONFIG_DIR, ".credentials.json")]);
    expect(f.keychainReads()).toBe(0);
  });

  it("missing custom Claude credentials do not fall back to another account", async () => {
    const f = fixture();
    f.env.CLAUDE_CONFIG_DIR = join(f.root, "missing-account");
    expect(await resolveQuotaCredentials(["claude"], f.sources)).toEqual({});
    expect(f.files).toEqual([join(f.env.CLAUDE_CONFIG_DIR, ".credentials.json")]);
    expect(f.keychainReads()).toBe(0);
  });

  it("does not normalize the selected credential path into another account", async () => {
    const path = join("/owned", "cafe\u0301", ".credentials.json");
    const reads: string[] = [];
    expect(
      await resolveQuotaCredentials(["claude"], {
        env: { HOME: "/owned", CLAUDE_CONFIG_DIR: join("/owned", "cafe\u0301") },
        platform: "linux",
        readTextFile: async (selected) => {
          reads.push(selected);
          return JSON.stringify({
            claudeAiOauth: { accessToken: selected === path ? "selected" : "wrong-account" },
          });
        },
      }),
    ).toEqual({ claudeAccessToken: "selected" });
    expect(reads).toEqual([path]);
  });

  it("defaults to both while preserving platform-specific file fallback", async () => {
    const f = fixture();
    f.write(join(f.root, ".codex"), "auth.json", {
      tokens: { access_token: "codex-file", account_id: "account" },
    });
    f.write(join(f.root, ".claude"), ".credentials.json", {
      claudeAiOauth: { accessToken: "claude-file" },
    });
    expect(await resolveQuotaCredentials(undefined, { ...f.sources, platform: "linux" })).toEqual({
      claudeAccessToken: "claude-file",
      codexAccessToken: "codex-file",
      codexAccountId: "account",
    });
    expect(f.files.sort()).toEqual([
      join(f.root, ".claude", ".credentials.json"),
      join(f.root, ".codex", "auth.json"),
    ]);
    expect(f.keychainReads()).toBe(0);
  });

  it("an unavailable Keychain falls back only to the selected Claude file", async () => {
    const f = fixture();
    f.write(join(f.root, ".claude"), ".credentials.json", {
      claudeAiOauth: { accessToken: "claude-fallback" },
    });
    expect(
      await resolveQuotaCredentials(["claude"], {
        ...f.sources,
        readClaudeKeychain: async () => {
          throw new Error("fixture Keychain denied");
        },
      }),
    ).toEqual({ claudeAccessToken: "claude-fallback" });
    expect(f.files).toEqual([join(f.root, ".claude", ".credentials.json")]);
  });

  it("deduplicates selections and leaves an empty selection empty", async () => {
    const f = fixture();
    expect(await resolveQuotaCredentials([], f.sources)).toEqual({});
    expect(f.files).toEqual([]);
    expect(f.keychainReads()).toBe(0);
    await resolveQuotaCredentials(["claude", "claude"], f.sources);
    expect(f.keychainReads()).toBe(1);
  });

  it.each(
    [null, "codex", ["openclaw"], ["codex", "dsh"], [undefined], new Array(1)].map((providers) => ({
      providers,
    })),
  )(
    "rejects invalid selections before accessing any credential source: %j",
    async ({ providers }) => {
      const f = fixture();
      await expect(
        resolveQuotaCredentials(providers as readonly QuotaProvider[], f.sources),
      ).rejects.toThrow("Invalid quota provider");
      expect(f.files).toEqual([]);
      expect(f.keychainReads()).toBe(0);
    },
  );
});
