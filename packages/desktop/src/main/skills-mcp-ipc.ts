import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { invalidateSkillCache } from "@cjhyy/code-shell-core";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";
import { resolveNoRepoCwd } from "./agent-bridge.js";
import { McpOAuthService } from "./mcp-oauth-service.js";
import { listMergedMcpServers } from "./mcp-config-view.js";
import type { InstallFromGithubInput } from "./github-skill-service.js";
import { GithubSkillReviewStore } from "./github-skill-review.js";
import { probeMcpServers, type McpServerConfig } from "./mcp-probe-service.js";
import { type RendererConfigurationTarget } from "./renderer-configuration-authority.js";
import {
  rendererOptionalConfigurationCwd,
  rejectUnexpectedRendererKeys,
} from "./renderer-configuration-helpers.js";

export interface SkillsMcpIpcDeps {
  host: { callBusiness: CallShellBusiness; documentSignal(event: IpcMainInvokeEvent): AbortSignal };
  getMcpOAuthService: () => McpOAuthService;
}

function skillScope(scope: unknown, target: unknown) {
  if (scope === "project" && target && typeof target === "object")
    return { scope, target: target as RendererConfigurationTarget } as const;
  if (scope === "user" && target == null) return { scope, target: null } as const;
  throw new Error("Invalid Skill scope or configuration target");
}

/** GitHub/local skill installation plus MCP probe and merged-config routes. */
export function registerSkillsMcpIpc(deps: SkillsMcpIpcDeps) {
  const { getMcpOAuthService, host } = deps;
  const githubSkillReviews = new GithubSkillReviewStore();

  ipcMain.handle("skills:inspectGithub", async (event, url: string, existingNames?: unknown) => {
    const signal = host.documentSignal(event);
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
    const inspected = await host.callBusiness(
      "skills/inspectGithub",
      { url, existingNames: names as string[] },
      signal,
    );
    return githubSkillReviews.issue(signal, inspected);
  });

  ipcMain.handle("skills:installFromGithub", async (event, input: unknown) => {
    const signal = host.documentSignal(event);
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
    const scope = skillScope(i.scope, i.target);
    const reviewToken = (i.inspection as { reviewToken?: unknown }).reviewToken;
    const reviewed = githubSkillReviews.consume(signal, reviewToken, i.selected);
    const installed = await host.callBusiness(
      "skills/installGithub",
      { ...scope, ...reviewed, installName: i.installName },
      signal,
    );
    invalidateSkillCache();
    return installed;
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
      const signal = host.documentSignal(_e);
      if (
        typeof sourceDir !== "string" ||
        !sourceDir ||
        sourceDir.length > 32768 ||
        sourceDir.includes("\0")
      ) {
        throw new Error("skills:installLocal requires sourceDir");
      }
      if (
        name !== undefined &&
        (typeof name !== "string" || name.length > 512 || name.includes("\0"))
      )
        throw new Error("Invalid Skill name");
      const installed = await host.callBusiness(
        "skills/installLocal",
        { ...skillScope(scope, target), sourceDir, name },
        signal,
      );
      invalidateSkillCache();
      return installed;
    },
  );

  ipcMain.handle(
    "skills:update",
    async (event, target: RendererConfigurationTarget | null, filePath: unknown) => {
      const signal = host.documentSignal(event);
      if (typeof filePath !== "string" || !filePath) throw new Error("Skill filePath is required");
      const result = await host.callBusiness("skills/update", { target, filePath }, signal);
      if (result.updated) invalidateSkillCache();
      return result;
    },
  );

  ipcMain.handle("skills:uninstall", async (event, input: unknown) => {
    const signal = host.documentSignal(event);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Invalid Skill removal");
    const fields = input as Record<string, unknown>;
    rejectUnexpectedRendererKeys(fields, ["scope", "target", "skillName"], "skills:uninstall");
    if (typeof fields.skillName !== "string")
      throw new Error("skills:uninstall requires skillName");
    await host.callBusiness(
      "skills/uninstall",
      { ...skillScope(fields.scope, fields.target), skillName: fields.skillName },
      signal,
    );
    invalidateSkillCache();
  });

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
      return listMergedMcpServers(rawBase, rawDisabledPlugins, target);
    },
  );
}
