/** `pty:start` request. `sessionId` is the terminal handle, not a Session ID. */
export interface PtyStartRequest {
  sessionId: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  /** Session whose current workspace (e.g. its managed worktree) authorizes `cwd`. */
  engineSessionId?: string;
}

export interface TerminalCommands {
  "pty/start": {
    input: PtyStartRequest;
    result: { ok: true; pid: number } | { ok: false; detail: string };
  };
  "pty/write": { input: { sessionId: string; data: string; reply?: boolean }; result: void };
  "pty/resize": { input: { sessionId: string; cols: number; rows: number }; result: void };
  "pty/kill": { input: { sessionId: string }; result: void };
}
export interface TerminalEvents {
  "pty/data": { sessionId: string; data: string; replay?: boolean };
  "pty/remoteViewers": { sessionId: string; count: number };
  "pty/exit": { sessionId: string; exitCode: number; signal?: number };
}

export function isTerminalCommand(value: unknown): value is keyof TerminalCommands {
  return (
    value === "pty/start" || value === "pty/write" || value === "pty/resize" || value === "pty/kill"
  );
}
export interface NativeTerminalCommand {
  caller: import("./desktop-host-protocol.js").DesktopHostIdentity;
  method: keyof TerminalCommands;
  params: Record<string, unknown>;
}
