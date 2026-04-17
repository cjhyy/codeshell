/**
 * Planner — the brain of Evidence-Driven Arena.
 *
 * Takes a natural language user request and produces a complete ArenaPlan:
 * - mode (how to collaborate)
 * - lenses (from what perspectives)
 * - sources (where to gather evidence)
 * - subject (what is being analyzed)
 * - outputShape (how to structure the result)
 *
 * Replaces the old IntentResolver + ScopeResolver pipeline with a single
 * LLM call that outputs a holistic execution plan.
 */

import { createLLMClient } from "../llm/client-factory.js";
import type { LLMConfig } from "../types.js";
import type {
  ArenaPlan,
  ArenaMode,
  ArenaLensName,
  ArenaSourceKind,
  ArenaLensRef,
  ArenaSourceSpec,
  ArenaSubject,
  ArenaOutputShape,
} from "./types.js";
import { LENS_NAMES } from "./lenses/index.js";
import { logger } from "../logging/logger.js";

/** Explicit flags the user may pass via CLI or tool args */
export interface PlannerFlags {
  mode?: ArenaMode;
  base?: string;
  head?: string;
}

const PLANNER_SYSTEM_PROMPT = `You are the planner for a multi-model collaborative analysis tool called Arena.

Given a user's natural language request, produce an execution plan. You must determine:

1. **mode** — how to collaborate:
   - "review": find issues, verify quality, give a structured verdict
   - "discussion": explore trade-offs, compare viewpoints, preserve disagreements
   - "planning": build a roadmap, identify phases, dependencies, and risks

2. **lenses** — from what analytical perspectives (can be multiple):
   - "engineering": code quality, correctness, performance, maintainability
   - "product": user value, requirements completeness, acceptance criteria, UX
   - "architecture": system boundaries, modularity, coupling, evolution paths
   - "general": broad analysis, logic, trade-offs (use as fallback)

3. **sources** — where to gather evidence (can be multiple):
   - "git": diffs, commit history, branch comparison, changed files
   - "repo": directory structure, source code files, symbol search
   - "docs": markdown/text documents, PRDs, design docs
   - "web": external information, standards, competitor analysis
   - "none": pure topic discussion, no external evidence needed

4. **subject** — what is being analyzed:
   - kind: "changes" (code changes), "files" (specific files), "docs" (documents), "topic" (abstract topic), "mixed"
   - label: human-readable description
   - targets: specific file paths, branch names, or doc names if applicable

5. **outputShape** — what to emphasize in the output

Respond ONLY with JSON, no markdown fences:
{
  "mode": "review|discussion|planning",
  "lenses": [{"name": "engineering|product|architecture|general", "weight": 1.0}],
  "sources": [{"kind": "git|repo|docs|web|none", "targets": ["optional specific targets"]}],
  "subject": {"kind": "changes|files|docs|topic|mixed", "label": "description", "targets": ["optional"]},
  "outputShape": {"overviewLabel": "e.g. What Changed / Current Scope / Problem Framing", "emphasize": ["risk", "improvement"]},
  "confidence": "high|medium|low",
  "followUpQuestion": "question if confidence is low, or null"
}`;

/**
 * Run the planner to produce an ArenaPlan from natural language.
 *
 * Priority: explicit flags > LLM plan > safe defaults.
 */
export async function planArena(
  topic: string,
  llmConfig: LLMConfig,
  flags?: PlannerFlags,
  signal?: AbortSignal,
): Promise<ArenaPlan> {
  // If mode and base are both explicit, we can skip the LLM call
  if (flags?.mode && flags?.base) {
    return buildExplicitPlan(topic, flags);
  }

  try {
    signal?.throwIfAborted();

    const client = await createLLMClient({
      ...llmConfig,
      enableStreaming: false,
      maxTokens: 1024,
    });

    const response = await client.createMessage({
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `User request: "${topic}"` }],
      maxTokens: 1024,
      signal,
    });

    const plan = parsePlanResponse(response.text, topic);

    // Explicit flags override LLM output
    if (flags?.mode) plan.mode = flags.mode;
    if (flags?.base) {
      plan.sources = [{ kind: "git", targets: [flags.base, flags.head ?? "HEAD"] }];
      plan.subject = { kind: "changes", label: `${flags.base}...${flags.head ?? "HEAD"}`, targets: [flags.base, flags.head ?? "HEAD"] };
    }

    logger.info("arena.planner", { plan });
    return plan;
  } catch (err) {
    logger.warn("arena.planner_fallback", { error: (err as Error).message });
    return buildFallbackPlan(topic, flags);
  }
}

