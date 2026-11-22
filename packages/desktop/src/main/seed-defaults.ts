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
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { addMarketplace } from "@cjhyy/code-shell-core/internal";

type SeedMarketplaceStatus = {
  checkedAt: string;
  attempted: string[];
  added: string[];
  skipped: string[];
  failed: Array<{ name: string; error: string }>;
};

function userHome(): string {
  return process.env.HOME ?? homedir();
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
export async function seedMarketplaces(
  seedFile: string,
  home: string,
  signal?: AbortSignal,
): Promise<string[]> {
  return seedMarketplacesWith(seedFile, home, addMarketplace, signal);
}

export async function seedMarketplacesWith(
  seedFile: string,
  home: string,
  add: typeof addMarketplace,
  signal?: AbortSignal,
): Promise<string[]> {
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
  const added: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const [name, source] of Object.entries(seed)) {
    signal?.throwIfAborted();
    if (known[name]) {
      skipped.push(name);
      continue;
    }
    attempted.push(name);
    try {
      const result = await add(name, source, signal ? () => signal.throwIfAborted() : undefined);
      signal?.throwIfAborted();
      if (result.ok) {
        added.push(name);
      } else {
        failed.push({ name, error: result.error });
        console.error(`seed: failed to add marketplace ${name}: ${result.error}`);
      }
    } catch (err) {
      signal?.throwIfAborted();
      failed.push({ name, error: err instanceof Error ? err.message : String(err) });
      console.error(`seed: failed to add marketplace ${name}`, err);
    }
  }
  writeSeedMarketplaceStatus(home, {
    checkedAt: new Date().toISOString(),
    attempted,
    added,
    skipped,
    failed,
  });
  return attempted;
}

function writeSeedMarketplaceStatus(home: string, status: SeedMarketplaceStatus): void {
  const statusPath = join(home, ".code-shell", "plugins", "seed_marketplaces_status.json");
  mkdirSync(dirname(statusPath), { recursive: true });
  writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
}

/** Top-level first-run seeding, called once from app.whenReady. */
export async function seedDefaults(
  resourcesDir: string,
  home = userHome(),
  signal?: AbortSignal,
): Promise<void> {
  try {
    const n = seedAgents(join(resourcesDir, "agents"), home);
    if (n > 0) console.log(`seed: copied ${n} default agent(s)`);
  } catch (err) {
    console.error("seed: agents failed", err);
  }
  try {
    const names = await seedMarketplaces(
      join(resourcesDir, "known-marketplaces-seed.json"),
      home,
      signal,
    );
    if (names.length) console.log(`seed: registered marketplace(s): ${names.join(", ")}`);
  } catch (err) {
    signal?.throwIfAborted();
    console.error("seed: marketplaces failed", err);
  }
}
