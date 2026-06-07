/**
 * Pure mapping from a UI approve choice to the engine's ApprovalResult shape,
 * plus the per-tool menu of approve options. DOM-free so the once/session/
 * project × file/dir/tool semantics are unit-testable without rendering.
 *
 * The core InteractiveApprovalBackend reads `always` + `scope` (+ `pathScope`
 * for file tools):
 *   - once    → one-shot (no rule remembered)
 *   - session → remembered in-memory for the session
 *   - project → persisted to <cwd>/.code-shell/settings.local.json
 *   - pathScope (Write/Edit only): file = this file, dir = its directory tree,
 *     tool = every path (legacy tool-wide). Omitted → tool.
 *
 * "once" carries NEITHER always NOR scope so it's byte-for-byte the legacy
 * payload — the default path stays a no-op regression-wise.
 */

export type ApproveChoice = "once" | "session" | "project";
export type ApprovalScope = "once" | "session" | "project";
export type ApprovePathScope = "file" | "dir" | "tool";

/** File tools whose grants can be narrowed to a path (mirror of core's set). */
const PATH_SCOPED_TOOLS = new Set(["Write", "Edit"]);

/** The approve branch of the engine's ApprovalResult (renderer-side mirror). */
export interface ApproveDecision {
  approved: true;
  always?: boolean;
  scope?: ApprovalScope;
  pathScope?: ApprovePathScope;
}

/** Map a scope choice (+ optional path scope) to the decision payload. */
export function decisionFromChoice(
  choice: ApproveChoice,
  pathScope?: ApprovePathScope,
): ApproveDecision {
  if (choice === "once") return { approved: true };
  const base: ApproveDecision = { approved: true, always: true, scope: choice };
  // pathScope only meaningful on a remembered (session/project) grant; "tool"
  // is the default so we omit it to keep the payload minimal.
  if (pathScope && pathScope !== "tool") base.pathScope = pathScope;
  return base;
}

/** One row in the approve menu. */
export interface ApproveOption {
  scope: ApproveChoice;
  pathScope?: ApprovePathScope;
  label: string;
  hint?: string;
}

/** Last path segment for a compact label (basename, no dir). */
function baseName(p: string): string {
  const seg = p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  return seg;
}
function dirName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  parts.pop();
  return parts.length ? parts[parts.length - 1]! + "/" : "/";
}

/**
 * The approve options for a tool, in menu order. Non-file tools (or a file tool
 * with no path) get the plain once/session/project. File tools (Write/Edit)
 * expand the session/project rows into file/dir/tool path scopes so the user
 * can narrow the grant ("this file" / "this dir" / "all paths").
 */
export function approveOptionsFor(toolName: string, filePath?: string): ApproveOption[] {
  const once: ApproveOption = { scope: "once", label: "仅本次" };

  if (!PATH_SCOPED_TOOLS.has(toolName) || !filePath) {
    return [
      once,
      { scope: "session", label: "本会话一直允许" },
      {
        scope: "project",
        label: "本项目一直允许",
        hint: "写入 .code-shell/settings.local.json",
      },
    ];
  }

  const base = baseName(filePath);
  const dir = dirName(filePath);
  const rows: ApproveOption[] = [once];
  for (const [scope, word] of [
    ["session", "本会话"],
    ["project", "本项目"],
  ] as const) {
    rows.push({ scope, pathScope: "file", label: `${word}允许写 ${base}` });
    rows.push({ scope, pathScope: "dir", label: `${word}允许写 ${dir} 下`, });
    rows.push({
      scope,
      pathScope: "tool",
      label: `${word}允许 ${toolName}（所有路径）`,
      hint: scope === "project" ? "写入 settings.local.json" : undefined,
    });
  }
  return rows;
}
