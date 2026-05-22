/**
 * Tests the CODESHELL_FULLSCREEN env-var contract.
 *
 * As of 2026-05-20 the default flipped: fullscreen is now ON by default
 * because flow mode produced "duplicate content" in the terminal
 * scrollback on resize (ERASE_SCREEN can't reach rows the terminal
 * already pushed up). Opt-out via CODESHELL_FULLSCREEN=0|false|off.
 *
 * We can't just import INITIAL_FULLSCREEN_MODE because it captures
 * process.env at module-evaluation time. Instead each test mutates
 * process.env then re-imports the module via `?cachebust=` query —
 * bun's module cache keys on the full URL, so a unique query string
 * forces a fresh evaluation.
 */
import { test, expect } from "bun:test";

async function readInitial(envValue: string | undefined): Promise<boolean> {
  const prev = process.env.CODESHELL_FULLSCREEN;
  if (envValue === undefined) delete process.env.CODESHELL_FULLSCREEN;
  else process.env.CODESHELL_FULLSCREEN = envValue;
  try {
    // Cache-bust the module so parseFullscreenEnv re-reads process.env.
    const url = `../../packages/tui/src/ui/fullscreen-mode.ts?cachebust=${Math.random()}`;
    const mod = (await import(url)) as { INITIAL_FULLSCREEN_MODE: boolean };
    return mod.INITIAL_FULLSCREEN_MODE;
  } finally {
    if (prev === undefined) delete process.env.CODESHELL_FULLSCREEN;
    else process.env.CODESHELL_FULLSCREEN = prev;
  }
}

test("unset CODESHELL_FULLSCREEN defaults to fullscreen=true", async () => {
  expect(await readInitial(undefined)).toBe(true);
});

test("CODESHELL_FULLSCREEN=0 disables fullscreen", async () => {
  expect(await readInitial("0")).toBe(false);
});

test("CODESHELL_FULLSCREEN=false disables fullscreen (case-insensitive)", async () => {
  expect(await readInitial("FALSE")).toBe(false);
});

test("CODESHELL_FULLSCREEN=off disables fullscreen", async () => {
  expect(await readInitial("off")).toBe(false);
});

test("CODESHELL_FULLSCREEN=1 explicitly enables fullscreen", async () => {
  expect(await readInitial("1")).toBe(true);
});

test("CODESHELL_FULLSCREEN with whitespace is trimmed", async () => {
  expect(await readInitial("  off  ")).toBe(false);
  expect(await readInitial("  1  ")).toBe(true);
});

test("CODESHELL_FULLSCREEN with empty string defaults to fullscreen", async () => {
  // Empty string is "set but no value". Treat like other non-disable values
  // (= fullscreen) — anything that isn't an explicit opt-out keeps the new
  // default behavior, which is the friendly thing on resize.
  expect(await readInitial("")).toBe(true);
});
