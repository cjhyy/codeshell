import { ipcMain } from "electron";
import { mergePluginMcpServers, SettingsManager } from "@cjhyy/code-shell-core";
import { computeEffectiveDisabledLists } from "@cjhyy/code-shell-core/internal";
import { resolveNoRepoCwd } from "./agent-bridge.js";
import { McpOAuthService } from "./mcp-oauth-service.js";
import { readSettings } from "./settings-service.js";
import { installSkillFromDirectory } from "./skills-service.js";
import {
  inspectRepo,
  installFromGithub,
  type InstallFromGithubInput,
} from "./github-skill-service.js";
import { GithubSkillReviewStore } from "./github-skill-review.js";
import { probeMcpServers, type McpServerConfig } from "./mcp-probe-service.js";
import { type RendererConfigurationTarget } from "./renderer-configuration-authority.js";
import {
  rendererConfigurationCwd,
  rendererOptionalConfigurationCwd,
  rejectUnexpectedRendererKeys,
} from "./renderer-configuration-helpers.js";

export interface SkillsMcpIpcDeps {
  getMcpOAuthService: () => McpOAuthService;
}

/** GitHub/local skill installation plus MCP probe and merged-config routes. */
export function registerSkillsMcpIpc(deps: SkillsMcpIpcDeps) {
  const { getMcpOAuthService } = deps;
  const githubSkillReviews = new GithubSkillReviewStore();

  ipcMain.handle("skills:inspectGithub", async (event, url: string, existingNames?: unknown) => {
    if (typeof url !== "string" || !url || url.length > 8_192 || url.includes("\0")) {
      throw new Error("skills:inspectGithub requires url");
    }
    if (!Array.isArray(existingNames) && existingNames !== undefined) {
      throw new Error("skills:inspectGithub existingNames must be an array");
    }
    const names = existingNames ?? [];
    if (
      names.length > 4_096 ||
      names.some((name) => typeof name !== "string" || name.length > 512 || name.includes("\0"))
    ) {
      throw new Error("skills:inspectGithub existingNames are invalid");
    }
    return githubSkillReviews.issue(event.sender.id, await inspectRepo(url, names as string[]));
  });

  ipcMain.handle("skills:installFromGithub", async (event, input: unknown) => {
    if (!input || typeof input !== "object") {
      throw new Error("skills:installFromGithub requires { inspection, selected, scope }");
    }
    const i = input as Omit<InstallFromGithubInput, "cwd"> & {
      target?: RendererConfigurationTarget;
    };
    rejectUnexpectedRendererKeys(
      input as Record<string, unknown>,
      ["inspection", "selected", "scope", "target", "installName"],
      "skills:installFromGithub",
    );
    if (!i.inspection || !i.selected) throw new Error("missing inspection/selected");
    if (i.scope !== "user" && i.scope !== "project") throw new Error("invalid scope");
    if (
      i.installName !== undefined &&
      (typeof i.installName !== "string" ||
        i.installName.length > 512 ||
        i.installName.includes("\0"))
    ) {
      throw new Error("invalid skill install name");
    }
    if (i.scope === "project" && !i.target) {
      throw new Error("project skill install requires stable authority");
    }
    if (i.scope === "user" && i.target) {
      throw new Error("user skill install does not accept project authority");
    }
    const cwd = i.target ? await rendererConfigurationCwd(i.target) : undefined;
    const reviewToken = (i.inspection as { reviewToken?: unknown }).reviewToken;
    const reviewed = githubSkillReviews.consume(event.sender.id, reviewToken, i.selected);
    const { target: _target, ...installInput } = i;
    return installFromGithub({
      ...installInput,
      inspection: reviewed.inspection,
      selected: reviewed.selected,
      cwd,
    });
  });

  ipcMain.handle(
    "skills:installLocal",
    async (
      _e,
      sourceDir: string,
      scope: "user" | "project",
      target: RendererConfigurationTarget | null,
      name?: string,
    ) => {
      if (typeof sourceDir !== "string" || !sourceDir) {
        throw new Error("skills:installLocal requires sourceDir");
      }
      if (scope !== "user" && scope !== "project") throw new Error("invalid scope");
      if (scope === "project" && target === null) {
        throw new Error("project skill install requires stable authority");
      }
      if (scope === "user" && target !== null) {
        throw new Error("user skill install does not accept project authority");
      }
      const authorizedCwd = target === null ? undefined : await rendererConfigurationCwd(target);
      return installSkillFromDirectory(sourceDir, scope, authorizedCwd, name);
    },
  );

  ipcMain.handle(
    "mcp:probe",
    async (_e, raw: unknown, force?: boolean, target?: RendererConfigurationTarget | null) => {
      if (!Array.isArray(raw)) return [];
      const configs = raw.filter(
        (x): x is McpServerConfig =>
          !!x && typeof x === "object" && typeof (x as McpServerConfig).name === "string",
      );
      return probeMcpServers(configs, {
        force: Boolean(force),
        cwd: await rendererOptionalConfigurationCwd(target ?? null, resolveNoRepoCwd()),
        oauthService: getMcpOAuthService(),
      });
    },
  );

  ipcMain.handle(
    "mcp:listMerged",
    async (
      _e,
      rawBase: unknown,
      rawDisabledPlugins?: unknown,
      target?: RendererConfigurationTarget | null,
    ) => {
      const base =
        rawBase && typeof rawBase === "object" ? (rawBase as Record<string, McpServerConfig>) : {};
      const rawList = Array.isArray(rawDisabledPlugins)
        ? rawDisabledPlugins.filter((x): x is string => typeof x === "string")
        : [];
      // Fold project capabilityOverrides over the renderer's raw global list when
      // a cwd is known — the pluginDisabled flag must reflect the EFFECTIVE state
      // (能力总览 project "on" overrides global off), matching the engine's merge.
      const cwd = target == null ? undefined : await rendererConfigurationCwd(target);
      const disabledPlugins = cwd
        ? computeEffectiveDisabledLists(new SettingsManager(cwd, "full"), cwd).disabledPlugins
        : rawList;
      // Merge with ALL plugins (no disabled filter): an installed plugin's MCP
      // should be VISIBLE in the settings page even while the plugin is disabled
      // (feedback: 装了就该展示,而不是打开插件才出现). The engine's own connect
      // path still filters disabledPlugins, so a disabled plugin's server is
      // listed-but-inert; we mark it `pluginDisabled` for the UI.
      const disabledSet = new Set(disabledPlugins);
      // Plugin-MCP overrides live globally (user scope), independent of the active
      // settings scope — read them here and let the merge layer them onto plugin
      // servers so the listed env/credential reflects the EFFECTIVE connect config.
      const userSettings = ((await readSettings("user").catch(() => null)) ?? {}) as {
        mcpServerOverrides?: Record<string, McpServerConfig>;
      };
      const overrides = (userSettings.mcpServerOverrides ?? {}) as Record<string, McpServerConfig>;
      const merged = mergePluginMcpServers(base, [], overrides);
      return Object.fromEntries(
        Object.entries(merged).map(([name, cfg]) => {
          const fromSettings = Object.prototype.hasOwnProperty.call(base, name);
          const colon = name.indexOf(":");
          const owner = !fromSettings && colon > 0 ? name.slice(0, colon) : undefined;
          return [
            name,
            {
              ...cfg,
              name,
              source: fromSettings ? "settings" : "plugin",
              editable: fromSettings,
              pluginDisabled: owner !== undefined && disabledSet.has(owner),
              // Flag a plugin server that currently carries a user override so the
              // UI can badge it. (User-added servers never use the override layer.)
              hasOverride: !fromSettings && Object.prototype.hasOwnProperty.call(overrides, name),
            },
          ];
        }),
      );
    },
  );
}
