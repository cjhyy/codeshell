/**
 * Built-in memory tools — let the LLM list / read / save / delete persistent
 * memory entries via schema-validated tool calls (no JSON-in-text parsing).
 *
 * Two scopes are exposed:
 *   - "user"   Entries the user owns. Save / Delete here is permission-gated
 *              (permissionDefault: "ask" set in the registry) so the user
 *              confirms each modification. Reading is always free.
 *   - "dream"  The auto-consolidation workspace. Save / Delete go through
 *              with no prompt — this is the LLM's scratch area for the
 *              auto-dream pipeline (and also reachable in normal sessions
 *              when the user asks to clean it up).
 *
 * Delete is SOFT — files are moved to <baseDir>/memory-trash/<ISO>/<scope>/
 * by MemoryManager, so accidental deletions are recoverable by hand.
 */

import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import { MemoryManager, type MemoryScope } from "../../session/memory.js";

const VALID_SCOPES: readonly MemoryScope[] = ["user", "dream"] as const;
const VALID_TYPES = ["user", "feedback", "project", "reference"] as const;

function parseScope(raw: unknown): MemoryScope | string {
  if (typeof raw !== "string") return "Error: scope is required (\"user\" or \"dream\")";
  if (!VALID_SCOPES.includes(raw as MemoryScope)) {
    return `Error: scope must be "user" or "dream", got "${raw}"`;
  }
  return raw as MemoryScope;
}

function mmFor(ctx: ToolContext | undefined, scope: MemoryScope): MemoryManager {
  return new MemoryManager({ projectDir: ctx?.cwd, scope });
}

// ─── MemoryList ────────────────────────────────────────────────────────────

export const memoryListToolDef: ToolDefinition = {
  name: "MemoryList",
  description:
    "List persistent memory entries from one scope. " +
    "Returns each entry's name, type, and short description (not the full content — use MemoryRead for that). " +
    "Use this before MemorySave/MemoryDelete to find the exact name to target. " +
    'Scopes: "user" (entries the user owns; you need permission to modify) or "dream" (auto-consolidation workspace; you may freely modify).',
  inputSchema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["user", "dream"],
        description: "Which scope to list",
      },
    },
    required: ["scope"],
  },
};

export async function memoryListTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const scope = parseScope(args.scope);
  if (typeof scope !== "string" || !VALID_SCOPES.includes(scope as MemoryScope)) {
    return scope as string;
  }
  try {
    const mm = mmFor(ctx, scope as MemoryScope);
    const entries = mm.loadAll();
    if (entries.length === 0) return `(no memories in scope "${scope}")`;
    return entries
      .map((e) => `- [${e.type}] ${e.name} — ${e.description}`)
      .join("\n");
  } catch (err) {
    return `Error listing memories: ${(err as Error).message}`;
  }
}

// ─── MemoryRead ────────────────────────────────────────────────────────────

export const memoryReadToolDef: ToolDefinition = {
  name: "MemoryRead",
  description:
    "Read the full content of a single memory entry by name. " +
    "Use MemoryList first to find the exact name.",
  inputSchema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["user", "dream"],
        description: "Which scope to read from",
      },
      name: {
        type: "string",
        description: "The memory entry's name (from MemoryList output)",
      },
    },
    required: ["scope", "name"],
  },
};

export async function memoryReadTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const scope = parseScope(args.scope);
  if (typeof scope !== "string" || !VALID_SCOPES.includes(scope as MemoryScope)) {
    return scope as string;
  }
  const name = args.name;
  if (typeof name !== "string" || !name) return "Error: name is required";

  try {
    const mm = mmFor(ctx, scope as MemoryScope);
    const entries = mm.loadAll();
    const entry = entries.find((e) => e.name === name || e.fileName === name);
    if (!entry) return `Error: no memory named "${name}" in scope "${scope}"`;
    return (
      `name: ${entry.name}\n` +
      `description: ${entry.description}\n` +
      `type: ${entry.type}\n` +
      `\n${entry.content}`
    );
  } catch (err) {
    return `Error reading memory: ${(err as Error).message}`;
  }
}

// ─── MemorySave ────────────────────────────────────────────────────────────

export const memorySaveToolDef: ToolDefinition = {
  name: "MemorySave",
  description:
    "Create or overwrite a memory entry. Same name → overwrite. " +
    'Saving to scope "user" requires user permission (you will see a confirmation prompt). ' +
    'Saving to scope "dream" is automatic — it is your auto-consolidation workspace. ' +
    "Pick `type` carefully: " +
    "user (info about the user), " +
    "feedback (how to approach work), " +
    "project (non-obvious facts about ongoing work), " +
    "reference (pointers to external resources). " +
    "The `description` is a one-line summary shown in the index; the `content` is the full body.",
  inputSchema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["user", "dream"],
        description: "Which scope to save to",
      },
      name: {
        type: "string",
        description: "Short kebab-case identifier (also becomes the filename slug)",
      },
      description: {
        type: "string",
        description: "One-line summary (used in the memory index)",
      },
      type: {
        type: "string",
        enum: ["user", "feedback", "project", "reference"],
        description: "Memory category",
      },
      content: {
        type: "string",
        description: "Full memory body in markdown",
      },
    },
    required: ["scope", "name", "description", "type", "content"],
  },
};

export async function memorySaveTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const scope = parseScope(args.scope);
  if (typeof scope !== "string" || !VALID_SCOPES.includes(scope as MemoryScope)) {
    return scope as string;
  }
  const name = args.name;
  const description = args.description;
  const type = args.type;
  const content = args.content;
  if (typeof name !== "string" || !name) return "Error: name is required";
  if (typeof description !== "string") return "Error: description is required";
  if (typeof content !== "string") return "Error: content is required";
  if (typeof type !== "string" || !VALID_TYPES.includes(type as (typeof VALID_TYPES)[number])) {
    return `Error: type must be one of ${VALID_TYPES.join(", ")}`;
  }

  try {
    const mm = mmFor(ctx, scope as MemoryScope);
    const fileName = mm.save({
      name,
      description,
      type: type as (typeof VALID_TYPES)[number],
      content,
    });
    return `Saved memory "${name}" → ${scope}/${fileName}`;
  } catch (err) {
    return `Error saving memory: ${(err as Error).message}`;
  }
}

// ─── MemoryDelete ──────────────────────────────────────────────────────────

export const memoryDeleteToolDef: ToolDefinition = {
  name: "MemoryDelete",
  description:
    "Soft-delete a memory entry by name (moves it to a trash directory; recoverable). " +
    'Deleting from scope "user" requires user permission. ' +
    'Deleting from scope "dream" is automatic. ' +
    "Use MemoryList to find the exact name first.",
  inputSchema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["user", "dream"],
        description: "Which scope to delete from",
      },
      name: {
        type: "string",
        description: "The memory entry's name (from MemoryList output)",
      },
    },
    required: ["scope", "name"],
  },
};

export async function memoryDeleteTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const scope = parseScope(args.scope);
  if (typeof scope !== "string" || !VALID_SCOPES.includes(scope as MemoryScope)) {
    return scope as string;
  }
  const name = args.name;
  if (typeof name !== "string" || !name) return "Error: name is required";

  try {
    const mm = mmFor(ctx, scope as MemoryScope);
    const ok = mm.delete(name);
    return ok
      ? `Deleted memory "${name}" from scope "${scope}" (moved to memory-trash/)`
      : `Error: no memory named "${name}" in scope "${scope}"`;
  } catch (err) {
    return `Error deleting memory: ${(err as Error).message}`;
  }
}
