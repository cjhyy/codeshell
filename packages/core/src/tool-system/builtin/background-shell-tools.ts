/**
 * Background-shell tools — BashOutput / KillShell / ListShells.
 *
 * Companions to `Bash(run_in_background=true)` (design §5.2–5.4). They
 * operate on the {@link BackgroundShellManager} (threaded via
 * `ctx.backgroundShells`, falling back to the process-local singleton).
 *
 * All three are session-scoped: a shell started in session A is invisible
 * and unreachable from session B (the manager enforces this; we pass
 * `ctx.sessionId` so cross-session ids report a plain "unknown shell_id"
 * rather than leaking another session's processes).
 */

import type { ToolContext } from "../context.js";
import type { ToolDefinition } from "../../types.js";
import { backgroundShellManager } from "../../runtime/background-shell.js";
import type { BackgroundShellManager } from "../../runtime/background-shell.js";

function managerFor(ctx?: ToolContext): BackgroundShellManager {
  return ctx?.backgroundShells ?? backgroundShellManager;
}

// ─── BashOutput ──────────────────────────────────────────────────────

export const bashOutputToolDef: ToolDefinition = {
  name: "BashOutput",
  description:
    "Read output from a background shell started via Bash(run_in_background=true). " +
    "Returns new output since your last read (incremental by default). ANSI colors and progress bars are stripped. " +
    "Use this only for an on-demand peek at a STILL-RUNNING process — you do NOT need to poll it to wait for " +
    "completion: when the background command finishes you are automatically woken with the result, so end your " +
    "turn instead of looping Sleep + BashOutput.",
  inputSchema: {
    type: "object",
    properties: {
      shell_id: {
        type: "string",
        description: "The shell_id returned by Bash(run_in_background=true).",
      },
      mode: {
        type: "string",
        enum: ["incremental", "all"],
        description:
          "incremental (default): output since your last read. all: the full retained buffer.",
      },
    },
    required: ["shell_id"],
  },
};

export async function bashOutputTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const shellId = args.shell_id as string;
  if (!shellId) return "Error: shell_id is required";
  const mode = args.mode === "all" ? "all" : "incremental";
  const res = managerFor(ctx).readOutput(shellId, mode, ctx?.sessionId);
  if (!res.ok) return `Error: ${res.error}`;
  const body = res.text.length > 0 ? res.text : "(no new output)";
  return `${res.header}\n${body}`;
}

// ─── KillShell ───────────────────────────────────────────────────────

export const killShellToolDef: ToolDefinition = {
  name: "KillShell",
  description:
    "Terminate a background shell (and its whole process group) started via Bash(run_in_background=true).",
  inputSchema: {
    type: "object",
    properties: {
      shell_id: { type: "string", description: "The shell_id to terminate." },
    },
    required: ["shell_id"],
  },
};

export async function killShellTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const shellId = args.shell_id as string;
  if (!shellId) return "Error: shell_id is required";
  const res = await managerFor(ctx).kill(shellId, ctx?.sessionId);
  if (!res.ok) return `Error: ${res.error}`;
  if (res.alreadyExited) {
    return `Background shell ${shellId} had already exited (status=${res.status}).`;
  }
  return `Background shell ${shellId} terminated (status=${res.status}).`;
}

// ─── ListShells ──────────────────────────────────────────────────────

export const listShellsToolDef: ToolDefinition = {
  name: "ListShells",
  description:
    "List background shells for the current session, with status and detected port.",
  inputSchema: { type: "object", properties: {} },
};

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export async function listShellsTool(
  _args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const sessionId = ctx?.sessionId;
  if (!sessionId) return "No background shells (no session context).";
  const shells = managerFor(ctx).listForSession(sessionId);
  if (shells.length === 0) return "No background shells for this session.";
  const rows = shells.map((s) => {
    const portPart = s.detectedPort !== undefined ? `  port=${s.detectedPort}` : "";
    const exitPart =
      s.status === "exited"
        ? s.signal
          ? `  signal=${s.signal}`
          : `  exit=${s.exitCode ?? "?"}`
        : "";
    return `${s.shellId}  ${s.status}${portPart}${exitPart}  ${s.command}  (started ${ago(s.startedAt)})`;
  });
  return rows.join("\n");
}
