import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface Props {
  /** Working directory for the shell. */
  cwd: string | null;
  /** Stable id so the pty survives panel re-mounts within a session. */
  sessionId: string;
}

/**
 * Interactive shell, modeled on Codex: xterm.js in the renderer driven by a
 * node-pty in main over IPC. term.onData → pty:write; pty:data → term.write;
 * a ResizeObserver keeps the pty's cols/rows in sync via FitAddon.
 */
export function TerminalPanel({ cwd, sessionId: baseId }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Window-unique session id: two windows on the same repo must not share (and
  // thereby hijack) one pty. windowToken is this renderer process's pid.
  const sessionId = `${baseId}@${window.codeshell.windowToken}`;
  // Capture cwd once for the initial spawn; later cwd changes must NOT rebuild
  // the terminal (that would destroy xterm while the pty keeps running, losing
  // all scrollback). The session id already changes when the repo changes.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontSize: 13,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", "Roboto Mono", monospace',
      theme: readTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    // Renderer → shell.
    const offInput = term.onData((data) => {
      void window.codeshell.ptyWrite(sessionId, data);
    });

    // Shell → renderer (filter to our session — channels are shared).
    const offData = window.codeshell.onPtyData((msg) => {
      if (msg.sessionId === sessionId) term.write(msg.data);
    });
    const offExit = window.codeshell.onPtyExit((msg) => {
      if (msg.sessionId === sessionId) {
        term.write(`\r\n\x1b[2m[进程已退出 (code ${msg.exitCode})]\x1b[0m\r\n`);
      }
    });

    // Start the pty, then push the real viewport size once we know it.
    void window.codeshell
      .ptyStart({ sessionId, cwd: cwdRef.current ?? undefined, cols: term.cols, rows: term.rows })
      .then(() => {
        if (!disposed) void window.codeshell.ptyResize(sessionId, term.cols, term.rows);
      });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        void window.codeshell.ptyResize(sessionId, term.cols, term.rows);
      } catch {
        /* host detached mid-resize */
      }
    });
    ro.observe(host);

    term.focus();

    return () => {
      disposed = true;
      ro.disconnect();
      offInput.dispose();
      offData();
      offExit();
      term.dispose();
      // Note: we intentionally do NOT ptyKill here — the shell persists across
      // panel toggles for the life of the session (killed on app quit/window
      // close). cwd is intentionally excluded from deps (see cwdRef above).
    };
  }, [sessionId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-medium text-foreground">终端</span>
        <span className="truncate text-xs text-muted-foreground">{cwd ?? "~"}</span>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden p-2" />
    </div>
  );
}

/** Map the app's light/dark theme onto xterm colors. */
function readTheme(): { background: string; foreground: string; cursor: string } {
  const dark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  return dark
    ? { background: "#09090b", foreground: "#e4e4e7", cursor: "#e4e4e7" }
    : { background: "#ffffff", foreground: "#18181b", cursor: "#18181b" };
}
