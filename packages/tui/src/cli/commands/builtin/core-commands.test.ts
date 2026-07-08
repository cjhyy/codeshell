import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext } from "../registry.js";
import { coreCommands } from "./core-commands.js";

const tempDirs: string[] = [];

function makeProjectSettings(settings: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-config-command-"));
  tempDirs.push(dir);
  const settingsDir = join(dir, ".code-shell");
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(settings), "utf-8");
  return dir;
}

function makeCtx(cwd: string): { ctx: CommandContext; statuses: string[] } {
  const statuses: string[] = [];
  const ctx = {
    cwd,
    addStatus: (msg: string) => statuses.push(msg),
  } as unknown as CommandContext;
  return { ctx, statuses };
}

function configCommand() {
  const cmd = coreCommands.find((entry) => entry.name === "/config");
  if (!cmd) throw new Error("missing /config command");
  return cmd;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("/config command", () => {
  test("redacts saved secrets from show output", async () => {
    const cwd = makeProjectSettings({
      credentials: [{ id: "openai", catalogId: "openai", apiKey: "sk-project-secret" }],
      providers: {
        openai: { apiKey: "legacy-provider-secret" },
      },
      search: {
        provider: "serper",
        apiKey: "search-secret",
      },
      env: {
        OPENAI_API_KEY: "sk-env-secret",
        GITHUB_TOKEN: "ghp-secret",
        keyboardShortcut: "ctrl+k",
        keymap: "vim",
      },
      mcpServers: {
        browser: {
          headers: { "X-Api-Key": "header-secret" },
          authToken: "auth-token-secret",
          accessToken: "access-token-secret",
          refreshToken: "refresh-token-secret",
          clientSecret: "client-secret",
        },
      },
    });
    const { ctx, statuses } = makeCtx(cwd);

    await configCommand().execute("show", ctx);

    const output = statuses.join("\n");
    expect(output).not.toContain("sk-project-secret");
    expect(output).not.toContain("legacy-provider-secret");
    expect(output).not.toContain("search-secret");
    expect(output).not.toContain("sk-env-secret");
    expect(output).not.toContain("ghp-secret");
    expect(output).not.toContain("header-secret");
    expect(output).not.toContain("auth-token-secret");
    expect(output).not.toContain("access-token-secret");
    expect(output).not.toContain("refresh-token-secret");
    expect(output).not.toContain("client-secret");
    expect(output).toContain('"keyboardShortcut": "ctrl+k"');
    expect(output).toContain('"keymap": "vim"');
    expect(output).toContain("[REDACTED]");
  });

  test("redacts saved secrets from get output", async () => {
    const cwd = makeProjectSettings({
      credentials: [{ id: "openai", catalogId: "openai", apiKey: "sk-project-secret" }],
    });
    const { ctx, statuses } = makeCtx(cwd);

    await configCommand().execute("get credentials.0.apiKey", ctx);

    expect(statuses.join("\n")).toBe('credentials.0.apiKey = "[REDACTED]"');
  });

  test("redacts secret-shaped get keys", async () => {
    const cwd = makeProjectSettings({
      env: {
        OPENAI_API_KEY: "sk-env-secret",
      },
      mcpServers: {
        github: {
          env: { GITHUB_TOKEN: "ghp-secret" },
          headers: { Authorization: "Bearer secret" },
        },
      },
    });
    const { ctx, statuses } = makeCtx(cwd);

    await configCommand().execute("get env.OPENAI_API_KEY", ctx);
    await configCommand().execute("get mcpServers.github.env.GITHUB_TOKEN", ctx);
    await configCommand().execute("get mcpServers.github.headers.Authorization", ctx);

    expect(statuses).toEqual([
      'env.OPENAI_API_KEY = "[REDACTED]"',
      'mcpServers.github.env.GITHUB_TOKEN = "[REDACTED]"',
      'mcpServers.github.headers.Authorization = "[REDACTED]"',
    ]);
  });
});
