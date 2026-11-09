/** Renderer configuration-target resolution and listed skill/agent path checks shared by IPC registrars. */
import { resolve } from "node:path";
import { resolveNoRepoCwd } from "./agent-bridge.js";
import { listSkills } from "./skills-service.js";
import { listAgents } from "./agents-service.js";
import {
  resolveRendererConfigurationTarget,
  type RendererConfigurationTarget,
} from "./renderer-configuration-authority.js";

export async function rendererConfigurationCwd(
  target: RendererConfigurationTarget,
): Promise<string> {
  return (await resolveRendererConfigurationTarget(target)).cwd;
}

export async function rendererOptionalConfigurationCwd(
  target: RendererConfigurationTarget | null,
  userCwd: string,
): Promise<string> {
  return target === null ? userCwd : rendererConfigurationCwd(target);
}

export function rejectUnexpectedRendererKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(input).find((key) => !allowedSet.has(key));
  if (unexpected) throw new Error(`${label} does not accept ${unexpected}`);
}

export async function requireRendererListedSkillPath(
  target: RendererConfigurationTarget | null,
  filePath: unknown,
): Promise<string> {
  if (typeof filePath !== "string" || !filePath) throw new Error("skill filePath is required");
  const cwd = await rendererOptionalConfigurationCwd(target, resolveNoRepoCwd());
  const listed = listSkills(cwd, { includeDisabled: true }).some(
    (skill) => resolve(skill.filePath) === resolve(filePath),
  );
  if (!listed) throw new Error("skill is not available for the configuration target");
  return filePath;
}

export async function requireRendererListedAgentPath(
  target: RendererConfigurationTarget | null,
  filePath: unknown,
): Promise<string> {
  if (typeof filePath !== "string" || !filePath) throw new Error("agent filePath is required");
  const cwd = await rendererOptionalConfigurationCwd(target, "");
  const listed = listAgents(cwd).some((agent) => resolve(agent.filePath) === resolve(filePath));
  if (!listed) throw new Error("agent is not available for the configuration target");
  return filePath;
}
