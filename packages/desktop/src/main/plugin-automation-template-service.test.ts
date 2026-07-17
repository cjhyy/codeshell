import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginAutomationTemplateContributions } from "@cjhyy/code-shell-core";
import { CronScheduler } from "@cjhyy/code-shell-core/internal";
import { setAutomationScheduler } from "./automation-service.js";
import { createAutomationFromPluginTemplate } from "./plugin-automation-service.js";

describe("plugin automation template service", () => {
  let home: string;
  let project: string;
  let installPath: string;
  let previousHome: string | undefined;
  let scheduler: CronScheduler;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "plugin-automation-home-"));
    project = mkdtempSync(join(tmpdir(), "plugin-automation-project-"));
    installPath = join(home, ".code-shell", "plugins", "review-plugin");
    mkdirSync(installPath, { recursive: true });
    process.env.HOME = home;
    scheduler = new CronScheduler();
    scheduler.setExecutionEnabled(false);
    setAutomationScheduler(scheduler);
    writeFileSync(
      join(installPath, ".cs-plugin-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "review-plugin",
        version: "1.2.3",
        automations: {
          version: 1,
          templates: [
            {
              id: "weekday-review",
              title: { default: "Weekday review" },
              schedule: "0 9 * * 1-5",
              prompt: "Inspect pending work without modifying files.",
              timezone: "UTC",
              permissionLevel: "read-only",
              workspace: "current",
            },
          ],
        },
      }),
    );
    writeFileSync(
      join(home, ".code-shell", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "review-plugin@local": [
            {
              scope: "user",
              installPath,
              version: "1.2.3",
              installedAt: "2026-07-17T00:00:00.000Z",
              lastUpdated: "2026-07-17T00:00:00.000Z",
            },
          ],
        },
      }),
    );
  });

  afterEach(() => {
    scheduler.stopAll();
    setAutomationScheduler(null);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  test("binds the reviewed revision and copies standalone provenance", () => {
    const contribution = loadPluginAutomationTemplateContributions()[0]!;
    const created = createAutomationFromPluginTemplate(
      contribution.installKey,
      contribution.template.id,
      contribution.revision,
      project,
    );

    expect(created).toMatchObject({
      name: "Weekday review",
      prompt: "Inspect pending work without modifying files.",
      cwd: project,
      permissionLevel: "read-only",
      templateSource: {
        installKey: "review-plugin@local",
        templateId: "weekday-review",
        revision: contribution.revision,
        pluginVersion: "1.2.3",
      },
    });

    rmSync(installPath, { recursive: true, force: true });
    expect(scheduler.get(created.id)?.prompt).toBe("Inspect pending work without modifying files.");
  });

  test("rejects stale revisions after a plugin template changes", () => {
    const contribution = loadPluginAutomationTemplateContributions()[0]!;
    const canonicalPath = join(installPath, ".cs-plugin-manifest.json");
    const canonical = JSON.parse(readFileSync(canonicalPath, "utf-8"));
    canonical.automations.templates[0].prompt = "Changed after review.";
    writeFileSync(canonicalPath, JSON.stringify(canonical));

    expect(() =>
      createAutomationFromPluginTemplate(
        contribution.installKey,
        contribution.template.id,
        contribution.revision,
        project,
      ),
    ).toThrow(/changed after review/);
    expect(scheduler.list()).toHaveLength(0);
  });

  test("rejects templates owned by a disabled plugin", () => {
    const contribution = loadPluginAutomationTemplateContributions()[0]!;
    writeFileSync(
      join(home, ".code-shell", "settings.json"),
      JSON.stringify({ disabledPlugins: ["review-plugin"] }),
    );

    expect(() =>
      createAutomationFromPluginTemplate(
        contribution.installKey,
        contribution.template.id,
        contribution.revision,
        project,
      ),
    ).toThrow(/plugin is disabled/);
  });
});
