/**
 * Prismo fake tools (Phase 0).
 *
 * These mirror the eventual real Prismo tools (PrismoGetProject, PrismoListArtifacts,
 * PrismoCreateRunArtifact, ...) but read from the in-memory fixture bundle.
 *
 * Three tools are exposed:
 *
 *   - `LoadPrismoContext`     — read project / messages / inputs / existing artifacts
 *   - `SaveDraftArtifact`     — write a draft artifact (PRD / flowchart / prototype)
 *   - `RunArtifactEvaluator`  — run the structured evaluator and return findings
 *
 * Bigger surface (per-table getters, checkpoint, approval) can be added in Phase 2
 * without changing the agent's contract.
 */

import type { CustomTool } from "../../../src/index.js";
import {
  FIXTURE_BUNDLE,
  FixtureRunStore,
  type DraftArtifactRecord,
} from "./fixtures.js";
import { evaluatePrismoBundle } from "./evaluator.js";

// Single shared store per process — Phase 0 only ever runs one workflow at a time.
export const runStore = new FixtureRunStore();

// ─── LoadPrismoContext ──────────────────────────────────────────────

export const loadPrismoContextTool: CustomTool = {
  definition: {
    name: "LoadPrismoContext",
    description:
      "Load the current Prismo project context (project metadata, chat messages, input sources, existing artifacts). Always call this BEFORE generating any artifact draft.",
    source: "builtin",
    permissionDefault: "allow",
    isReadOnly: true,
    isConcurrencySafe: true,
    inputSchema: {
      type: "object" as const,
      properties: {
        include: {
          type: "array",
          items: {
            type: "string",
            enum: ["project", "messages", "inputSources", "artifacts"],
          },
          description:
            "Subset of context fields to load. Default: all four. Useful when you only need a slice.",
        },
      },
    },
  },
  execute: async (args) => {
    const include = (args.include as string[] | undefined) ?? [
      "project",
      "messages",
      "inputSources",
      "artifacts",
    ];

    const payload: Record<string, unknown> = {};
    if (include.includes("project")) payload.project = FIXTURE_BUNDLE.project;
    if (include.includes("messages")) payload.messages = FIXTURE_BUNDLE.messages;
    if (include.includes("inputSources")) payload.inputSources = FIXTURE_BUNDLE.inputSources;
    if (include.includes("artifacts")) payload.artifacts = FIXTURE_BUNDLE.artifacts;

    runStore.appendEvent("tool_load_context", { include });
    return JSON.stringify(payload, null, 2);
  },
};

// ─── SaveDraftArtifact ──────────────────────────────────────────────

const VALID_KINDS = new Set(["prd", "flowchart", "prototype"]);

export const saveDraftArtifactTool: CustomTool = {
  definition: {
    name: "SaveDraftArtifact",
    description:
      "Save a draft artifact (PRD / flowchart / prototype). Drafts NEVER overwrite official Prismo artifacts — they live in run_artifacts and require user approval to apply. Returns the assigned draft id.",
    source: "builtin",
    permissionDefault: "allow",
    isReadOnly: false,
    isConcurrencySafe: false,
    inputSchema: {
      type: "object" as const,
      properties: {
        kind: {
          type: "string",
          enum: ["prd", "flowchart", "prototype"],
          description: "Artifact kind.",
        },
        title: { type: "string", description: "Human-readable title." },
        content: {
          type: "string",
          description:
            "Full artifact content. PRD = markdown; flowchart = Mermaid source; prototype = HTML.",
        },
        targetArtifactId: {
          type: "string",
          description: "If revising an existing artifact, the id of the official artifact.",
        },
        metadata: {
          type: "object",
          description: "Optional metadata (sections covered, change summary, etc.).",
        },
      },
      required: ["kind", "title", "content"],
    },
  },
  execute: async (args) => {
    const kind = args.kind as DraftArtifactRecord["kind"];
    const title = args.title as string;
    const content = args.content as string;
    const targetArtifactId = args.targetArtifactId as string | undefined;
    const metadata = (args.metadata as Record<string, unknown> | undefined) ?? {};

    if (!VALID_KINDS.has(kind)) {
      return `Error: kind must be one of ${[...VALID_KINDS].join(", ")}`;
    }
    if (!title || !content) {
      return "Error: title and content are required";
    }

    const id = `draft_${kind}_${Date.now().toString(36)}`;
    const stored = runStore.saveDraft({
      id,
      kind,
      title,
      content,
      status: "draft",
      metadata: { ...metadata, targetArtifactId: targetArtifactId ?? null },
    });

    return JSON.stringify(
      {
        ok: true,
        id: stored.id,
        kind: stored.kind,
        title: stored.title,
        bytes: stored.content.length,
      },
      null,
      2,
    );
  },
};

// ─── RunArtifactEvaluator ──────────────────────────────────────────

export const runArtifactEvaluatorTool: CustomTool = {
  definition: {
    name: "RunArtifactEvaluator",
    description:
      "Run the Prismo structured evaluator across all draft artifacts produced in this run. Returns findings grouped by PRD / flowchart / prototype / consistency. Call this AFTER all SaveDraftArtifact calls.",
    source: "builtin",
    permissionDefault: "allow",
    isReadOnly: true,
    isConcurrencySafe: true,
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  execute: async () => {
    const drafts = runStore.listDrafts();
    const result = evaluatePrismoBundle({
      project: FIXTURE_BUNDLE.project,
      drafts,
    });
    runStore.appendEvent("evaluator_completed", { passed: result.passed, score: result.score });
    return JSON.stringify(result, null, 2);
  },
};

export const prismoTools: CustomTool[] = [
  loadPrismoContextTool,
  saveDraftArtifactTool,
  runArtifactEvaluatorTool,
];
