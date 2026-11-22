import { realpathSync, statSync } from "node:fs";
import { userHome } from "@cjhyy/code-shell-core";
import type { RendererConfigurationTarget } from "../../shared/renderer-configuration.js";
import { parentPort, workerData } from "node:worker_threads";
import { inspectRepo, installFromGithub } from "../../main/github-skill-service.js";
import { installSkillFromDirectory, uninstallSkill } from "../../main/skills-service.js";
import { updateSkillEntry } from "../../main/skill-update-entry.js";
import {
  rendererConfigurationCwd,
  requireRendererListedSkillPath,
} from "../../main/renderer-configuration-helpers.js";
import { claimBusinessCommit } from "./business-calls.js";
import type { SkillOperations } from "../../shared/skill-operations.js";

async function skillDestination(target: RendererConfigurationTarget | null) {
  const cwd = target ? await rendererConfigurationCwd(target) : undefined;
  const directory = realpathSync(cwd ?? userHome());
  const identity = statSync(directory, { bigint: true });
  return {
    cwd,
    claim() {
      const current = statSync(directory, { bigint: true });
      if (
        realpathSync(directory) !== directory ||
        !current.isDirectory() ||
        identity.dev !== current.dev ||
        identity.ino !== current.ino
      )
        throw new Error("Skill destination changed");
      claimBusinessCommit(workerData.permit);
    },
  };
}
type Handlers = {
  [K in keyof SkillOperations]: (
    input: SkillOperations[K]["input"],
  ) => Promise<SkillOperations[K]["result"]>;
};
const handlers = {
  "skills/inspectGithub": ({ url, existingNames }) => inspectRepo(url, existingNames),
  async "skills/installGithub"({ scope, target, ...review }) {
    const { cwd, claim } = await skillDestination(target);
    return installFromGithub({ ...review, scope, cwd }, claim);
  },
  async "skills/installLocal"({ sourceDir, name, scope, target }) {
    const { cwd, claim } = await skillDestination(target);
    return installSkillFromDirectory(sourceDir, scope, cwd, name, claim);
  },
  async "skills/uninstall"({ scope, target, skillName }) {
    const { cwd, claim } = await skillDestination(target);
    await uninstallSkill({ scope, cwd, skillName }, claim);
  },
  async "skills/update"({ target, filePath }) {
    const { claim } = await skillDestination(target);
    return updateSkillEntry(await requireRendererListedSkillPath(target, filePath), claim);
  },
} satisfies Handlers;

async function run<K extends keyof SkillOperations>(method: K, input: SkillOperations[K]["input"]) {
  if (!Object.hasOwn(handlers, method)) throw new Error("Unknown Skill operation");
  const invoke = (handlers as Handlers)[method];
  return invoke(input);
}

if (!parentPort) throw new Error("Skill operations require a Host worker");
try {
  const value = await run(workerData.method, workerData.input);
  parentPort.postMessage({ value });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
