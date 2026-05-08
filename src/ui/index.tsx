/**
 * REPL entry point — uses the custom ink engine (src/ink/) for rendering.
 *
 * Renders in normal terminal mode (not alternate screen) so the terminal's
 * native scrollback buffer provides scrolling. Content flows naturally
 * downward; the input prompt is always at the bottom.
 */
import React from "react";
import render, { type Instance } from "../ink/root.js";
import { App } from "./App.js";
import { ThemeProvider } from "./theme.js";
import type { AgentClient } from "../protocol/client.js";
import { initHistory, flushHistorySync } from "./input-history.js";
import { getOpenRouterSnapshot } from "../data/openrouter-models.js";
import { syncOpenRouterCatalog } from "../data/openrouter-sync.js";

export interface InkReplOptions {
  client: AgentClient;
  model: string;
  effort: string;
  maxTurns: number;
  cwd: string;
  maxContextTokens: number;
  sessionId?: string;
  prefill?: string;
}

export async function startInkRepl(options: InkReplOptions): Promise<void> {
  // Initialize input history with session and project context
  const sessionId = options.sessionId ?? `session-${Date.now()}`;
  initHistory(sessionId, options.cwd);

  // Background-refresh the OpenRouter catalog if the bundled snapshot is
  // older than 24h. Fire-and-forget — failures fall back to the bundled
  // snapshot silently. Disable with CODESHELL_NO_MODEL_SYNC=1.
  if (process.env.CODESHELL_NO_MODEL_SYNC !== "1") {
    const snap = getOpenRouterSnapshot();
    const ageMs = snap.fetchedAt ? Date.now() - new Date(snap.fetchedAt).getTime() : Infinity;
    if (ageMs > 24 * 60 * 60 * 1000) {
      void syncOpenRouterCatalog().catch(() => {});
    }
  }

  // Keep the event loop alive until Ink's useInput effect calls stdin.ref().
  // Without this, the process can exit before React effects fire —
  // especially after onboarding, which leaves no active handles.
  const keepAlive = setInterval(() => {}, 2_147_483_647);

  const instance: Instance = await render(
    <ThemeProvider>
      <App
        client={options.client}
        model={options.model}
        effort={options.effort}
        maxTurns={options.maxTurns}
        cwd={options.cwd}
        maxContextTokens={options.maxContextTokens}
        sessionId={options.sessionId}
        prefill={options.prefill}
      />
    </ThemeProvider>,
    {
      stdout: process.stdout,
      stdin: process.stdin,
      stderr: process.stderr,
      exitOnCtrlC: true,
      patchConsole: false,
    },
  );

  await instance.waitUntilExit();
  clearInterval(keepAlive);
  flushHistorySync();
  instance.cleanup();
  process.exit(0);
}
