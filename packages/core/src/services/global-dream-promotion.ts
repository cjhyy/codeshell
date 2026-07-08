import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MemoryManager, resolveMemoryBaseDir, type MemoryEntry } from "../session/memory.js";
import type { ExtractedMemory } from "./extract-memories.js";

export interface GlobalDreamPromotionInput {
  candidate: ExtractedMemory;
  projectDir?: string;
  baseDir?: string;
  userDirectGlobal?: boolean;
  now?: Date;
}

export interface GlobalDreamPromotionResult {
  promoted: boolean;
  promotionKey: string;
  originProjects: string[];
  evidenceCount: number;
  projectEvidenceSaved: boolean;
  promotionReason: string;
}

interface PromotionEvidence {
  entry: MemoryEntry;
  projectKey: string;
  originProject: string;
}

export function promotionKeyForMemory(
  memory: Pick<ExtractedMemory, "name" | "description">,
): string {
  return slugPromotionKey(memory.name) || slugPromotionKey(memory.description) || "memory";
}

export function detectUserDirectGlobalPreference(
  transcript: Array<{ role: string; content: string }>,
): boolean {
  const userText = transcript
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n")
    .toLowerCase();

  return (
    /(?:全局记住|全局保存|所有项目|全部项目|以后所有项目|今后所有项目|以后都|以后默认|我偏好|我的偏好)/u.test(
      userText,
    ) ||
    /(?:remember globally|global memory|all projects|every project|my preference|i prefer|always remember)/i.test(
      userText,
    )
  );
}

export function applyGlobalDreamPromotionGate(
  input: GlobalDreamPromotionInput,
): GlobalDreamPromotionResult {
  const baseDir = resolveMemoryBaseDir(input.baseDir);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const promotionKey = promotionKeyForMemory(input.candidate);

  const projectEvidenceSaved = input.projectDir
    ? saveProjectDreamEvidence({
        baseDir,
        projectDir: input.projectDir,
        candidate: input.candidate,
        promotionKey,
        nowIso,
      })
    : false;

  const evidence = collectProjectDreamEvidence(baseDir, promotionKey);
  const originProjects = unique(
    evidence.flatMap(
      (item) => item.entry.originProjects ?? [item.entry.originProject ?? item.originProject],
    ),
  );
  const evidenceCount = originProjects.length;
  const promotionReason = input.userDirectGlobal
    ? "user-direct global preference"
    : `cross-project evidence across ${evidenceCount} projects`;

  const promoted =
    input.userDirectGlobal === true || (input.candidate.scope === "global" && evidenceCount >= 2);
  if (promoted) {
    saveGlobalDreamStableEntry({
      baseDir,
      candidate: input.candidate,
      promotionKey,
      originProjects,
      evidenceCount,
      promotionReason,
      nowIso,
      evidence,
    });
  }

  return {
    promoted,
    promotionKey,
    originProjects,
    evidenceCount,
    projectEvidenceSaved,
    promotionReason,
  };
}

function saveProjectDreamEvidence(input: {
  baseDir: string;
  projectDir: string;
  candidate: ExtractedMemory;
  promotionKey: string;
  nowIso: string;
}): boolean {
  const mm = new MemoryManager({
    baseDir: input.baseDir,
    projectDir: input.projectDir,
    scope: "dream",
  });
  const existing = mm
    .loadAll()
    .find(
      (entry) =>
        (entry.promotionKey ?? promotionKeyForMemory(entry)) === input.promotionKey &&
        (entry.origin === "auto" || entry.origin === "dream"),
    );
  const originProjects = unique([...(existing?.originProjects ?? []), input.projectDir]);
  mm.save(
    {
      id: existing?.id,
      name: input.candidate.name,
      description: input.candidate.description,
      type: input.candidate.type,
      content: input.candidate.content,
      origin: existing?.origin ?? "auto",
      pinned: existing?.pinned,
      createdAt: existing?.createdAt,
      useCount: existing?.useCount,
      updateCount: existing?.updateCount,
      lastUsedAt: existing?.lastUsedAt,
      originProject: input.projectDir,
      promotionKey: input.promotionKey,
      originProjects,
      evidenceCount: originProjects.length,
      firstSeenAt: existing?.firstSeenAt ?? existing?.createdAt ?? input.nowIso,
      lastSeenAt: input.nowIso,
      promotionReason: "project evidence awaiting global dream promotion",
    },
    { forceOrigin: existing?.origin ?? "auto" },
  );
  return true;
}

function saveGlobalDreamStableEntry(input: {
  baseDir: string;
  candidate: ExtractedMemory;
  promotionKey: string;
  originProjects: string[];
  evidenceCount: number;
  promotionReason: string;
  nowIso: string;
  evidence: PromotionEvidence[];
}): void {
  const globalDream = new MemoryManager({ baseDir: input.baseDir, scope: "dream" });
  const existing = globalDream
    .loadAll()
    .find(
      (entry) =>
        entry.promotionKey === input.promotionKey ||
        promotionKeyForMemory(entry) === input.promotionKey,
    );
  if (existing && existing.origin === "manual") return;

  const firstSeenAt =
    earliestIso(input.evidence.flatMap((item) => [item.entry.firstSeenAt, item.entry.createdAt])) ??
    existing?.firstSeenAt ??
    existing?.createdAt ??
    input.nowIso;
  const stableOriginProjects = unique([
    ...(existing?.originProjects ?? []),
    ...input.originProjects,
  ]);

  globalDream.save(
    {
      id: existing?.id,
      name: input.candidate.name,
      description: input.candidate.description,
      type: input.candidate.type,
      content: input.candidate.content,
      origin: existing?.origin ?? "auto",
      pinned: existing?.pinned,
      createdAt: existing?.createdAt,
      useCount: existing?.useCount,
      updateCount: existing?.updateCount,
      lastUsedAt: existing?.lastUsedAt,
      promotionKey: input.promotionKey,
      originProjects: stableOriginProjects,
      evidenceCount: stableOriginProjects.length,
      firstSeenAt,
      lastSeenAt: input.nowIso,
      promotionReason: input.promotionReason,
    },
    { forceOrigin: existing?.origin ?? "auto" },
  );
}

function collectProjectDreamEvidence(baseDir: string, promotionKey: string): PromotionEvidence[] {
  const projectsDir = join(baseDir, "projects");
  if (!existsSync(projectsDir)) return [];
  const evidence: PromotionEvidence[] = [];
  for (const projectKey of readdirSync(projectsDir)) {
    const dreamDir = join(projectsDir, projectKey, "memory", "dream");
    if (!existsSync(dreamDir)) continue;
    const entries = new MemoryManager({
      baseDir,
      projectDir: projectKey,
      scope: "dream",
    }).loadAll();
    for (const entry of entries) {
      if ((entry.promotionKey ?? promotionKeyForMemory(entry)) !== promotionKey) continue;
      evidence.push({
        entry,
        projectKey,
        originProject: entry.originProject ?? entry.originProjects?.[0] ?? projectKey,
      });
    }
  }
  return evidence;
}

function slugPromotionKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b\d{8}\b/g, " ")
    .replace(/\bv\d+\b/g, " ")
    .replace(/\b(batch|fix-batch)-\d+\b/g, " ")
    .replace(/\b(today|yesterday|tomorrow|本轮|今天|昨天|明天)\b/gu, " ")
    .replace(/\b[a-f0-9]{7,}\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 96);
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function earliestIso(values: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = new Date(value).getTime();
    if (!Number.isFinite(ms) || ms >= bestMs) continue;
    best = value;
    bestMs = ms;
  }
  return best;
}
