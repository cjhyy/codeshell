# model-catalog

**One-line role.** Declarative provider/model templates (built-in + user-supplied) and the resolver that turns a stored connection instance + credential into the concrete runtime shape (adapter, baseUrl, key, model, params) every text/image/video capability runs on.

## 职责 / Responsibility

This module owns the *catalog* — the answer to "能配哪些模型" (which providers/models can be configured). A `CatalogEntry` is a template; the user picks one in the 连接 page to create a configured *instance* (stored in settings as `modelConnections[]`), and supplies the key as an independent `credential`. The two are decoupled: catalog = templates, instances = "配了哪些". The module merges the shipped built-in catalog with a user JSON file, looks entries up by id, and resolves an instance+credential+catalog triple into a `ResolvedInstance` that text/image/video all share (only `adapterKind` differs). It does **not** call any provider, store keys, or render UI — it is pure data assembly and projection.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `index.ts` | Main entry. Catalog assembly: `getMergedCatalog`, `loadUserCatalog`, `userCatalogPath`, `findCatalogEntry`; re-exports `BUILTIN_CATALOG` and `CatalogEntry`. |
| `types.ts` | Zod schemas + inferred types: `catalogEntrySchema`/`CatalogEntry`, `paramSpecSchema`/`ParamSpec`, `modelPresetSchema`/`ModelPreset`, `wireSpecSchema`, `userCatalogFileSchema`. |
| `builtin.ts` | `BUILTIN_CATALOG` — the array of templates shipped with the app (source A). |
| `resolve.ts` | `resolveInstance` + `ModelInstance`/`Credential`/`ResolvedInstance` types. The single resolver chat/image/video go through. |
| `gen-connections.ts` | `genInstancesFromConnections` — bridges image/video `modelConnections` into the `GenRuntimeInstance` shape the GenerateImage/GenerateVideo resolvers consume. |
| `params.ts` | `applyParams` (param values → request-body fields via `wire.field`, dotted paths nest) and `buildParamsDoc` (param specs → natural-language note for the tool description). |
| `save-entry.ts` | `saveCatalogEntry` — backup + validate + upsert-write one entry into a user catalog file. Wrapped by the `EditModelCatalog` tool. |
| `upsert.ts` | `upsertCatalogEntry` — pure add-or-update by `id` in a catalog array. |
| `*.test.ts` | Co-located unit tests for each of the above. |

## 公开接口 / Public API

Re-exported from the package root (`@…/core`) via `src/index.ts`:

```ts
const BUILTIN_CATALOG: CatalogEntry[];          // source A, shipped
function userCatalogPath(): string;             // ~/.code-shell/model-catalog.user.json
function loadUserCatalog(): CatalogEntry[];      // source B; [] on missing/invalid (never throws)
function getMergedCatalog(): CatalogEntry[];     // A ∪ B, deduped by id, user wins
function findCatalogEntry(
  catalog: CatalogEntry[],
  id: string | undefined,
  kindFallback?: string,                         // match by adapterKind when id misses
  tagFallback?: CatalogEntry["tag"],             // disambiguate the fallback by group
): CatalogEntry | undefined;
type CatalogEntry;                               // see types.ts
```

Internal (imported by sibling core modules via deep paths, not re-exported at root):

```ts
// resolve.ts
interface ModelInstance { id; catalogId; tag: "text"|"image"|"video"; model; baseUrl?; credentialId?; paramValues?; }
interface Credential { id; catalogId; apiKey?; baseUrl?; }
interface ResolvedInstance { entry; adapterKind; baseUrl; apiKey?; preset?; model; paramValues; }
function resolveInstance(inst: ModelInstance, credentials: Credential[], catalog: CatalogEntry[]): ResolvedInstance | null;

// gen-connections.ts
function genInstancesFromConnections(connections: ModelInstance[], credentials: Credential[], catalog: CatalogEntry[], tag: "image"|"video"): GenRuntimeInstance[];

// params.ts
function applyParams(values: Record<string, unknown>, params: ParamSpec[]): Record<string, unknown>;
function buildParamsDoc(params: ParamSpec[] | undefined): string;

// save-entry.ts / upsert.ts
function saveCatalogEntry(entry: unknown, opts: { path: string; stamp: string }): SaveCatalogResult;
function upsertCatalogEntry(existing: CatalogEntry[], entry: CatalogEntry): CatalogEntry[];
```

