import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installReviewedLocalPanelApp,
  invalidateSkillCache,
  previewLocalPanelApp,
} from "@cjhyy/code-shell-core";
import type { CommandContext } from "../registry.js";
import { clearAuthSettingsFile, extraCommands, loginConfigureParams } from "./extra-commands.js";

describe("/skills", () => {
  it("shows a bound Panel package Skill without opening the Panel, respecting disable and binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "codeshell-tui-panel-skills-"));
    const previousHome = process.env.HOME;
    process.env.HOME = join(root, "home");
    try {
      const source = join(root, "source");
      const cwd = join(root, "workspace");
      const id = "runtime-fixture";
      for (const dir of [".codeshell-panel", "app", "agent/skills/project-runtime"]) {
        mkdirSync(join(source, dir), { recursive: true });
      }
      mkdirSync(join(cwd, ".code-shell"), { recursive: true });
      writeFileSync(join(source, "app/index.html"), "<body>Fixture</body>");
      writeFileSync(
        join(source, "agent/skills/project-runtime/SKILL.md"),
        "---\nname: project-runtime\ndescription: Operate on project data without opening a Panel\n---\nUse the selected package runtime.\n",
      );
      writeFileSync(
        join(source, ".codeshell-panel/panel.json"),
        JSON.stringify({
          schemaVersion: 2,
          id,
          version: "1.0.0",
          title: { default: "Runtime Fixture" },
          entry: "app/index.html",
          permissions: [],
          agent: { tools: [], skills: ["agent/skills/project-runtime/SKILL.md"] },
        }),
      );
      const input = { kind: "dir" as const, path: source };
      const preview = await previewLocalPanelApp(input);
      const installed = await installReviewedLocalPanelApp(
        input,
        preview.reviewToken,
        "2026-10-13T00:00:00.000Z",
      );
      const statuses: string[] = [];
      const ctx = { cwd, addStatus: (message: string) => statuses.push(message) } as CommandContext;
      const command = extraCommands.find((item) => item.name === "/skills")!;
      invalidateSkillCache();
      await command.execute("", ctx);
      expect(statuses.at(-1)).toContain("No skills found");

      writeFileSync(
        join(cwd, ".code-shell/settings.json"),
        JSON.stringify({
          panelAppBindings: [id],
          panelAppPins: {
            [id]: { version: installed.version, packageDigest: installed.packageDigest },
          },
        }),
      );
      await command.execute("", ctx);
      expect(statuses.at(-1)).toBe(
        "Panel App skills (1):\n  runtime-fixture:project-runtime — Operate on project data without opening a Panel",
      );

      writeFileSync(
        join(process.env.HOME, ".code-shell/settings.json"),
        JSON.stringify({ disabledPanelApps: [id] }),
      );
      await command.execute("", ctx);
      expect(statuses.at(-1)).toContain("No skills found");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      invalidateSkillCache();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("/login", () => {
  it("reloads models and switches the current session to the active/default connection", () => {
    expect(loginConfigureParams("sess-1", "conn-text")).toEqual({
      sessionId: "sess-1",
      reloadModels: true,
      model: "conn-text",
    });
  });
});

describe("/logout", () => {
  it("clears legacy and unified auth/model settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "codeshell-logout-"));
    const file = join(dir, "settings.json");
    writeFileSync(
      file,
      JSON.stringify({
        model: { provider: "openai" },
        models: { a: {} },
        providers: { openai: {} },
        arena: { models: [] },
        activeKey: "a",
        credentials: [{ id: "key", apiKey: "sk-test" }],
        modelConnections: [{ id: "conn", credentialId: "key" }],
        defaults: { text: "conn" },
        mcpServers: { keep: { command: "x" } },
      }),
    );

    const cleared = clearAuthSettingsFile(file);
    expect(cleared.sort()).toEqual([
      "activeKey",
      "arena",
      "credentials",
      "defaults",
      "model",
      "modelConnections",
      "models",
      "providers",
    ]);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
      mcpServers: { keep: { command: "x" } },
    });
  });
});
