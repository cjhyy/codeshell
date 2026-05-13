# ProviderModelFlow Merge — Implementation Plan

> Execution: subagent-driven-development. Tasks use `- [ ]` checkboxes.

**Goal:** Replace three near-duplicate flows (`OnboardingPrompt` for `/login`, `AddProviderWizard` for `ModelManager` `a`, `AddModelWizard` for `ModelManager` `A`) with a single shared component `ProviderModelFlow` invoked by both `/login` and ModelManager. `/login` becomes append-only (no overwrite); `/logout` remains the way to reset.

**Architecture:** Extract the shared 4-step flow (kind → key → fetch /v1/models → multi-select models → optional active) into `src/ui/components/ProviderModelFlow.tsx`. OnboardingPrompt becomes a thin wrapper adding welcome + Arena steps. ModelManager mounts it directly. Both pass `switchToNewModelOnFinish` to control whether the chosen model becomes active.

**Tech Stack:** Ink/React, TypeScript ESM (`.js` imports), existing `provider-kinds.ts` + `model-fetcher.ts` for kinds and list fetching.

**Spec reference:** Out-of-band — see conversation. Builds on `docs/superpowers/plans/2026-05-12-model-module-redesign.md`.

---

## File structure

### New
- `src/ui/components/ProviderModelFlow.tsx` — the shared 4-step Ink flow
- `tests/provider-model-flow-logic.test.ts` — unit tests for the pure helpers (append logic, alias derivation, conflict handling)

### Modified
- `src/ui/components/OnboardingPrompt.tsx` — strip provider/key/pool steps, embed ProviderModelFlow, keep Arena + completion
- `src/ui/App.tsx` — drop the two old wizard mount branches, mount ProviderModelFlow when ModelManager triggers it
- `src/ui/components/ModelManager.tsx` — `a` and `A` both call the same `onOpenFlow` callback; no separate provider/model verbs
- `src/cli/onboarding.ts` — drop the PROVIDERS hardcoded model lists (Step 3 of the new flow fetches them live); keep `detectEnvKeys`, `modelKey`, `OnboardingResult` shape

### Deleted
- `src/ui/components/AddProviderWizard.tsx`
- `src/ui/components/AddModelWizard.tsx`

---

## Component contract — ProviderModelFlow

```ts
interface ProviderModelFlowProps {
  /** Existing providers in settings, so step 1 can list them. */
  existingProviders: ProviderConfig[];
  /** Existing model entry keys for alias-uniqueness check. */
  existingModelKeys: string[];
  /** Environment-detected key candidates (from detectEnvKeys()), so step 2 can offer them. */
  detectedEnvKeys?: Array<{ envKey: string; apiKey: string; kindHint: ProviderKindName }>;
  /** When true, the user is asked to pick a default model that becomes active. */
  switchToNewModelOnFinish: boolean;
  /** Called on finish with new providers and new models to APPEND to settings. */
  onFinish: (result: {
    addedProvider?: ProviderConfig; // undefined if user reused an existing provider
    addedModels: Array<{
      key: string;
      providerKey: string;
      model: string;
      maxContextTokens?: number;
      maxOutputTokens?: number;
    }>;
    activeModelKey?: string; // only set if switchToNewModelOnFinish was true
  }) => void;
  onCancel: () => void;
}
```

The four internal steps:

1. **kind** — pick provider kind from `PROVIDER_KINDS`. If `existingProviders` has entries of the chosen kind, also offer "Use existing: <label>" rows so the user can skip to step 3.
2. **key** — input API key. If `detectedEnvKeys` has a match for this kind, offer "Use $ENVVAR" as a pre-selection. For `custom` kind, follow with a baseUrl input. For `ollama`, skip entirely.
3. **fetch+pick** — call `fetchModelList`, render list, multi-select with Space, Enter to continue. `r` re-fetches with `refresh:true`. `m` enters manual-id fallback. Empty/errored list shows a clear message and forces manual mode.
4. **alias+active** — for each picked model, derive an alias (editable). If `switchToNewModelOnFinish`, also pick which of the new aliases becomes active. Enter commits.

On finish, the parent does the actual append + persist + (maybe) active switch.

---

## Task 1 — Skeleton + pure helpers + tests

**Files:** Create `src/ui/components/ProviderModelFlow.tsx` (skeleton); create `tests/provider-model-flow-logic.test.ts`.

- [ ] **Step 1: Write the test for pure helpers**

