import { homedir } from "node:os";
import { discoverCodexModels } from "@cjhyy/code-shell-capability-coding/external-runtimes";
import {
  EXTERNAL_RUNTIME_FALLBACK_CONTEXT_TOKENS,
  externalRuntimeModelEntries,
  externalRuntimeModelKey,
  type ExternalRuntimeModelEntry,
} from "../shared/external-runtime-models.js";
import { probeExternalRuntimes } from "./external-runtime-availability.js";
import { dlog } from "./desktop-logger.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface ModelCache {
  entries: ExternalRuntimeModelEntry[];
  expiresAt: number;
  pending?: Promise<ExternalRuntimeModelEntry[]>;
}

interface ExternalRuntimeModelServiceOptions {
  isEnabled: () => boolean;
  probe?: typeof probeExternalRuntimes;
  discoverCodex?: typeof discoverCodexModels;
  now?: () => number;
}

/** One shared catalog cache across windows; discovery never opens an agent turn. */
export class ExternalRuntimeModelService {
  private readonly cache = new Map<string, ModelCache>();

  constructor(private readonly options: ExternalRuntimeModelServiceOptions) {}

  async list(): Promise<ExternalRuntimeModelEntry[]> {
    if (!this.options.isEnabled()) {
      this.cache.clear();
      return [];
    }

    const probed = (this.options.probe ?? probeExternalRuntimes)();
    const available = probed.filter((runtime) => runtime.path !== null);
    const codex = available.find((runtime) => runtime.kind === "codex");
    const otherEntries = externalRuntimeModelEntries(
      available.filter((runtime) => runtime.kind !== "codex").map((runtime) => runtime.kind),
    );
    if (!codex?.path) return otherEntries;

    const codexEntries = await this.codexEntries(codex.path);
    // The feature can be disabled while a discovery request is in flight.
    return this.options.isEnabled() ? [...codexEntries, ...otherEntries] : [];
  }

  private codexEntries(command: string): Promise<ExternalRuntimeModelEntry[]> {
    const now = this.options.now ?? Date.now;
    let cached = this.cache.get(command);
    if (!cached) {
      cached = { entries: externalRuntimeModelEntries(["codex"]), expiresAt: 0 };
      this.cache.set(command, cached);
    }
    if (cached.pending) return cached.pending;
    if (now() < cached.expiresAt) return Promise.resolve(cached.entries);

    const entry = cached;
    entry.pending = Promise.resolve().then(async () => {
      try {
        const models = await (this.options.discoverCodex ?? discoverCodexModels)({
          command,
          // The catalog is account-wide. Avoid inheriting a project's config
          // just because it happens to be the process's current directory.
          cwd: homedir(),
        });
        entry.entries = [...models]
          .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
          .map(({ model, displayName }) => ({
            key: externalRuntimeModelKey("codex", model),
            label: `Codex · ${displayName}`,
            provider: "codex",
            kind: "codex",
            maxContextTokens: EXTERNAL_RUNTIME_FALLBACK_CONTEXT_TOKENS,
          }));
      } catch (error) {
        // Keep the last successful response, or the bundled fallback on first
        // launch. Cache failures too so focus events cannot spawn a retry loop.
        dlog("external-runtime", "models.discovery_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      } finally {
        entry.expiresAt = now() + CACHE_TTL_MS;
        entry.pending = undefined;
      }
      return entry.entries;
    });
    return entry.pending;
  }
}
