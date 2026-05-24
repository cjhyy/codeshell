/**
 * Read-only enumeration of installed skills.
 *
 * The desktop main process imports core's `scanSkills` directly. We
 * don't go through the agent worker for this — the worker isn't
 * running between turns, and the data is purely "what's on disk".
 *
 * If core ever moves the scanner under a sub-export the desktop will
 * fail to compile, which is the right signal: the IPC payload schema
 * here mirrors core's SkillDefinition so we keep them in lockstep.
 */

import { scanSkills, type SkillDefinition } from "@cjhyy/code-shell-core";

export interface SkillSummary {
  name: string;
  description: string;
  source: "project" | "user" | "plugin";
  filePath: string;
}

export function listSkills(cwd: string): SkillSummary[] {
  let defs: SkillDefinition[];
  try {
    defs = scanSkills(cwd);
  } catch {
    return [];
  }
  return defs.map((d) => ({
    name: d.name,
    description: d.description,
    source: d.source,
    filePath: d.filePath,
  }));
}

import { promises as fs } from "node:fs";

export async function readSkillBody(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}
