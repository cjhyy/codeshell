#!/usr/bin/env bun
/**
 * Fetch the latest model catalog from OpenRouter and write a slimmed
 * snapshot to src/data/openrouter-models.json.
 *
 * Run via `bun run scripts/sync-models.ts` or implicitly during build
 * (see package.json `prebuild` hook). Network failures keep the existing
 * snapshot and exit 0 so offline builds still succeed.
 */

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://openrouter.ai/api/v1/models";
const OUT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "data",
  "openrouter-models.json",
);

interface RawModel {
  id: string;
  name?: string;
  created?: number;
  context_length?: number;
  top_provider?: { context_length?: number; max_completion_tokens?: number };
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}

interface SlimModel {
  id: string;
  name: string;
  created: number;
  contextLength: number;
  maxOutputTokens: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  modalities: string[];
}

interface Snapshot {
  fetchedAt: string;
  source: string;
  count: number;
  models: SlimModel[];
}

function priceToPerMillion(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n * 1_000_000 : 0;
}

function slim(m: RawModel): SlimModel {
  const ctx = m.top_provider?.context_length ?? m.context_length ?? 0;
  const maxOut = m.top_provider?.max_completion_tokens ?? 0;
  return {
    id: m.id,
    name: m.name ?? m.id,
    created: m.created ?? 0,
    contextLength: ctx,
    maxOutputTokens: maxOut,
    inputPricePerMillion: priceToPerMillion(m.pricing?.prompt),
    outputPricePerMillion: priceToPerMillion(m.pricing?.completion),
    modalities: m.architecture?.input_modalities ?? [],
  };
}

async function main(): Promise<void> {
  console.log(`[sync-models] fetching ${ENDPOINT}`);
  let payload: { data?: RawModel[] };
  try {
    const res = await fetch(ENDPOINT, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    payload = (await res.json()) as { data?: RawModel[] };
  } catch (err) {
    const msg = (err as Error).message;
    if (existsSync(OUT_PATH)) {
      console.warn(`[sync-models] fetch failed (${msg}); keeping existing snapshot.`);
      return;
    }
    console.error(`[sync-models] fetch failed and no existing snapshot — writing empty stub.`);
    writeStub(msg);
    return;
  }

  const raw = payload.data ?? [];
  const models = raw.map(slim).sort((a, b) => b.created - a.created);

  const snapshot: Snapshot = {
    fetchedAt: new Date().toISOString(),
    source: ENDPOINT,
    count: models.length,
    models,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
  console.log(`[sync-models] wrote ${models.length} models → ${OUT_PATH}`);
}

function writeStub(reason: string): void {
  const stub: Snapshot = {
    fetchedAt: new Date().toISOString(),
    source: ENDPOINT,
    count: 0,
    models: [],
  };
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(
    OUT_PATH,
    JSON.stringify({ ...stub, _note: `empty stub: ${reason}` }, null, 2) + "\n",
    "utf-8",
  );
}

main().catch((err) => {
  console.error(`[sync-models] unexpected error:`, err);
  process.exit(0); // never block build
});