function parsePlanResponse(text: string, topic: string): ArenaPlan {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = fenced ? fenced[1].trim() : text.match(/\{[\s\S]*\}/)?.[0] ?? text;

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      mode: validateMode(parsed.mode),
      lenses: parseLenses(parsed.lenses),
      sources: parseSources(parsed.sources),
      subject: parseSubject(parsed.subject, topic),
      outputShape: parseOutputShape(parsed.outputShape, parsed.mode),
      confidence: validateConfidence(parsed.confidence),
      followUpQuestion: parsed.followUpQuestion || undefined,
    };
  } catch {
    return buildFallbackPlan(topic);
  }
}

function buildExplicitPlan(topic: string, flags: PlannerFlags): ArenaPlan {
  return {
    mode: flags.mode!,
    lenses: [{ name: "engineering", weight: 1 }],
    sources: [
      { kind: "git", targets: [flags.base!, flags.head ?? "HEAD"] },
      { kind: "repo" },
    ],
    subject: {
      kind: "changes",
      label: `${flags.base}...${flags.head ?? "HEAD"}`,
      targets: [flags.base!, flags.head ?? "HEAD"],
    },
    outputShape: {
      overviewLabel: "What Changed",
      emphasize: ["risk", "improvement"],
    },
    confidence: "high",
  };
}

function buildFallbackPlan(topic: string, flags?: PlannerFlags): ArenaPlan {
  if (flags?.base) {
    return {
      mode: flags.mode ?? "review",
      lenses: [{ name: "engineering", weight: 1 }],
      sources: [{ kind: "git" }, { kind: "repo" }],
      subject: { kind: "changes", label: topic, targets: [flags.base, flags.head ?? "HEAD"] },
      outputShape: {
        overviewLabel: "What Changed",
        emphasize: ["risk", "improvement"],
      },
      confidence: "low",
    };
  }

  const lower = topic.toLowerCase();
  const hasDoc = /\b(prd|doc|docs|spec|rfc|design doc|requirement|proposal)\b/i.test(topic)
    || /(文档|需求|方案)/.test(topic);
  const hasRoadmap = /\b(roadmap|plan|planning|strategy|migration|refactor)\b/i.test(topic)
    || /(演进|路线图|规划|重构)/.test(topic);
  const hasFeasibility = /\b(feasibility|feasible|can we|should we|trade-?off)\b/i.test(topic)
    || /(可行|能不能|值不值得|取舍)/.test(topic);
  const hasReview = /\b(review|pr|diff|patch|change)\b/i.test(topic)
    || /(改动|评审|审查)/.test(topic);
  const hasRepo = /\b(repo|repository|codebase|module|architecture)\b/i.test(topic)
    || /(代码库|仓库|模块|架构)/.test(topic);

  if (hasRoadmap) {
    return {
      mode: "planning",
      lenses: hasDoc
        ? [{ name: "architecture", weight: 1 }, { name: "product", weight: 0.7 }]
        : [{ name: "architecture", weight: 1 }, { name: "engineering", weight: 0.8 }],
      sources: hasDoc
        ? [{ kind: "docs" }, ...(hasRepo ? [{ kind: "repo" as const }] : [])]
        : [{ kind: "repo" }, { kind: "docs" }],
      subject: { kind: hasDoc ? "mixed" : "topic", label: topic },
      outputShape: {
        overviewLabel: "Current Scope",
        emphasize: ["improvement", "risk", "question"],
      },
      confidence: "low",
    };
  }

  if (hasDoc && hasFeasibility) {
    return {
      mode: "discussion",
      lenses: [{ name: "product", weight: 1 }, { name: "engineering", weight: 0.8 }],
      sources: hasRepo ? [{ kind: "docs" }, { kind: "repo" }] : [{ kind: "docs" }],
      subject: { kind: hasRepo ? "mixed" : "docs", label: topic },
      outputShape: {
        overviewLabel: "Problem Framing",
        emphasize: ["question", "risk", "improvement"],
      },
      confidence: "low",
    };
  }

  if (hasDoc) {
    return {
      mode: hasReview ? "review" : "discussion",
      lenses: [{ name: "product", weight: 1 }, { name: "architecture", weight: 0.6 }],
      sources: hasRepo ? [{ kind: "docs" }, { kind: "repo" }] : [{ kind: "docs" }],
      subject: { kind: hasRepo ? "mixed" : "docs", label: topic },
      outputShape: {
        overviewLabel: hasReview ? "Current Scope" : "Problem Framing",
        emphasize: ["question", "improvement", "risk"],
      },
      confidence: "low",
    };
  }

  if (hasFeasibility) {
    return {
      mode: "discussion",
      lenses: hasRepo
        ? [{ name: "product", weight: 1 }, { name: "engineering", weight: 0.8 }]
        : [{ name: "general", weight: 1 }, { name: "product", weight: 0.6 }],
      sources: hasRepo ? [{ kind: "repo" }, { kind: "docs" }] : [{ kind: "none" }],
      subject: { kind: hasRepo ? "topic" : "topic", label: topic },
      outputShape: {
        overviewLabel: "Problem Framing",
        emphasize: ["question", "risk", "improvement"],
      },
      confidence: "low",
    };
  }

  if (hasReview || /\b(commit|branch|diff|patch|bug|fix|回归)\b/i.test(lower)) {
    return {
      mode: "review",
      lenses: [{ name: "engineering", weight: 1 }],
      sources: [{ kind: "git" }, { kind: "repo" }],
      subject: { kind: "changes", label: topic },
      outputShape: {
        overviewLabel: "What Changed",
        emphasize: ["risk", "improvement", "question"],
      },
      confidence: "low",
    };
  }

  return {
    mode: flags?.mode ?? "review",
    lenses: [{ name: hasRepo ? "architecture" : "general", weight: 1 }],
    sources: hasRepo ? [{ kind: "repo" }, { kind: "docs" }] : [{ kind: "none" }],
    subject: { kind: "topic", label: topic },
    outputShape: {
      overviewLabel: hasRepo ? "Current Scope" : "Problem Framing",
      emphasize: hasRepo ? ["improvement", "risk", "question"] : ["question", "risk", "improvement"],
    },
    confidence: "low",
  };
}

