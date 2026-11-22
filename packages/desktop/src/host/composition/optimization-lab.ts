import { SettingsManager, codeShellHome } from "@cjhyy/code-shell-core";
import { join } from "node:path";
import { requireRendererProjectPrimary } from "../../main/renderer-project-path.js";
import { getTrust } from "../../main/trust-store.js";
import { resolveNoRepoCwd } from "../../main/no-repo-cwd.js";
import { listSkills } from "../../main/skills-service.js";
import { previewOptimizationLabEvidence } from "../../main/optimization-lab-evidence.js";
import type { LabFileOperations, LabProjectScope } from "../../shared/optimization-lab-project.js";
import { MAX_LAB_JSON_BYTES } from "../../shared/optimization-lab.js";
import { readBoundedUtf8File, writeDatasetFile } from "./optimization-lab-files.js";
import { claimBusinessCommit, type BusinessGrant, type BusinessMethods } from "./business-calls.js";

async function projectAccess(scope: LabProjectScope, grant: BusinessGrant) {
  async function current() {
    const { project, rootId, path } = await requireRendererProjectPrimary(scope.projectId);
    const trusted = await getTrust(path);
    grant.assertCurrent();
    if (
      path !== scope.cwd ||
      trusted !== "trusted" ||
      new SettingsManager(resolveNoRepoCwd(), "full").getForScope("user").featureFlags
        ?.optimization_lab !== true
    )
      throw Error("Lab requires an enabled and trusted current project");
    return { rootId, revision: project.revision };
  }
  const first = await current();
  return async () => {
    const next = await current();
    if (first.rootId !== next.rootId || first.revision !== next.revision)
      throw Error("Lab project changed during file access");
  };
}

/** Only the native adapter supplies picker paths. The Host checks its own project
 * registry and settings before releasing data or publishing a selected file. */
export const labFiles = {
  "lab/skills": async (scope, grant) => {
    const current = await projectAccess(scope, grant);
    const skills = listSkills(scope.cwd);
    await current();
    return skills;
  },
  "lab/evidence": async (input, grant) => {
    const current = await projectAccess(input, grant);
    const value = await previewOptimizationLabEvidence(input.cwd, input.runIds);
    await current();
    return value;
  },
  "lab/readPicked": async (input, grant) => {
    const current = await projectAccess(input, grant);
    const value = await readBoundedUtf8File(input.path);
    await current();
    return value;
  },
  "lab/writePicked": async (input, grant) => {
    if (typeof input.content !== "string" || Buffer.byteLength(input.content) > MAX_LAB_JSON_BYTES)
      throw Error("Invalid Lab export size");
    const current = await projectAccess(input, grant);
    await writeDatasetFile(
      input.path,
      input.content,
      join(codeShellHome(), "optimization-lab"),
      current,
      () => claimBusinessCommit(grant.permit),
    );
  },
} satisfies Pick<BusinessMethods, keyof LabFileOperations>;