## 怎么用 / How to use

**1. Resolve text connections into a ModelPool (from `engine/model-connections-pool.ts`).** Build the merged catalog once, then resolve each stored instance against the credential list:

```ts
import { getMergedCatalog } from "../model-catalog/index.js";
import { resolveInstance, type ModelInstance, type Credential } from "../model-catalog/resolve.js";

const catalog = getMergedCatalog();
for (const inst of connections) {           // settings.modelConnections[]
  if (inst.tag !== "text") continue;
  const resolved = resolveInstance(inst, credentials, catalog);
  if (!resolved) continue;                  // catalogId no longer resolves → skip
  // resolved.adapterKind / .baseUrl / .apiKey / .preset / .model / .paramValues
}
```

**2. Bridge image/video connections into the generation runtime (from `tool-system/builtin/generate-image.ts`).** `genInstancesFromConnections` filters by tag and dereferences credentials in one call; `findCatalogEntry` looks an instance's template up (with an `adapterKind` fallback) so the tool description can expose its `paramsDoc`:

```ts
import { getMergedCatalog, findCatalogEntry } from "../../model-catalog/index.js";
import { genInstancesFromConnections } from "../../model-catalog/gen-connections.js";

const catalog = getMergedCatalog();
const list = genInstancesFromConnections(connections, credentials, catalog, "image");
const entry = findCatalogEntry(catalog, picked.catalogId, picked.kind /* adapterKind fallback */);
// entry?.paramsDoc → woven into the dynamic GenerateImage tool description
```

**3. Agent-driven catalog edit (from the `EditModelCatalog` tool).** Validate + back up + write one template into the user file; the caller supplies a unique `stamp` (core forbids `Date.now()` in some paths):

```ts
import { userCatalogPath } from "../../model-catalog/index.js";
import { saveCatalogEntry } from "../../model-catalog/save-entry.js";

const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
const r = saveCatalogEntry(entry, { path: userCatalogPath(), stamp });
if (!r.ok) return `Error: ${r.error}`;       // r.action: "added" | "updated"; r.backup: backup path
```

## 注意 / Gotchas

- **Catalog ≠ instances.** This module never stores keys or which models are configured. Instances live in `settings.modelConnections[]` and keys in `settings.credentials[]` (referenced by `credentialId` / `apiKeyRef`). `saveCatalogEntry` deliberately refuses to touch keys.
- **User file is best-effort, never fatal.** `loadUserCatalog` returns `[]` (and logs `model_catalog_user_invalid`/`model_catalog_user_read_failed`) on a missing, malformed, or schema-invalid file — a bad user file must never break `BUILTIN_CATALOG`.
- **Merge precedence: user wins.** `getMergedCatalog` dedupes by `id` with source B (user) overriding A (built-in), so an app upgrade can't clobber the user's overrides. Same `id` = same template.
- **`baseUrl` precedence in `resolveInstance`:** connection override → credential → catalog `defaultBaseUrl`. `resolveInstance` returns `null` when `catalogId` resolves to no entry — callers must skip, not throw (both `modelEntriesFromConnections` and `genInstancesFromConnections` do `if (!resolved) continue`).
- **`adapterKind` is just a selector string** ("openai" | "anthropic" | "google" | "fal") reusing the existing runtime adapter switches — adding a catalog template does not wire a new adapter. `shape` is documentation/future only; runtime dispatches on `adapterKind`.
- **Per-param divergence lives in data, not `if` branches.** `wire.field` decides where a param lands (e.g. reasoning → `reasoning_effort` on OpenAI vs `thinking.budget_tokens` on Anthropic); `applyParams` supports dotted paths that nest. Params are declared per-entry-per-model on `modelPreset.params`.
- **`saveCatalogEntry` needs a caller-supplied `stamp`** for the `.bak-<stamp>` backup filename — do not assume it generates one. Backup failure is swallowed (best-effort); a corrupt existing file is backed up then started fresh.
- **Must rebuild core** for changes here to reach the desktop/TUI hosts that import the compiled `dist`.
