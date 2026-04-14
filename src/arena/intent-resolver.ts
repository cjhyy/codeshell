/**
 * IntentResolver — LLM-based intent understanding for Arena.
 *
 * Replaces regex-based detectDiffTarget with structured LLM interpretation.
 * Explicit CLI flags take priority → LLM intent → low-confidence fallback.
 */

import { createLLMClient } from "../llm/client-factory.js";
import type { LLMConfig } from "../types.js";
import type { ArenaIntentSpec, ArenaMode, ArenaTargetType } from "./types.js";
import { logger } from "../logging/logger.js";

/** Explicit flags the user may pass via CLI */
export interface ExplicitFlags {
  mode?: ArenaMode;
  base?: string;
  head?: string;
}

const INTENT_SYSTEM_PROMPT = `You are an intent classifier for a multi-model code analysis tool called Arena.

Given a user's topic/request, determine:
1. The mode: "review" (code review), "discussion" (open debate), or "planning" (roadmap/design)
2. The target type:
   - "git_worktree": review current uncommitted changes
   - "git_branch_compare": compare branches (e.g. feature vs main)
   - "module_compare": compare two code modules/directories
   - "file_compare": compare specific files
   - "topic_exploration": explore a codebase topic or question
   - "architecture_review": review overall architecture/design
3. Whether git is needed
4. Any specific targets (branch names, file paths, module names)
5. Your confidence level

Respond ONLY with JSON, no markdown fences:
{
  "mode": "review|discussion|planning",
  "targetType": "git_worktree|git_branch_compare|module_compare|file_compare|topic_exploration|architecture_review",
  "targets": ["specific targets if any"],
  "baseRef": "base branch if comparing",
  "headRef": "head branch if comparing",
  "needsGit": true/false,
  "confidence": "high|medium|low",
  "followUpQuestion": "question to ask user if confidence is low, or null"
}`;

/**
 * Resolve user intent using LLM interpretation.
 *
 * Priority: explicit flags > LLM interpretation > safe defaults.
 */
export async function resolveIntent(
  topic: string,
  llmConfig: LLMConfig,
  flags?: ExplicitFlags,
): Promise<ArenaIntentSpec> {
  // If all key fields are explicit, skip LLM call
  if (flags?.mode && flags?.base) {
    return {
      mode: flags.mode,
      targetType: "git_branch_compare",
      rawTopic: topic,
      baseRef: flags.base,
      headRef: flags.head ?? "HEAD",
      needsGit: true,
      confidence: "high",
    };
  }

  try {
    const client = await createLLMClient({
      ...llmConfig,
      enableStreaming: false,
      maxTokens: 512,
    });

    const response = await client.createMessage({
      systemPrompt: INTENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `User topic: "${topic}"` }],
      maxTokens: 512,
    });

    const parsed = parseIntentResponse(response.text);

    // Explicit flags override LLM output
    if (flags?.mode) parsed.mode = flags.mode;
    if (flags?.base) {
      parsed.baseRef = flags.base;
      parsed.targetType = "git_branch_compare";
      parsed.needsGit = true;
    }
    if (flags?.head) parsed.headRef = flags.head;

    parsed.rawTopic = topic;
    return parsed;
  } catch (err) {
    logger.warn("arena.intent_resolver_fallback", { error: (err as Error).message });
    return buildFallbackIntent(topic, flags);
  }
}

function parseIntentResponse(text: string): ArenaIntentSpec {
  // Extract JSON from possible markdown fences
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = fenced ? fenced[1].trim() : text.match(/\{[\s\S]*\}/)?.[0] ?? text;

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      mode: validateMode(parsed.mode),
      targetType: validateTargetType(parsed.targetType),
      rawTopic: "",
      targets: Array.isArray(parsed.targets) ? parsed.targets : undefined,
      baseRef: parsed.baseRef || undefined,
      headRef: parsed.headRef || undefined,
      needsGit: parsed.needsGit ?? false,
      confidence: validateConfidence(parsed.confidence),
      followUpQuestion: parsed.followUpQuestion || undefined,
    };
  } catch {
    return {
      mode: "review",
      targetType: "git_worktree",
      rawTopic: "",
      needsGit: true,
      confidence: "low",
      followUpQuestion: "Could you clarify what you'd like to review?",
    };
  }
}

function buildFallbackIntent(topic: string, flags?: ExplicitFlags): ArenaIntentSpec {
  return {
    mode: flags?.mode ?? "review",
    targetType: flags?.base ? "git_branch_compare" : "git_worktree",
    rawTopic: topic,
    baseRef: flags?.base,
    headRef: flags?.head,
    needsGit: true,
    confidence: "low",
  };
}

function validateMode(v: unknown): ArenaMode {
  if (v === "review" || v === "discussion" || v === "planning") return v;
  return "review";
}

function validateTargetType(v: unknown): ArenaTargetType {
  const valid: ArenaTargetType[] = [
    "git_worktree", "git_branch_compare", "module_compare",
    "file_compare", "topic_exploration", "architecture_review",
  ];
  if (typeof v === "string" && valid.includes(v as ArenaTargetType)) return v as ArenaTargetType;
  return "git_worktree";
}

function validateConfidence(v: unknown): "high" | "medium" | "low" {
  if (v === "high" || v === "medium" || v === "low") return v;
  return "medium";
}