Exported helpers tested in isolation:
- `deriveModelAlias(modelId, usedAliases) → string`
- `deriveProviderKey(kindOrCustomUrl, existingKeys) → string`
- `validateAlias(alias, usedAliases) → string | null` (null = ok; string = error message)

```ts
// tests/provider-model-flow-logic.test.ts
import { describe, it, expect } from "bun:test";
import {
  deriveModelAlias,
  deriveProviderKey,
  validateAlias,
} from "../src/ui/components/ProviderModelFlow.js";

describe("deriveModelAlias", () => {
  it("strips vendor prefix and deepseek- prefix", () => {
    expect(deriveModelAlias("deepseek/deepseek-v4-flash", [])).toBe("v4-flash");
    expect(deriveModelAlias("anthropic/claude-opus-4-6", [])).toBe("claude-opus-4-6");
    expect(deriveModelAlias("gpt-4o", [])).toBe("gpt-4o");
  });
  it("suffixes -2/-3 on collisions", () => {
    expect(deriveModelAlias("gpt-4o", ["gpt-4o"])).toBe("gpt-4o-2");
    expect(deriveModelAlias("gpt-4o", ["gpt-4o", "gpt-4o-2"])).toBe("gpt-4o-3");
  });
});

describe("deriveProviderKey", () => {
  it("returns kind name when unused", () => {
    expect(deriveProviderKey("deepseek", [])).toBe("deepseek");
  });
  it("suffixes on conflict", () => {
    expect(deriveProviderKey("deepseek", ["deepseek"])).toBe("deepseek-2");
  });
  it("derives from URL host for custom kind", () => {
    expect(deriveProviderKey("https://my.local/v1", [])).toBe("my-local");
  });
});

describe("validateAlias", () => {
  it("rejects empty", () => {
    expect(validateAlias("", [])).toBeTruthy();
  });
  it("rejects duplicates", () => {
    expect(validateAlias("foo", ["foo"])).toBeTruthy();
  });
  it("accepts new unique values", () => {
    expect(validateAlias("foo", ["bar"])).toBeNull();
  });
  it("rejects whitespace-containing", () => {
    expect(validateAlias("with space", [])).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, confirm fail** — `bun test tests/provider-model-flow-logic.test.ts`

- [ ] **Step 3: Create skeleton with helpers exported**

```tsx
// src/ui/components/ProviderModelFlow.tsx
/**
 * ProviderModelFlow — shared 4-step add-provider-and-models flow.
 *
 * Used by /login (OnboardingPrompt) and by ModelManager's a/A keys.
 * Both invocations are APPEND-ONLY. /logout is the way to clear.
 *
 * Steps: kind → key → fetch+pick → alias+(active?) → onFinish.
 */
import { useState } from "react";
import { Box, Text, useInput } from "../../render/index.js";
import type { ProviderConfig } from "../../llm/provider-catalog.js";
import { PROVIDER_KINDS, type ProviderKindName } from "../../llm/provider-kinds.js";

export interface EnvKeyHint {
  envKey: string;
  apiKey: string;
  kindHint: ProviderKindName;
}

export interface FlowResult {
  addedProvider?: ProviderConfig;
  addedModels: Array<{
    key: string;
    providerKey: string;
    model: string;
    maxContextTokens?: number;
    maxOutputTokens?: number;
  }>;
  activeModelKey?: string;
}

export interface ProviderModelFlowProps {
  existingProviders: ProviderConfig[];
  existingModelKeys: string[];
  detectedEnvKeys?: EnvKeyHint[];
  switchToNewModelOnFinish: boolean;
  onFinish: (r: FlowResult) => void;
  onCancel: () => void;
}

// ─── Pure helpers (exported for testing) ──────────────────────────

export function deriveModelAlias(modelId: string, used: string[]): string {
  let base = modelId.split("/").pop() ?? modelId;
  base = base.replace(/^deepseek-/, "");
  const set = new Set(used);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const k = `${base}-${i}`;
    if (!set.has(k)) return k;
  }
}

export function deriveProviderKey(kindOrUrl: string, used: string[]): string {
  let base = kindOrUrl;
  // Treat URL-like input (contains :// or .) as custom — derive from host
  if (/^https?:\/\//.test(kindOrUrl) || kindOrUrl.includes(".")) {
    const host = kindOrUrl.replace(/^https?:\/\//, "").split("/")[0] ?? "custom";
    base = host.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "");
  }
  const set = new Set(used);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const k = `${base}-${i}`;
    if (!set.has(k)) return k;
  }
}

