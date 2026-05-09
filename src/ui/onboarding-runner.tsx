/**
 * Standalone Ink mount for the first-run onboarding wizard.
 *
 * Renders only OnboardingPrompt, resolves with the chosen config, and
 * unmounts. Used by replCommand when no API key is configured, so
 * onboarding and the main REPL share a single (Ink-based) input stack.
 */
import React from "react";
import render, { type Instance } from "../render/root.js";
import { ThemeProvider } from "./theme.js";
import { OnboardingPrompt } from "./components/OnboardingPrompt.js";
import type { OnboardingResult } from "../cli/onboarding.js";

export async function runInkOnboarding(): Promise<OnboardingResult | null> {
  // Keep the event loop alive until Ink's useInput effect calls stdin.ref().
  const keepAlive = setInterval(() => {}, 2_147_483_647);

  return new Promise<OnboardingResult | null>((resolve) => {
    let instance: Instance;
    let settled = false;

    const finish = (result: OnboardingResult | null) => {
      if (settled) return;
      settled = true;
      clearInterval(keepAlive);
      try { instance.unmount(); } catch { /* already unmounted */ }
      try { instance.cleanup(); } catch { /* noop */ }
      resolve(result);
    };

    void render(
      <ThemeProvider>
        <OnboardingPrompt
          onComplete={(r) => finish(r)}
          onCancel={() => finish(null)}
        />
      </ThemeProvider>,
      {
        stdout: process.stdout,
        stdin: process.stdin,
        stderr: process.stderr,
        exitOnCtrlC: true,
        patchConsole: false,
      },
    ).then((inst) => {
      instance = inst;
    });
  });
}