// ─── Validators ─────────────────────────────────────────────────

function validateMode(v: unknown): ArenaMode {
  if (v === "review" || v === "discussion" || v === "planning") return v;
  return "review";
}

function validateConfidence(v: unknown): "high" | "medium" | "low" {
  if (v === "high" || v === "medium" || v === "low") return v;
  return "medium";
}

function parseLenses(v: unknown): ArenaLensRef[] {
  if (!Array.isArray(v) || v.length === 0) {
    return [{ name: "general", weight: 1 }];
  }
  const result = v
    .filter((item: any) => LENS_NAMES.includes(item?.name))
    .map((item: any) => ({
      name: item.name as ArenaLensName,
      weight: typeof item.weight === "number" ? item.weight : 1,
    }));
  return result.length > 0 ? result : [{ name: "general" as ArenaLensName, weight: 1 }];
}

function parseSources(v: unknown): ArenaSourceSpec[] {
  if (!Array.isArray(v) || v.length === 0) {
    return [{ kind: "none" }];
  }
  const validKinds: ArenaSourceKind[] = ["git", "repo", "docs", "web", "none"];
  const result = v
    .filter((item: any) => validKinds.includes(item?.kind))
    .map((item: any) => ({
      kind: item.kind as ArenaSourceKind,
      targets: Array.isArray(item.targets) ? item.targets : undefined,
    }));
  return result.length > 0 ? result : [{ kind: "none" as ArenaSourceKind }];
}

function parseSubject(v: unknown, topic: string): ArenaSubject {
  if (!v || typeof v !== "object") {
    return { kind: "topic", label: topic };
  }
  const obj = v as any;
  const validKinds = ["changes", "files", "docs", "topic", "mixed"];
  return {
    kind: validKinds.includes(obj.kind) ? obj.kind : "topic",
    label: obj.label ?? topic,
    targets: Array.isArray(obj.targets) ? obj.targets : undefined,
  };
}

const VALID_EMPHASIZE = new Set(["strength", "improvement", "risk", "question"]);

function parseOutputShape(v: unknown, mode?: string): ArenaOutputShape {
  if (v && typeof v === "object") {
    const obj = v as any;
    return {
      overviewLabel: obj.overviewLabel ?? "Overview",
      emphasize: Array.isArray(obj.emphasize)
        ? obj.emphasize.filter((k: unknown): k is string => VALID_EMPHASIZE.has(k as string))
        : ["risk", "improvement"],
    };
  }
  // Defaults per mode
  switch (mode) {
    case "review":
      return { overviewLabel: "What Changed", emphasize: ["risk", "improvement"] };
    case "discussion":
      return { overviewLabel: "Problem Framing", emphasize: ["strength", "risk", "question"] };
    case "planning":
      return { overviewLabel: "Current Scope", emphasize: ["improvement", "risk"] };
    default:
      return { overviewLabel: "Overview", emphasize: ["risk", "improvement"] };
  }
}