export function validateAlias(alias: string, used: string[]): string | null {
  if (!alias) return "Alias cannot be empty";
  if (/\s/.test(alias)) return "Alias must not contain whitespace";
  if (used.includes(alias)) return "Alias already used";
  return null;
}

// ─── Component placeholder ────────────────────────────────────────

export function ProviderModelFlow(_props: ProviderModelFlowProps) {
  // Filled in Task 2
  return (
    <Box flexDirection="column" padding={1} borderStyle="round">
      <Text>ProviderModelFlow (skeleton)</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Run tests** — must pass 9 cases.

- [ ] **Step 5: Commit (specific files only)**
```bash
git add src/ui/components/ProviderModelFlow.tsx tests/provider-model-flow-logic.test.ts
git commit -m "feat(ui): ProviderModelFlow skeleton + pure helpers"
```

---

## Task 2 — Full ProviderModelFlow component

**Files:** Modify `src/ui/components/ProviderModelFlow.tsx`.

Read carefully:
- /Users/admin/Documents/个人学习/代码学习/codeshell/src/ui/components/AddProviderWizard.tsx (current state-machine reference for steps 1-2-3)
- /Users/admin/Documents/个人学习/代码学习/codeshell/src/ui/components/AddModelWizard.tsx (current step-4 reference)
- /Users/admin/Documents/个人学习/代码学习/codeshell/src/llm/model-fetcher.ts (FetchResult, fetchModelList signature)

The component must implement the full 4-step state machine described in the contract section above. Cover:

1. **kind step** — list `Object.keys(PROVIDER_KINDS)`, plus for each kind that has matching `existingProviders` entries, show "Use existing: <label>" rows BEFORE the kind label. `↑↓ + Enter`.

2. **key step** — skipped for ollama and for "use existing". For custom kind, baseUrl input follows key input. Use the same hidden-key rendering as AddProviderWizard. If `detectedEnvKeys` has entries for the chosen kind, the first option is "Use $ENVVAR (••••••••last4)" then "Paste new key".

3. **fetch+pick step** — call `fetchModelList`, render list, **multi-select** (Space toggles, Enter continues, must have at least 1 picked or show error). Top of pane shows cache freshness + `r` refresh + `m` manual id. If `picked.size === 0` and `Enter` pressed, show "Pick at least one or press Esc".

4. **alias+active step** — for each picked model id in order, render one input field with `deriveModelAlias` default. Tab cycles between fields. Validation via `validateAlias`. If `switchToNewModelOnFinish` is true, append one more line "Which becomes active? (↑↓)" with the new aliases. Enter finishes.

5. **finish** — build the `FlowResult` and call `onFinish`. If "use existing" was chosen at step 1, `addedProvider` is undefined.

Acceptance: file compiles, manual smoke later.

- [ ] **Step 1: Implement** (replace the placeholder body)
- [ ] **Step 2: `bun run tsc --noEmit src/ui/components/ProviderModelFlow.tsx`** — no new errors
- [ ] **Step 3: Commit**
```bash
git add src/ui/components/ProviderModelFlow.tsx
git commit -m "feat(ui): full ProviderModelFlow state machine"
```

---

## Task 3 — Wire into ModelManager (replace the two wizards)

**Files:** Modify `src/ui/App.tsx`, `src/ui/components/ModelManager.tsx`. Delete `src/ui/components/AddProviderWizard.tsx` and `src/ui/components/AddModelWizard.tsx`.

- [ ] **Step 1: Simplify ModelManager props**

In `ModelManager.tsx`:
- Replace `onAddProvider` and `onAddModel` with a single `onOpenFlow?: () => void`.
- Both `a` (providers section) and `A` (models section) call `onOpenFlow`.
- Update the help bar text.

- [ ] **Step 2: Refactor App.tsx wizard mount**

- Remove the imports of `AddProviderWizard` / `AddModelWizard`.
- Import `ProviderModelFlow` and `detectEnvKeys` (from `src/cli/onboarding.ts`).
- Replace the `wizard === "provider"` and `wizard === "model"` branches with a single branch:

```tsx
{wizard === "flow" && modelManager && (
  <ProviderModelFlow
    existingProviders={settingsProvidersAsArray}
    existingModelKeys={modelManager.entries.map((e) => e.key)}
    detectedEnvKeys={detectEnvKeys().map((d) => ({
      envKey: d.envKey,
      apiKey: d.apiKey,
      kindHint: d.provider.id as never,
    }))}
    switchToNewModelOnFinish={false}
    onFinish={async (result) => {
      // Append addedProvider (if any) and addedModels to settings, then reload
      if (result.addedProvider) {
        await client.query("provider_add", { provider: result.addedProvider } as never);
      }
      for (const m of result.addedModels) {
        await client.query("model_add", { model: m } as never);
      }
      setWizard(null);
      try { await client.configure({ reloadModels: true }); } catch {}
      await refreshModelManagerState();
    }}
    onCancel={() => setWizard(null)}
  />
)}
```

- Set `wizard` state type to `"flow" | null`.

- [ ] **Step 3: Delete the old wizards**
```bash
git rm src/ui/components/AddProviderWizard.tsx src/ui/components/AddModelWizard.tsx
```

- [ ] **Step 4: Test compile + suite**
```bash
bun run tsc --noEmit
bun test
```

- [ ] **Step 5: Commit (specific files only)**

```bash
git add src/ui/App.tsx src/ui/components/ModelManager.tsx
# (the rm'd files are already staged by git rm)
git commit -m "refactor(ui): ModelManager uses ProviderModelFlow, drop old wizards"
```

Verify `git show HEAD --stat` lists 4 files: 2 modified, 2 deleted.

---

## Task 4 — Rewrite OnboardingPrompt to use ProviderModelFlow

**Files:** Modify `src/ui/components/OnboardingPrompt.tsx`, `src/cli/onboarding.ts`.

The new OnboardingPrompt has only THREE top-level steps:

1. **Welcome** — a one-screen greeting, press Enter to continue
2. **ProviderModelFlow** (with `switchToNewModelOnFinish=true`) — same flow as ModelManager
3. **Arena setup (optional)** — pick which of the new model aliases participate in arena; or skip with `s`
4. **Done** — call `onComplete(OnboardingResult)`

Cut from current OnboardingPrompt:
- Provider step (now in ProviderModelFlow)
- API key step (now in ProviderModelFlow)
- Pool step (now in ProviderModelFlow's multi-select)
- Custom-provider special path (now subsumed by `custom` kind in ProviderModelFlow)
- Environment-detection step (now passed to ProviderModelFlow as a hint)

Keep:
- Welcome banner text
- Arena selection UI
- The `onComplete(OnboardingResult)` callback shape — App.tsx already handles it

**Compatibility:** `OnboardingResult` shape stays the same so callers (`src/ui/App.tsx:1016+` and `src/ui/onboarding-runner.tsx`) don't need to change. The new code path builds the result from the flow + arena selections.

`src/cli/onboarding.ts` changes:
- The `PROVIDERS[].models[]` arrays are no longer authoritative for onboarding (they were the hardcoded "what you can pick" lists). Mark them as legacy or remove. If anything else still references `PROVIDERS`, leave them for now.
- Keep `detectEnvKeys`, `modelKey`, `OnboardingResult`, `resolveContextWindow`, `resolveMaxOutput`.

- [ ] **Step 1: Backup current OnboardingPrompt structure** — read whole file, note Arena UI specifics for porting
- [ ] **Step 2: Write the new OnboardingPrompt** — much shorter (target ~250 lines vs current 745)
- [ ] **Step 3: Strip PROVIDERS[].models[] entries** in `src/cli/onboarding.ts` if not used elsewhere; verify with `grep -r "PROVIDERS\[.*\]\.models" src/`.
- [ ] **Step 4: bun test + tsc --noEmit + bun run build**
- [ ] **Step 5: Commit**
```bash
git add src/ui/components/OnboardingPrompt.tsx src/cli/onboarding.ts
git commit -m "refactor(ui): OnboardingPrompt embeds ProviderModelFlow"
```

---

## Task 5 — Verification

- [ ] **Step 1:** `bun test` — must pass.
- [ ] **Step 2:** `bun run build` — must pass (ESM + CJS + dts).
- [ ] **Step 3:** Manual smoke
  - Backup `~/.code-shell/settings.json`
  - `HOME=$(mktemp -d) bun run dev` → triggers fresh onboarding → confirm new shorter flow renders
  - In real REPL: `/login` → ProviderModelFlow renders, picks an existing provider, adds two models, finishes → verify `settings.json` has appended entries (NOT overwritten)
  - `/model` → press `a` → ProviderModelFlow renders, NO active-pick step → adds a model, finishes → verify added
  - Restore your settings backup

---

## Self-Review

After each task, verify:
- Tests + tsc + build all green
- `git show HEAD --stat` matches expected file list
- No pre-existing uncommitted changes swept in (use `git diff --staged` before committing)
