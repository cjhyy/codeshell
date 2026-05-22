import React from "react";

/**
 * Placeholder renderer.
 *
 * Renderer is a "thin client" by design: it MUST NOT import any
 * codeshell source. All Engine / AgentServer logic lives in the main
 * process. The renderer will only talk to main through the
 * `window.codeShell.*` surface exposed by preload (see
 * src/preload/index.ts).
 *
 * That bridge is not wired yet — it depends on:
 *   1. The monorepo split landing (so `@cjhyy/code-shell-core` is a real
 *      package main can import without dragging Node modules into the
 *      renderer bundle).
 *   2. main.ts running `AgentServer(engine, ipcTransport)` and exposing
 *      run/cancel/approve over `ipcMain.handle`.
 *   3. preload.ts re-exposing those as named methods on
 *      `window.codeShell`.
 *
 * Until then the renderer shows this placeholder. The Electron window
 * opening at all is enough to prove the dev orchestrator (vite +
 * esbuild + electron) works end-to-end.
 */
export function App(): React.ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        gap: 12,
        padding: 24,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 22, fontWeight: 600 }}>code-shell · desktop</div>
      <div style={{ opacity: 0.6, fontSize: 13, maxWidth: 460, lineHeight: 1.6 }}>
        Renderer is a placeholder. Main process boots; IPC bridge to{" "}
        <code className="mono">window.codeShell</code> lands after the monorepo
        split.
      </div>
      <div style={{ marginTop: 16, fontSize: 12, opacity: 0.4 }}>
        <code className="mono">
          {typeof window !== "undefined" && (window as any).codeShell
            ? "✓ preload bridge detected"
            : "preload bridge: pending"}
        </code>
      </div>
    </div>
  );
}
