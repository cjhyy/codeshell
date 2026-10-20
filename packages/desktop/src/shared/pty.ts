/** `pty:start` request. `sessionId` is the terminal handle, not a Session ID. */
export interface PtyStartRequest {
  sessionId: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  /** Session whose current workspace (e.g. its managed worktree) authorizes `cwd`. */
  engineSessionId?: string;
}
