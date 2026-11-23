import type { DesktopBusinessReads } from "../../shared/desktop-business-contracts.js";
import { isDesktopSessionId, type ListSessions } from "../../shared/disk-session-query.js";
import type { RendererConfigurationTarget } from "../../shared/renderer-configuration.js";
import { listMergedMcpServers } from "../mcp-config-view.js";
import { checkSkillUpdateEntry } from "../skill-update-entry.js";
import { listCapabilities } from "../capabilities-service.js";
import { resolveNoRepoCwd } from "../no-repo-cwd.js";
import { expandPluginCommand, listPluginCommands } from "../plugin-command-service.js";
import { listPlugins } from "../plugins-service.js";
import {
  rendererConfigurationCwd,
  rendererOptionalConfigurationCwd,
  requireRendererListedSkillPath,
} from "../renderer-configuration-helpers.js";
import { readSettings } from "../settings-service.js";
import { listSkills, readSkillBody } from "../skills-service.js";
import { businessArguments, scopedBusinessRead, textArgument } from "./business-read.js";
import { InvalidParams, type DesktopHostMethod } from "./server.js";

export function parseConfigurationTarget(value: unknown): RendererConfigurationTarget {
  const keys = businessArguments(value, ["noRepo", "projectId", "sessionId"]);
  if (Object.keys(keys).length === 1) {
    if (keys.noRepo === true) return { noRepo: true };
    if (typeof keys.projectId === "string") return { projectId: textArgument(keys.projectId) };
    if (isDesktopSessionId(keys.sessionId)) return { sessionId: keys.sessionId };
  }
  throw new InvalidParams("Expected a configuration target");
}
const scoped = (input: unknown) => ({
  target: parseConfigurationTarget(businessArguments(input, ["target"]).target),
});
const maybeTarget = (value: unknown) => (value === null ? null : parseConfigurationTarget(value));
const optional = (input: unknown) => ({
  target: maybeTarget(businessArguments(input, ["target"]).target),
});

type ScopedMethod = {
  [K in keyof DesktopBusinessReads]: DesktopBusinessReads[K]["params"] extends {
    target: RendererConfigurationTarget | null;
  }
    ? K
    : never;
}[keyof DesktopBusinessReads];

export function scopedConfigurationReads(
  list: ListSessions,
  worker: Pick<import("../activity-history-worker-client.js").ActivityHistoryWorker, "view">,
) {
  function register<K extends ScopedMethod>(
    name: K,
    parse: (input: unknown) => DesktopBusinessReads[K]["params"],
    read: (
      input: DesktopBusinessReads[K]["params"],
    ) => DesktopBusinessReads[K]["result"] | Promise<DesktopBusinessReads[K]["result"]>,
  ): [K, DesktopHostMethod] {
    return scopedBusinessRead(
      name,
      list,
      parse,
      ({ target }) => (target && "sessionId" in target ? target.sessionId : undefined),
      read,
    );
  }
  function listedFile(input: unknown) {
    const { target: t, filePath } = businessArguments(input, ["target", "filePath"]);
    return { target: maybeTarget(t), filePath: textArgument(filePath) };
  }
  return [
    register("agents/list", optional, (args) => worker.view("agents/list", args)),
    register("agents/body", listedFile, (args) => worker.view("agents/body", args)),
    register(
      "mcp/merged",
      (input) => {
        const {
          base,
          disabledPlugins,
          target: t,
        } = businessArguments(input, ["base", "disabledPlugins", "target"]);
        if (
          !base ||
          typeof base !== "object" ||
          Array.isArray(base) ||
          (disabledPlugins !== undefined &&
            (!Array.isArray(disabledPlugins) || disabledPlugins.some((x) => typeof x !== "string")))
        )
          throw new InvalidParams();
        return {
          base: base as Record<string, unknown>,
          disabledPlugins: disabledPlugins as string[] | undefined,
          target: maybeTarget(t),
        };
      },
      ({ base, disabledPlugins, target }) => listMergedMcpServers(base, disabledPlugins, target),
    ),
    register("settings/project", scoped, async ({ target }) =>
      readSettings("project", await rendererConfigurationCwd(target)),
    ),
    register(
      "skills/list",
      (input) => {
        const { target: t, includeDisabled } = businessArguments(input, [
          "target",
          "includeDisabled",
        ]);
        if (includeDisabled !== undefined && typeof includeDisabled !== "boolean")
          throw new InvalidParams();
        return { target: maybeTarget(t), includeDisabled };
      },
      async ({ target, includeDisabled }) =>
        listSkills(await rendererOptionalConfigurationCwd(target, resolveNoRepoCwd()), {
          includeDisabled,
        }),
    ),
    register("skills/body", listedFile, async ({ target, filePath }) =>
      readSkillBody(await requireRendererListedSkillPath(target, filePath)),
    ),
    register("skills/checkUpdate", listedFile, async ({ target, filePath }) =>
      checkSkillUpdateEntry(await requireRendererListedSkillPath(target, filePath)),
    ),
    register("plugins/list", optional, async ({ target }) =>
      listPlugins(await rendererOptionalConfigurationCwd(target, "")),
    ),
    register("plugins/commands", scoped, async ({ target }) =>
      listPluginCommands(await rendererConfigurationCwd(target)),
    ),
    register(
      "plugins/expandCommand",
      (input) => {
        const { target, name, rawArguments } = businessArguments(input, [
          "target",
          "name",
          "rawArguments",
        ]);
        if (
          typeof name !== "string" ||
          !name ||
          name.length > 512 ||
          typeof rawArguments !== "string" ||
          rawArguments.length > 512 * 1024
        )
          throw new InvalidParams();
        return { target: parseConfigurationTarget(target), name, rawArguments };
      },
      async ({ target, name, rawArguments }) =>
        expandPluginCommand(await rendererConfigurationCwd(target), name, rawArguments),
    ),
    register("capabilities/list", optional, async ({ target }) =>
      listCapabilities(await rendererOptionalConfigurationCwd(target, "")),
    ),
  ];
}
