import { api } from "./auth.js";

export interface ManagedSkill {
  name: string;
  description: string;
  source: "project" | "user" | "plugin" | "panel-app";
  enabled: boolean;
  editable: boolean;
  removable: boolean;
  revision: string;
  origin?: { kind: "github"; url: string; ref: string; commit: string };
  disabledReason?: string;
  readOnlyReason?: string;
}
export interface SkillsSnapshot {
  skills: ManagedSkill[];
  directories: string[];
}
export interface SkillDetail {
  name: string;
  content: string;
  revision: string;
  editable: boolean;
  origin?: ManagedSkill["origin"];
}
export interface GithubPreview {
  reviewToken: string;
  expiresAt: number;
  repoUrl: string;
  commit: string;
  skills: {
    name: string;
    description: string;
    pathInRepo: string;
    dirInRepo: string;
    alreadyInstalled?: boolean;
  }[];
  warning?: string;
}
export interface SkillUpdatePreview {
  changed: boolean;
  name: string;
  currentCommit: string;
  latestCommit: string;
  reviewToken?: string;
  expiresAt?: number;
  content?: string;
  files?: { path: string; size: number; executable: boolean }[];
}
export interface SkillMutationResult {
  ok: boolean;
  message: string;
  name: string;
}

const ROOT = "/api/v1/skills";

export async function readSkills(signal?: AbortSignal): Promise<SkillsSnapshot> {
  const snapshot = await api<SkillsSnapshot>(ROOT, { signal });
  if (!snapshot || !Array.isArray(snapshot.skills) || !Array.isArray(snapshot.directories))
    throw new Error("Skills 列表读取失败，请刷新重试。");
  return snapshot;
}
export async function readManagedSkill(name: string, signal?: AbortSignal): Promise<SkillDetail> {
  const result = await api<SkillDetail>(`${ROOT}/detail?name=${encodeURIComponent(name)}`, {
    signal,
  });
  if (
    result.name !== name ||
    typeof result.content !== "string" ||
    typeof result.revision !== "string"
  )
    throw new Error("Skill 内容读取失败，请重试。");
  return result;
}
function write<T>(
  path: string,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  return api(`${ROOT}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}
export const createSkill = (name: string, content: string, signal?: AbortSignal) =>
  write<SkillMutationResult>("/local", "POST", { name, content }, signal);
export const editSkill = (name: string, content: string, revision: string, signal?: AbortSignal) =>
  write<SkillMutationResult>("/local", "PUT", { name, content, revision }, signal);
export const removeSkill = (name: string, revision: string, signal?: AbortSignal) =>
  write<SkillMutationResult>("/local", "DELETE", { name, revision }, signal);
export const previewGithubSkills = (url: string, signal?: AbortSignal) =>
  write<GithubPreview>("/github/preview", "POST", { url: url.trim() }, signal);
export const installGithubSkill = (
  reviewToken: string,
  pathInRepo: string,
  name: string,
  signal?: AbortSignal,
) =>
  write<SkillMutationResult>(
    "/github/install",
    "POST",
    { reviewToken, pathInRepo, name: name.trim() },
    signal,
  );
export const previewSkillUpdate = (name: string, revision: string, signal?: AbortSignal) =>
  write<SkillUpdatePreview>("/github/update-preview", "POST", { name, revision }, signal);
export const applySkillUpdate = (reviewToken: string, signal?: AbortSignal) =>
  write<SkillMutationResult>("/github/update", "POST", { reviewToken }, signal);

export function newSkillContent(name: string): string {
  return `---\nname: ${name || "my-skill"}\ndescription: 描述这个 Skill 适合处理什么任务\n---\n\n# 工作方式\n\n在这里写下具体步骤、输入要求和完成标准。\n`;
}
export function validSkillName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && !name.includes("..");
}
export function visibleSkills(
  skills: ManagedSkill[],
  query: string,
  scope: string,
): ManagedSkill[] {
  const needle = query.trim().toLocaleLowerCase();
  return skills.filter(
    (skill) =>
      (scope === "all" || skill.source === scope) &&
      (!needle || `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(needle)),
  );
}
