import React, { useEffect, useRef } from "react";
import { Terminal, type ILink, type ILinkProvider, type IBufferLine } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { findTerminalLinks, splitPathAndLine } from "./terminalLinks";
import { useT } from "../i18n/I18nProvider";

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
  const { t } = useT();
  // Capture in a ref so the xterm-building effect (keyed on sessionId only) can
  // read the latest translator without re-running on a language switch (which
  // would tear down xterm and lose scrollback).
  const tRef = useRef(t);
  tRef.current = t;
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

    // Make file paths and URLs in shell output clickable. xterm asks us, per
    // buffer row, which ranges are links; findTerminalLinks does the matching
    // (unit-tested in terminalLinks.test.ts). Paths open in the editor relative
    // to the shell's cwd; URLs open in the OS browser.
    const offLinks = registerTerminalLinks(term, () => cwdRef.current ?? undefined);

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
        term.write(`\r\n\x1b[2m${tRef.current("panels.terminal.processExited", { code: msg.exitCode })}\x1b[0m\r\n`);
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
      offLinks.dispose();
      term.dispose();
      // Note: we intentionally do NOT ptyKill here — the shell persists across
      // panel toggles for the life of the session (killed on app quit/window
      // close). cwd is intentionally excluded from deps (see cwdRef above).
    };
  }, [sessionId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-medium text-foreground">{t("panels.terminal.title")}</span>
        <span className="truncate text-xs text-muted-foreground">{cwd ?? "~"}</span>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden p-2" />
    </div>
  );
}

/**
 * Register an xterm link provider that underlines file paths and URLs in the
 * shell output and routes clicks. Returns a disposable.
 *
 * xterm calls provideLinks(y, cb) with a 1-based row in the *active* buffer; we
 * read that row's text, run the (DOM-free, tested) matcher, and translate each
 * match's 0-based char offset into xterm's 1-based {x,y} range. A link spanning
 * wrapped rows is intentionally not stitched — the matcher sees one row at a
 * time, which keeps the common single-row case correct and cheap.
 */
function registerTerminalLinks(
  term: Terminal,
  getCwd: () => string | undefined,
): { dispose: () => void } {
  const provider: ILinkProvider = {
    provideLinks(y, callback) {
      const line: IBufferLine | undefined = term.buffer.active.getLine(y - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      const matches = findTerminalLinks(text);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }
      const links: ILink[] = matches.map((mt) => ({
        // xterm ranges are 1-based and inclusive of the end cell.
        range: {
          start: { x: mt.start + 1, y },
          end: { x: mt.start + mt.length, y },
        },
        text: mt.text,
        activate: () => {
          if (mt.kind === "url") {
            void window.codeshell.openExternal(mt.text);
          } else {
            const { path } = splitPathAndLine(mt.text);
            void window.codeshell.openPath(path, getCwd());
          }
        },
      }));
      callback(links);
    },
  };
  return term.registerLinkProvider(provider);
}

/** Map the app's light/dark theme onto xterm colors. */
function readTheme(): { background: string; foreground: string; cursor: string } {
  const dark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  return dark
    ? { background: "#09090b", foreground: "#e4e4e7", cursor: "#e4e4e7" }
    : { background: "#ffffff", foreground: "#18181b", cursor: "#18181b" };
}
