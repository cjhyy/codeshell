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
    });
    const { ctx, statuses } = makeCtx(cwd);

    await configCommand().execute("show", ctx);

    const output = statuses.join("\n");
    expect(output).not.toContain("sk-project-secret");
    expect(output).not.toContain("legacy-provider-secret");
    expect(output).not.toContain("search-secret");
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
});
