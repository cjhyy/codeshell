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
  /** No automatic write to global dream is performed; approval is required. */
  promoted: false;
  /** True when this call created a new pending approval item. */
  pendingSuggested: boolean;
  originProjects: string[];
  evidenceCount: number;
  projectEvidenceSaved: boolean;
  promotionReason: string;
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
  const promotionReason = input.userDirectGlobal
    ? "user-direct global preference suggested global dream approval"
    : "candidate suggested global dream approval";

  const projectEvidence = input.projectDir
    ? saveProjectDreamCandidate({
        baseDir,
        projectDir: input.projectDir,
        candidate: input.candidate,
        nowIso,
        promotionReason,
      })
    : undefined;

  const originProjects =
    projectEvidence?.originProjects ?? (input.projectDir ? [input.projectDir] : []);
  const rejected = projectEvidence?.promotionStatus === "rejected";
  const pendingSuggested =
    !rejected &&
    savePendingGlobalSuggestion({
      baseDir,
      projectDir: input.projectDir,
      candidate: input.candidate,
      source: projectEvidence,
      originProjects,
      nowIso,
      promotionReason,
    });

  return {
    promoted: false,
    pendingSuggested,
    originProjects,
    evidenceCount: originProjects.length,
    projectEvidenceSaved: Boolean(projectEvidence),
    promotionReason,
  };
}

function saveProjectDreamCandidate(input: {
  baseDir: string;
  projectDir: string;
  candidate: ExtractedMemory;
  nowIso: string;
  promotionReason: string;
}): MemoryEntry {
  const mm = new MemoryManager({
    baseDir: input.baseDir,
    projectDir: input.projectDir,
    scope: "dream",
  });
  const existing = mm
    .loadAll()
    .find(
      (entry) =>
        entry.name === input.candidate.name &&
        (entry.origin === "auto" || entry.origin === "dream"),
    );
  const originProjects = unique([...(existing?.originProjects ?? []), input.projectDir]);
  const promotionStatus = existing?.promotionStatus === "rejected" ? "rejected" : "pending";
  const fileName = mm.save(
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
      originProjects,
      evidenceCount: originProjects.length,
      firstSeenAt: existing?.firstSeenAt ?? existing?.createdAt ?? input.nowIso,
      lastSeenAt: input.nowIso,
      promotionReason: input.promotionReason,
      promotionStatus,
    },
    { forceOrigin: existing?.origin ?? "auto" },
  );
  return mm.find(fileName)!;
}

function savePendingGlobalSuggestion(input: {
  baseDir: string;
  projectDir?: string;
  candidate: ExtractedMemory;
  source?: MemoryEntry;
  originProjects: string[];
  nowIso: string;
  promotionReason: string;
}): boolean {
  const globalDream = new MemoryManager({ baseDir: input.baseDir, scope: "dream" });
  if (globalDream.loadAll().some((entry) => entry.name === input.candidate.name)) return false;

  const pending = new MemoryManager({ baseDir: input.baseDir, scope: "pending" });
  const duplicate = pending
    .loadAll()
    .some(
      (entry) =>
        entry.name === input.candidate.name &&
        (entry.originProject ?? "") === (input.projectDir ?? ""),
    );
  if (duplicate) return false;

  pending.save(
    {
      name: input.candidate.name,
      description: input.candidate.description,
      type: input.candidate.type,
      content: input.candidate.content,
      origin: "dream",
      originProject: input.projectDir,
      originProjects: input.originProjects,
      evidenceCount: input.originProjects.length,
      firstSeenAt: input.source?.firstSeenAt ?? input.source?.createdAt ?? input.nowIso,
      lastSeenAt: input.nowIso,
      promotionReason: input.promotionReason,
      promotionStatus: "pending",
      promotionSourceId: input.source?.id,
    },
    { forceOrigin: "dream" },
  );
  return true;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
