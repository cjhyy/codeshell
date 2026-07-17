import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronScheduler } from "../automation/scheduler.js";
import { loadPluginAutomationTemplateContributions } from "./pluginCatalog.js";
import { instantiatePluginAutomationTemplate } from "./pluginAutomationTemplates.js";

describe("instantiatePluginAutomationTemplate", () => {
  let home: string;
  let project: string;
  let previousHome: string | undefined;
  let scheduler: CronScheduler;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "plugin-template-home-"));
    project = mkdtempSync(join(tmpdir(), "plugin-template-project-"));
    process.env.HOME = home;
    scheduler = new CronScheduler();
    scheduler.setExecutionEnabled(false);
    const installPath = join(home, ".code-shell", "plugins", "review");
    mkdirSync(installPath, { recursive: true });
    writeFileSync(
      join(installPath, ".cs-plugin-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "review",
        version: "2.0.0",
        automations: {
          version: 1,
          templates: [
            {
              id: "daily",
              title: { default: "Daily review" },
              schedule: "1d",
              prompt: "Review without writing.",
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
          "review@local": [
            {
              scope: "user",
              installPath,
              version: "2.0.0",
              installedAt: "t1",
              lastUpdated: "t1",
            },
          ],
        },
      }),
    );
  });

  afterEach(() => {
    scheduler.stopAll();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  test("creates only the reviewed canonical content with standalone provenance", () => {
    const contribution = loadPluginAutomationTemplateContributions()[0]!;
    const job = instantiatePluginAutomationTemplate({
      scheduler,
      installKey: contribution.installKey,
      templateId: contribution.template.id,
      expectedRevision: contribution.revision,
      cwd: project,
      disabledPluginNames: new Set(),
    });
    expect(job).toMatchObject({
      prompt: "Review without writing.",
      cwd: project,
      templateSource: {
        installKey: "review@local",
        templateId: "daily",
        revision: contribution.revision,
        pluginVersion: "2.0.0",
      },
    });
  });

  test("fails closed for a missing workspace, disabled owner, stale review, and quota", () => {
    const contribution = loadPluginAutomationTemplateContributions()[0]!;
    const base = {
      scheduler,
      installKey: contribution.installKey,
      templateId: contribution.template.id,
      expectedRevision: contribution.revision,
      disabledPluginNames: new Set<string>(),
    };
    expect(() => instantiatePluginAutomationTemplate(base)).toThrow(/current project/);
    expect(() =>
      instantiatePluginAutomationTemplate({
        ...base,
        cwd: project,
        disabledPluginNames: new Set(["review"]),
      }),
    ).toThrow(/plugin is disabled/);
    expect(() =>
      instantiatePluginAutomationTemplate({
        ...base,
        cwd: project,
        expectedRevision: "0".repeat(64),
      }),
    ).toThrow(/changed after review/);
    scheduler.create("existing", "1d", "existing");
    expect(() =>
      instantiatePluginAutomationTemplate({ ...base, cwd: project, maxJobs: 1 }),
    ).toThrow(/automation limit reached/);
  });
});
