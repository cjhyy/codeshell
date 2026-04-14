/**
 * First-run onboarding — interactive API key setup with arrow-key navigation.
 *
 * Features:
 * - Arrow-key (↑/↓) selection for providers and models
 * - ESC to go back to previous step
 * - Multi-provider configuration for Arena
 * - API key validation before saving
 */

import chalk from "chalk";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

interface OnboardingResult {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

interface ProviderDef {
  id: string;
  name: string;
  envKey: string;
  provider: string;
  baseUrl: string;
  defaultModel: string;
  keyUrl: string;
  keyPrefix: string;
  models: string[];
}

const PROVIDERS: ProviderDef[] = [
  {
    id: "openrouter",
    name: "OpenRouter (推荐 — 支持所有模型)",
    envKey: "OPENROUTER_API_KEY",
    provider: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4.6",
    keyUrl: "https://openrouter.ai/keys",
    keyPrefix: "sk-or-",
    models: [
      "anthropic/claude-opus-4.6",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-haiku-4.5",
      "openai/gpt-5.4",
      "openai/gpt-4o",
      "openai/o4-mini",
      "google/gemini-3.1-pro-preview",
      "google/gemini-3-flash-preview",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-v3.2",
      "deepseek/deepseek-r1",
      "qwen/qwen3-coder",
      "qwen/qwen3-235b-a22b",
      "meta-llama/llama-4-maverick",
      "mistralai/devstral-medium",
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic (直连 Claude API)",
    envKey: "ANTHROPIC_API_KEY",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-6",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPrefix: "sk-ant-",
    models: [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.4",
    keyUrl: "https://platform.openai.com/api-keys",
    keyPrefix: "sk-",
    models: ["gpt-5.4", "gpt-5.4-mini", "gpt-4o", "o4-mini", "o3"],
  },
  {
    id: "custom",
    name: "自定义 (任何 OpenAI 兼容 API)",
    envKey: "",
    provider: "openai",
    baseUrl: "",
    defaultModel: "",
    keyUrl: "",
    keyPrefix: "",
    models: [],
  },
];

// ─── Sentinel for "go back" ────────────────────────────────────────

const BACK = Symbol("back");
type MaybeBack<T> = T | typeof BACK;

// ─── Arrow-key interactive selector ────────────────────────────────

interface SelectOption {
  label: string;
  value: string;
  hint?: string;
}

/**
 * Interactive arrow-key selector.
 * ↑↓ to move, Enter to confirm, ESC to go back.
 * Returns BACK symbol if user pressed ESC.
 */
function arrowSelect(
  options: SelectOption[],
  title: string,
  opts?: { allowBack?: boolean },
): Promise<MaybeBack<string>> {
  return new Promise((resolve, reject) => {
    let cursor = 0;
    const stdin = process.stdin;
    const allowBack = opts?.allowBack ?? true;

    if (typeof stdin.setRawMode !== "function") {
      reject(new Error("Interactive onboarding requires a TTY. Set an API key via environment variable instead."));
      return;
    }
    const wasRaw = stdin.isRaw;
    const wasFlowing = stdin.readableFlowing;

    const backHint = allowBack ? chalk.dim(" (ESC 返回)") : "";

    function render() {
      const lines = options.length + 1;
      process.stdout.write(`\x1b[${lines}A\x1b[J`); // move up + clear below
      console.log(chalk.dim(`  ${title}`) + backHint);
      for (let i = 0; i < options.length; i++) {
        const opt = options[i]!;
        const selected = i === cursor;
        const prefix = selected ? chalk.cyan("❯ ") : "  ";
        const label = selected ? chalk.bold.cyan(opt.label) : chalk.white(opt.label);
        const hint = opt.hint ? chalk.dim(` ${opt.hint}`) : "";
        console.log(`  ${prefix}${label}${hint}`);
      }
    }

    // Print initial placeholder lines, then render over them
    console.log(chalk.dim(`  ${title}`) + backHint);
    for (const opt of options) {
      const hint = opt.hint ? chalk.dim(` ${opt.hint}`) : "";
      console.log(`    ${opt.label}${hint}`);
    }
    render();

    stdin.setRawMode(true);
    stdin.resume();

    function onData(data: Buffer) {
      const key = data.toString();

      if (key === "\x1b[A" || key === "k") {
        cursor = cursor > 0 ? cursor - 1 : options.length - 1;
        render();
      } else if (key === "\x1b[B" || key === "j") {
        cursor = cursor < options.length - 1 ? cursor + 1 : 0;
        render();
      } else if (key === "\r" || key === "\n") {
        cleanup();
        resolve(options[cursor]!.value);
      } else if (key === "\x1b" && allowBack) {
        // ESC — go back
        cleanup();
        resolve(BACK);
      } else if (key === "\x03") {
        cleanup();
        process.exit(1);
      } else {
        const num = parseInt(key, 10);
        if (num >= 1 && num <= options.length) {
          cursor = num - 1;
          render();
          cleanup();
          resolve(options[cursor]!.value);
        }
      }
    }

    function cleanup() {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      // Restore stdin flow state — don't unconditionally pause,
      // as Ink or other callers may need stdin to remain active.
      if (wasFlowing) {
        stdin.resume();
      } else {
        stdin.pause();
      }
    }

    stdin.on("data", onData);
  });
}

/**
 * Text prompt with ESC-to-cancel support.
 * Returns BACK if user presses ESC.
 */
function textPrompt(question: string): Promise<MaybeBack<string>> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let buffer = "";

    if (typeof stdin.setRawMode !== "function") {
      reject(new Error("Interactive onboarding requires a TTY. Set an API key via environment variable instead."));
      return;
    }
    const wasRaw = stdin.isRaw;
    const wasFlowing = stdin.readableFlowing;

    process.stdout.write(question);

    stdin.setRawMode(true);
    stdin.resume();

    function onData(data: Buffer) {
      const ch = data.toString();

      if (ch === "\x1b") {
        // ESC
        cleanup();
        process.stdout.write("\n");
        resolve(BACK);
      } else if (ch === "\x03") {
        cleanup();
        process.exit(1);
      } else if (ch === "\r" || ch === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(buffer.trim());
      } else if (ch === "\x7f" || ch === "\b") {
        // Backspace
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (ch >= " ") {
        buffer += ch;
        process.stdout.write(ch);
      }
    }

    function cleanup() {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      if (wasFlowing) {
        stdin.resume();
      } else {
        stdin.pause();
      }
    }

    stdin.on("data", onData);
  });
}

/**
 * Yes/No confirmation. Returns BACK if ESC pressed.
 */
async function confirm(question: string): Promise<MaybeBack<boolean>> {
  const result = await arrowSelect(
    [
      { label: "是", value: "yes" },
      { label: "否", value: "no" },
    ],
    question,
  );
  if (result === BACK) return BACK;
  return result === "yes";
}

// ─── API key validation ────────────────────────────────────────────

async function validateApiKey(baseUrl: string, apiKey: string): Promise<boolean> {
  try {
    if (baseUrl.includes("openrouter")) {
      const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = await res.json() as any;
      return !data.error;
    }
    const url = baseUrl.replace(/\/$/, "") + "/models";
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return res.status !== 401 && res.status !== 403;
  } catch {
    return true; // network error — can't validate, let it pass
  }
}

// ─── Public API ────────────────────────────────────────────────────

export function hasApiKey(): boolean {
  if (process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
    return true;
  }

  const settingsPaths = [
    join(homedir(), ".code-shell", "settings.json"),
    join(homedir(), ".claude", "settings.json"),
  ];

  for (const p of settingsPaths) {
    if (existsSync(p)) {
      try {
        const data = JSON.parse(readFileSync(p, "utf-8"));
        if (data?.model?.apiKey) return true;
      } catch { /* ignore */ }
    }
  }

  return false;
}

/**
 * Run the full onboarding wizard. Supports ESC to go back at every step.
 */
export async function runOnboarding(): Promise<OnboardingResult> {
  console.log();
  console.log(chalk.bold.cyan("  ✦ Code Shell — 首次配置"));
  console.log(chalk.dim("  ─".repeat(25)));

  // State machine with back navigation
  type Step = "provider" | "apikey" | "model_pool" | "default_model" | "arena_ask" | "arena_config" | "done";
  let step: Step = "provider";
  let selected: ProviderDef = PROVIDERS[0]!;
  let apiKey = "";
  let model = "";
  let poolModels: string[] = []; // models selected for the pool

  while (step !== "done") {
    switch (step) {
      // ─── Step 1: Provider ────────────────────────────────────
      case "provider": {
        console.log();
        const providerId = await arrowSelect(
          PROVIDERS.map((p) => ({ label: p.name, value: p.id })),
          "选择 API 提供商 (↑↓ 移动, Enter 确认):",
          { allowBack: false }, // first step, no back
        );
        if (providerId === BACK) break;

        selected = PROVIDERS.find((p) => p.id === providerId)!;

        if (selected.id === "custom") {
          const customResult = await configureCustomProvider();
          if (customResult === BACK) break; // stay on provider step
          saveSettings(customResult);
          printSuccess(selected.name, customResult.model);
          return customResult;
        }

        step = "apikey";
        break;
      }

      // ─── Step 2: API Key ─────────────────────────────────────
      case "apikey": {
        console.log();
        if (selected.keyUrl) {
          console.log(chalk.dim(`  获取 API Key: ${chalk.underline(selected.keyUrl)}`));
        }
        console.log();

        const keyResult = await textPrompt(chalk.cyan(`  ${selected.envKey || "API Key"}: `));
        if (keyResult === BACK) { step = "provider"; break; }
        if (!keyResult) {
          console.log(chalk.yellow("  ⚠ 请输入 API Key (ESC 返回上一步)"));
          break; // retry this step
        }

        // Validate
        process.stdout.write(chalk.dim("  验证 Key..."));
        const valid = await validateApiKey(selected.baseUrl, keyResult);
        if (!valid) {
          console.log(chalk.red(" ✗ 无效"));
          console.log(chalk.yellow("  ⚠ API Key 验证失败，请检查后重试 (ESC 返回上一步)"));
          break; // retry
        }
        console.log(chalk.green(" ✓"));

        apiKey = keyResult;
        step = "model_pool";
        break;
      }

      // ─── Step 3: Model Pool — select which models to enable ──
      case "model_pool": {
        if (selected.models.length <= 1) {
          poolModels = [...selected.models];
          model = selected.defaultModel;
          step = "arena_ask";
          break;
        }

        console.log();
        console.log(chalk.dim("  选择要加入模型池的模型 (模型池中的模型可通过 /model 随时切换)"));

        const poolResult = await selectModelPool(selected.models, selected.defaultModel);
        if (poolResult === BACK) { step = "apikey"; break; }

        poolModels = poolResult;
        if (poolModels.length === 0) {
          // Must have at least one
          poolModels = [selected.defaultModel];
        }
        step = "default_model";
        break;
      }

      // ─── Step 4: Default Model — pick from pool ──────────────
      case "default_model": {
        if (poolModels.length === 1) {
          model = poolModels[0]!;
          saveSettings({ provider: selected.provider, model, apiKey, baseUrl: selected.baseUrl }, selected, poolModels);
          step = "arena_ask";
          break;
        }

        console.log();
        const modelResult = await arrowSelect(
          poolModels.map((m) => ({
            label: m,
            value: m,
            hint: m === selected.defaultModel ? "(推荐)" : undefined,
          })),
          "选择默认模型 (日常对话使用):",
        );

        if (modelResult === BACK) { step = "model_pool"; break; }
        model = modelResult;

        saveSettings({ provider: selected.provider, model, apiKey, baseUrl: selected.baseUrl }, selected, poolModels);
        step = "arena_ask";
        break;
      }

      // ─── Step 5: Arena? ─────────────────────────────────────
      case "arena_ask": {
        // Save settings (in case previous steps didn't)
        saveSettings({ provider: selected.provider, model, apiKey, baseUrl: selected.baseUrl }, selected, poolModels);

        if (poolModels.length < 2) {
          // Need at least 2 models for arena
          step = "done";
          break;
        }

        console.log();
        const wantArena = await confirm("是否配置 Arena 多模型对比? (可在 /arena 中使用多个模型)");
        if (wantArena === BACK) { step = "default_model"; break; }

        if (wantArena) {
          step = "arena_config";
        } else {
          step = "done";
        }
        break;
      }

      // ─── Step 6: Arena config — pick from pool ───────────────
      case "arena_config": {
        await configureArenaFromPool(poolModels, model);
        step = "done";
        break;
      }
    }
  }

  const result: OnboardingResult = { provider: selected.provider, model, apiKey, baseUrl: selected.baseUrl };
  printSuccess(selected.name, model);

  // Reset stdin so Ink can take over cleanly.
  // The arrow-select / text-prompt helpers leave stdin paused with
  // raw mode off and all listeners removed — ensure a neutral state.
  const stdin = process.stdin;
  if (typeof stdin.setRawMode === "function") {
    stdin.setRawMode(false);
  }
  stdin.removeAllListeners("data");

  return result;
}

// ─── Model pool multi-select ──────────────────────────────────────

/**
 * Interactive model pool selection.
 * User toggles models on/off, then confirms.
 */
async function selectModelPool(
  available: string[],
  defaultModel: string,
): Promise<MaybeBack<string[]>> {
  // Pre-select: default model + a few popular ones
  const preselected = new Set<string>();
  preselected.add(defaultModel);

  const selected = new Set<string>(preselected);

  // Multi-select loop
  while (true) {
    console.log();
    console.log(chalk.dim("  当前模型池:"));
    if (selected.size === 0) {
      console.log(chalk.dim("    (空)"));
    } else {
      for (const m of selected) {
        console.log(`    ${chalk.cyan("✓")} ${m}`);
      }
    }
    console.log();

    const notInPool = available.filter((m) => !selected.has(m));
    const options: SelectOption[] = [
      ...(notInPool.length > 0
        ? [{ label: "添加模型", value: "add" }]
        : []),
      ...(selected.size > 0
        ? [{ label: "移除模型", value: "remove" }]
        : []),
      { label: selected.size > 0 ? `✓ 确认 (${selected.size} 个模型)` : "跳过", value: "done" },
    ];

    const action = await arrowSelect(options, "模型池操作:", { allowBack: true });
    if (action === BACK) return BACK;
    if (action === "done") return [...selected];

    if (action === "add") {
      console.log();
      const choice = await arrowSelect(
        notInPool.map((m) => ({
          label: m,
          value: m,
          hint: m === defaultModel ? "(推荐)" : undefined,
        })),
        "添加到模型池:",
      );
      if (choice !== BACK) {
        selected.add(choice);
        console.log(chalk.green(`  ✓ 已添加: ${modelDisplayName(choice)}`));
      }
    }

    if (action === "remove") {
      const inPool = [...selected];
      console.log();
      const choice = await arrowSelect(
        inPool.map((m) => ({ label: m, value: m })),
        "从模型池移除:",
      );
      if (choice !== BACK) {
        selected.delete(choice);
        console.log(chalk.yellow(`  ✗ 已移除: ${modelDisplayName(choice)}`));
      }
    }
  }
}

// ─── Arena config from pool ────────────────────────────────────────

/**
 * Configure arena participants by selecting from the model pool.
 */
async function configureArenaFromPool(poolModels: string[], defaultModel: string): Promise<void> {
  const participants = new Set<string>();

  console.log();
  console.log(chalk.dim(`  从模型池中选择参与 Arena 对比的模型 (默认对话模型: ${chalk.white(defaultModel)})`));

  while (true) {
    console.log();
    if (participants.size > 0) {
      console.log(chalk.dim("  当前 Arena 阵容:"));
      let idx = 0;
      for (const m of participants) {
        idx++;
        console.log(`    ${chalk.dim(`${idx}.`)} ${chalk.cyan(modelDisplayName(m))} ${chalk.dim(`(${m})`)}`);
      }
    } else {
      console.log(chalk.dim("  当前 Arena 阵容: (空)"));
    }
    console.log();

    const notInArena = poolModels.filter((m) => !participants.has(m));
    const options: SelectOption[] = [
      ...(notInArena.length > 0
        ? [{ label: "从模型池添加", value: "add" }]
        : []),
      ...(participants.size > 0
        ? [{ label: "移除最后添加的", value: "remove" }]
        : []),
      {
        label: participants.size >= 2
          ? `✓ 完成配置 (${participants.size} 个模型)`
          : "跳过 (至少需要 2 个模型)",
        value: "done",
      },
    ];

    const action = await arrowSelect(options, "操作:", { allowBack: true });
    if (action === BACK || action === "done") break;

    if (action === "add") {
      console.log();
      const choice = await arrowSelect(
        notInArena.map((m) => ({ label: `${modelDisplayName(m)}  ${chalk.dim(m)}`, value: m })),
        "选择模型:",
      );
      if (choice !== BACK) {
        participants.add(choice);
        console.log(chalk.green(`  ✓ 已添加: ${modelDisplayName(choice)}`));
      }
    }

    if (action === "remove" && participants.size > 0) {
      const arr = [...participants];
      const removed = arr.pop()!;
      participants.delete(removed);
      console.log(chalk.yellow(`  ✗ 已移除: ${modelDisplayName(removed)}`));
    }
  }

  if (participants.size >= 2) {
    // Save as pool keys
    const arenaKeys = [...participants].map((m) => modelKey(m));
    saveArenaSettingsByKeys(arenaKeys);
    console.log();
    console.log(chalk.green(`  ✓ Arena 已配置 ${participants.size} 个模型`));
  } else {
    console.log(chalk.dim("  跳过 Arena 配置 (需要至少 2 个模型)"));
  }
}

// ─── Custom provider sub-flow ──────────────────────────────────────

async function configureCustomProvider(): Promise<MaybeBack<OnboardingResult>> {
  console.log();
  const baseUrl = await textPrompt(chalk.cyan("  API Base URL: "));
  if (baseUrl === BACK) return BACK;

  const apiKey = await textPrompt(chalk.cyan("  API Key: "));
  if (apiKey === BACK) return BACK;

  const model = await textPrompt(chalk.cyan("  模型名称: "));
  if (model === BACK) return BACK;

  return {
    provider: "openai",
    model: model || "gpt-4o",
    apiKey: apiKey || "",
    baseUrl: baseUrl || "http://localhost:11434/v1",
  };
}

// configureArena removed — replaced by configureArenaFromPool in runOnboarding

// ─── Model pool helpers ───────────────────────────────────────────

/** Known max output tokens for common models. */
const KNOWN_MAX_OUTPUT: Record<string, number> = {
  "anthropic/claude-opus-4.6": 32000,
  "anthropic/claude-opus-4-6": 32000,
  "claude-opus-4-6": 32000,
  "anthropic/claude-sonnet-4.6": 16000,
  "anthropic/claude-sonnet-4-6": 16000,
  "claude-sonnet-4-6": 16000,
  "anthropic/claude-haiku-4.5": 8192,
  "anthropic/claude-haiku-4-5": 8192,
  "claude-haiku-4-5": 8192,
  "openai/gpt-5.4": 32000,
  "gpt-5.4": 32000,
  "openai/gpt-4o": 16384,
  "gpt-4o": 16384,
  "openai/o4-mini": 100000,
  "o4-mini": 100000,
  "openai/o3": 100000,
  "o3": 100000,
  "google/gemini-3.1-pro-preview": 65536,
  "google/gemini-3-flash-preview": 65536,
  "google/gemini-2.5-pro": 65536,
  "deepseek/deepseek-v3.2": 8192,
  "deepseek/deepseek-r1": 8192,
  "qwen/qwen3-coder": 16384,
  "qwen/qwen3-235b-a22b": 8192,
  "meta-llama/llama-4-maverick": 32000,
  "mistralai/devstral-medium": 24000,
};

/**
 * Derive a short key from a model path.
 * "anthropic/claude-opus-4.6" → "claude-opus"
 * "openai/gpt-5.4" → "gpt"
 * "deepseek/deepseek-v3.2" → "deepseek"
 */
function modelKey(model: string): string {
  const slash = model.lastIndexOf("/");
  const base = slash >= 0 ? model.slice(slash + 1) : model;
  // claude models: "claude-opus-4.6" → "claude-opus", "claude-sonnet-4.6" → "claude-sonnet"
  if (base.startsWith("claude-")) {
    const parts = base.split("-");
    return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : parts[0]!;
  }
  // gpt: "gpt-5.4" → "gpt", "gpt-4o" → "gpt4o"
  if (base.startsWith("gpt-")) {
    const rest = base.slice(4);
    if (/^\d/.test(rest)) return "gpt";
    return `gpt${rest.split("-")[0]}`;
  }
  // gemini: "gemini-3.1-pro-preview" → "gemini-pro", "gemini-3-flash-preview" → "gemini-flash"
  if (base.startsWith("gemini-")) {
    if (base.includes("flash")) return "gemini-flash";
    if (base.includes("pro")) return "gemini-pro";
    return "gemini";
  }
  // deepseek: "deepseek-v3.2" → "deepseek", "deepseek-r1" → "deepseek-r1"
  if (base.startsWith("deepseek-")) {
    if (base.includes("r1")) return "deepseek-r1";
    return "deepseek";
  }
  // qwen: "qwen3-coder" → "qwen-coder", "qwen3-235b-a22b" → "qwen"
  if (base.startsWith("qwen")) {
    if (base.includes("coder")) return "qwen-coder";
    return "qwen";
  }
  // o4-mini, o3
  if (/^o\d/.test(base)) return base.split("-")[0]!;
  // llama-4-maverick → "llama"
  if (base.startsWith("llama")) return "llama";
  // devstral-medium → "devstral"
  if (base.startsWith("devstral")) return "devstral";
  // fallback: first segment
  return base.split("-")[0] ?? base;
}

/**
 * Build model pool entries from a provider's model list.
 */
function buildModelPool(
  provider: ProviderDef,
  apiKey: string,
): Array<{ key: string; label: string; provider: string; model: string; baseUrl: string; apiKey: string; maxOutputTokens?: number }> {
  return provider.models.map((m) => ({
    key: modelKey(m),
    label: modelDisplayName(m),
    provider: provider.provider,
    model: m,
    baseUrl: provider.baseUrl,
    apiKey,
    maxOutputTokens: KNOWN_MAX_OUTPUT[m],
  }));
}

// ─── Helpers ───────────────────────────────────────────────────────

function modelDisplayName(model: string): string {
  const slash = model.lastIndexOf("/");
  const base = slash >= 0 ? model.slice(slash + 1) : model;
  const parts = base.split("-");
  if (parts[0] === "claude") {
    const variant = parts[1] ?? "";
    return `Claude ${variant.charAt(0).toUpperCase() + variant.slice(1)}`;
  }
  if (base.startsWith("gpt-")) return `GPT-${parts.slice(1).join("-")}`;
  if (base.startsWith("gemini-")) return `Gemini ${parts.slice(1).join("-")}`;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function printSuccess(providerName: string, model: string): void {
  console.log();
  console.log(chalk.green("  ✓ 配置已保存"));
  console.log(chalk.dim(`    Provider: ${providerName}`));
  console.log(chalk.dim(`    Model:    ${model}`));
  console.log(chalk.dim(`    Config:   ~/.code-shell/settings.json`));
  console.log();
}

function saveSettings(result: OnboardingResult, providerDef?: ProviderDef, poolModels?: string[]): void {
  const dir = join(homedir(), ".code-shell");
  const file = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    try { existing = JSON.parse(readFileSync(file, "utf-8")); } catch {}
  }

  const updated: Record<string, unknown> = {
    ...existing,
    model: {
      ...(typeof existing.model === "object" ? existing.model : {}),
      provider: result.provider,
      name: result.model,
      apiKey: result.apiKey,
      baseUrl: result.baseUrl,
    },
  };

  // Build model pool from user-selected models
  if (providerDef && poolModels && poolModels.length > 0) {
    const allEntries = buildModelPool(providerDef, result.apiKey);
    const selectedSet = new Set(poolModels);
    updated.models = allEntries.filter((e) => selectedSet.has(e.model));
  }

  writeFileSync(file, JSON.stringify(updated, null, 2) + "\n", "utf-8");
}

// saveArenaSettings removed — replaced by saveArenaSettingsByKeys

function saveArenaSettingsByKeys(keys: string[]): void {
  const dir = join(homedir(), ".code-shell");
  const file = join(dir, "settings.json");

  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    try { existing = JSON.parse(readFileSync(file, "utf-8")); } catch {}
  }

  const updated = {
    ...existing,
    arena: { participants: keys },
  };

  writeFileSync(file, JSON.stringify(updated, null, 2) + "\n", "utf-8");
}

/**
 * Re-run onboarding from REPL (/login command).
 * Clears existing config first.
 */
export async function reconfigure(): Promise<OnboardingResult> {
  const file = join(homedir(), ".code-shell", "settings.json");
  if (existsSync(file)) {
    try {
      const settings = JSON.parse(readFileSync(file, "utf-8"));
      delete settings.model?.apiKey;
      writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    } catch {}
  }
  return runOnboarding();
}
