import type { DesktopBusinessReads } from "../../shared/desktop-business-contracts.js";
import { isDesktopSessionId, type ListSessions } from "../../shared/disk-session-query.js";
import type { RendererConfigurationTarget } from "../../shared/renderer-configuration.js";
import { listMergedMcpServers } from "../mcp-config-view.js";
import { listCapabilities } from "../capabilities-service.js";
import { resolveNoRepoCwd } from "../no-repo-cwd.js";
import { listPluginCommands } from "../plugin-command-service.js";
import { listPlugins } from "../plugins-service.js";
import {
  rendererConfigurationCwd,
  rendererOptionalConfigurationCwd,
  requireRendererListedSkillPath,
} from "../renderer-configuration-helpers.js";
import { readSettings } from "../settings-service.js";
import { listSkills, readSkillBody } from "../skills-service.js";
import { HostRevokedError } from "./authority.js";
import { businessArguments, businessRead, textArgument } from "./business-read.js";
import { InvalidParams, type DesktopHostMethod } from "./server.js";

function target(value: unknown): RendererConfigurationTarget {
  const keys = businessArguments(value, ["noRepo", "projectId", "sessionId"]);
  if (Object.keys(keys).length === 1) {
    if (keys.noRepo === true) return { noRepo: true };
    if (typeof keys.projectId === "string") return { projectId: textArgument(keys.projectId) };
    if (isDesktopSessionId(keys.sessionId)) return { sessionId: keys.sessionId };
  }
  throw new InvalidParams("Expected a configuration target");
}
const scoped = (input: unknown) => ({
  target: target(businessArguments(input, ["target"]).target),
});
const maybeTarget = (value: unknown) => (value === null ? null : target(value));
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

export function scopedConfigurationReads(list: ListSessions) {
  function register<K extends ScopedMethod>(
    name: K,
    parse: (input: unknown) => DesktopBusinessReads[K]["params"],
    read: (
      input: DesktopBusinessReads[K]["params"],
    ) => DesktopBusinessReads[K]["result"] | Promise<DesktopBusinessReads[K]["result"]>,
  ): [K, DesktopHostMethod] {
    const [, method] = businessRead(name, parse, async (input, ctx) => {
      const t = input.target;
      const checkVisibility = async () => {
        if (ctx.historical && t && "sessionId" in t) {
          const id = t.sessionId;
          if (!(await list({ sessionId: id, limit: 1 })).sessions.some((s) => s.id === id))
            throw new HostRevokedError();
        }
        ctx.assertCurrent();
      };
      await checkVisibility();
      const result = await read(input);
      await checkVisibility();
      return result;
    });
    return [
      name,
      {
        ...method,
        historyRead: true,
        optionalSessionId(params) {
          const t = parse(params).target;
          return t && "sessionId" in t ? t.sessionId : undefined;
        },
      },
    ];
  }
  return [
    register("mcp/merged", input=>{
      const {base, disabledPlugins,target:t}=businessArguments(input,["base","disabledPlugins","target"]);
      if (!base || typeof base!=="object" || Array.isArray(base) || (disabledPlugins!==undefined &&
        (!Array.isArray(disabledPlugins) || disabledPlugins.some(x=>typeof x!=="string")))) throw new InvalidParams();
      return {base:base as Record<string,unknown>,disabledPlugins:disabledPlugins as string[]|undefined,target:maybeTarget(t)};
    }, ({base,disabledPlugins,target}) => listMergedMcpServers(base,disabledPlugins,target)),
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
    register(
      "skills/body",
      (input) => {
        const { target: t, filePath } = businessArguments(input, ["target", "filePath"]);
        return { target: maybeTarget(t), filePath: textArgument(filePath) };
      },
      async ({ target, filePath }) =>
        readSkillBody(await requireRendererListedSkillPath(target, filePath)),
    ),
    register("plugins/list", optional, async ({ target }) =>
      listPlugins(await rendererOptionalConfigurationCwd(target, "")),
    ),
    register("plugins/commands", scoped, async ({ target }) =>
      listPluginCommands(await rendererConfigurationCwd(target)),
    ),
    register("capabilities/list", optional, async ({ target }) =>
      listCapabilities(await rendererOptionalConfigurationCwd(target, "")),
    ),
  ];
}
