/**
 * First-run defaults seeding for the desktop app.
 *
 * On startup we copy bundled default agents into ~/.code-shell/agents and
 * register bundled marketplace sources — but only for entries the user doesn't
 * already have (idempotent, never overwrites). Users can freely edit or delete
 * the seeded files afterward; we never re-seed an entry they removed within a
 * run, only fill in what's missing on a fresh install.
 *
 * Resource paths differ dev vs packaged: packaged resources live under
 * process.resourcesPath; in dev they sit at the repo root.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  readFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { addMarketplace } from "@cjhyy/code-shell-core";

// ESM has no implicit __dirname; derive it from this module's URL. Bundled
// desktop main lives at packages/desktop/out/main, so the repo root is four
// levels up (out/main → out → desktop → packages → root).
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function userHome(): string {
  return process.env.HOME ?? homedir();
}

/** Locate a bundled resource: packaged → resourcesPath, dev → repo root. */
export function resourcePath(...parts: string[]): string {
  // Lazy require (via createRequire, the codebase idiom for CJS deps in ESM —
  // see agent-bridge.ts): importing electron at module top breaks bun-test
  // loading of the pure helpers (seedAgents) below, since electron's entry
  // isn't a real ESM module outside the Electron runtime. resourcePath only
  // ever runs in-app.
  const { app } = require("electron") as typeof import("electron");
  if (app.isPackaged) return join(process.resourcesPath, ...parts);
  // dev: __dirname is packages/desktop/out/main → repo root is ../../../..
  return resolve(__dirname, "..", "..", "..", "..", ...parts);
}

/**
 * Copy default agent .md files into <home>/.code-shell/agents, skipping any
 * that already exist. Returns the number of files newly written. Missing
 * source dir → 0 (no throw).
 */
export function seedAgents(srcDir: string, home: string): number {
  if (!existsSync(srcDir)) return 0;
  const dest = join(home, ".code-shell", "agents");
  mkdirSync(dest, { recursive: true });
  let written = 0;
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith(".md")) continue;
    const target = join(dest, f);
    if (existsSync(target)) continue; // never overwrite user's file
    copyFileSync(join(srcDir, f), target);
    written++;
  }
  return written;
}

/**
 * Register bundled marketplace sources the user doesn't already have.
 * Reads a seed JSON of { name: MarketplaceSource } and calls core's
 * addMarketplace for each. Clone failures are swallowed (best-effort; a bad
 * network on first launch must not block startup). Returns names attempted.
 */
export async function seedMarketplaces(seedFile: string, home: string): Promise<string[]> {
  if (!existsSync(seedFile)) return [];
  // Skip entries already present in the user's known_marketplaces.json.
  const knownPath = join(home, ".code-shell", "plugins", "known_marketplaces.json");
  let known: Record<string, unknown> = {};
  if (existsSync(knownPath)) {
    try {
      known = JSON.parse(readFileSync(knownPath, "utf-8"));
    } catch {
      known = {};
    }
  }
  let seed: Record<string, { source: "github"; repo: string } | { source: "git"; url: string }>;
  try {
    seed = JSON.parse(readFileSync(seedFile, "utf-8"));
  } catch {
    return [];
  }
  const attempted: string[] = [];
  for (const [name, source] of Object.entries(seed)) {
    if (known[name]) continue;
    attempted.push(name);
    try {
      await addMarketplace(name, source);
    } catch (err) {
      console.error(`seed: failed to add marketplace ${name}`, err);
    }
  }
  return attempted;
}

/** Top-level first-run seeding, called once from app.whenReady. */
export async function seedDefaults(): Promise<void> {
  const home = userHome();
  try {
    const n = seedAgents(
      resourcePath("packages", "desktop", "resources", "agents"),
      home,
    );
    if (n > 0) console.log(`seed: copied ${n} default agent(s)`);
  } catch (err) {
    console.error("seed: agents failed", err);
  }
  try {
    const names = await seedMarketplaces(
      resourcePath("packages", "desktop", "resources", "known-marketplaces-seed.json"),
      home,
    );
    if (names.length) console.log(`seed: registered marketplace(s): ${names.join(", ")}`);
  } catch (err) {
    console.error("seed: marketplaces failed", err);
  }
}
