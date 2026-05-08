/**
 * OnboardingPrompt — Ink-rendered API key / provider configuration wizard.
 *
 * Replaces the console-based runOnboarding() flow when triggered from inside
 * the REPL (/login). Mirrors the same six-step state machine but renders into
 * the bottom slot of the layout, so it does not collide with Ink's frame
 * buffer or intercept keystrokes destined for the main App.
 *
 * Steps: provider → apikey → model_pool → default_model → arena_ask → arena_config
 */
import { useState } from "react";
import { Box, Text, useInput } from "../../ink/index.js";
import TextInput from "./TextInput.js";
import {
  PROVIDERS,
  type ProviderDef,
  type OnboardingResult,
  detectEnvKeys,
  maskKey,
  validateApiKey,
  saveSettings,
  saveArenaSettingsByKeys,
  modelKey,
  modelDisplayName,
} from "../../cli/onboarding.js";

type Step =
  | "provider"
  | "apikey"
  | "model_pool"
  | "default_model"
  | "arena_ask"
  | "arena_config"
  | "done";

interface OnboardingPromptProps {
  onComplete: (result: OnboardingResult) => void;
  onCancel: () => void;
}

interface ProviderOption {
  kind: "env" | "provider";
  envIndex?: number;
  providerIndex: number;
  label: string;
  hint?: string;
}

export function OnboardingPrompt({ onComplete, onCancel }: OnboardingPromptProps) {
  const [step, setStep] = useState<Step>("provider");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<ProviderDef>(PROVIDERS[0]!);
  const [apiKey, setApiKey] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [validating, setValidating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [poolModels, setPoolModels] = useState<string[]>([]);
  const [poolDraft, setPoolDraft] = useState<Set<string>>(new Set());
  const [poolAction, setPoolAction] = useState<"menu" | "add" | "remove">("menu");
  const [defaultModel, setDefaultModel] = useState("");
  const [arenaParticipants, setArenaParticipants] = useState<Set<string>>(new Set());
  const [arenaAction, setArenaAction] = useState<"menu" | "add">("menu");

  const detected = detectEnvKeys();
  const providerOptions: ProviderOption[] = [
    ...detected.map((d, i) => ({
      kind: "env" as const,
      envIndex: i,
      providerIndex: PROVIDERS.findIndex((p) => p.id === d.provider.id),
      label: `使用环境变量 ${d.envKey} → ${d.provider.name}`,
      hint: `(${maskKey(d.apiKey)})`,
    })),
    ...PROVIDERS.map((p, i) => ({
      kind: "provider" as const,
      providerIndex: i,
      label: p.name,
    })),
  ];

  // ─── Provider step ────────────────────────────────────────────────
  useInput((_ch, key) => {
    if (step === "provider") {
      if (key.upArrow) setCursor((c) => (c > 0 ? c - 1 : providerOptions.length - 1));
      else if (key.downArrow) setCursor((c) => (c < providerOptions.length - 1 ? c + 1 : 0));
      else if (key.return) {
        const opt = providerOptions[cursor]!;
        const provider = PROVIDERS[opt.providerIndex]!;
        setSelected(provider);
        setErrorMsg(null);

        if (opt.kind === "env") {
          const det = detected[opt.envIndex!]!;
          setApiKey(det.apiKey);
          enterPoolStep(provider);
        } else if (provider.noKey) {
          setApiKey("ollama");
          enterPoolStep(provider);
        } else if (provider.id === "custom") {
          // Custom provider not supported in Ink wizard — fallback message
          setErrorMsg("自定义 provider 暂只在首次启动向导支持，请用 /logout 后重启。");
        } else {
          setStep("apikey");
          setApiKeyInput("");
        }
        setCursor(0);
      } else if (key.escape) {
        onCancel();
      }
    } else if (step === "apikey") {
      if (key.escape) {
        setStep("provider");
        setErrorMsg(null);
      }
    } else if (step === "model_pool") {
      handlePoolInput(key);
    } else if (step === "default_model") {
      const opts = poolModels;
      if (key.upArrow) setCursor((c) => (c > 0 ? c - 1 : opts.length - 1));
      else if (key.downArrow) setCursor((c) => (c < opts.length - 1 ? c + 1 : 0));
      else if (key.return) {
        const m = opts[cursor]!;
        setDefaultModel(m);
        saveSettings(
          { provider: selected.provider, model: m, apiKey, baseUrl: selected.baseUrl },
          selected,
          poolModels,
        );
        if (poolModels.length < 2) {
          finalize(m);
        } else {
          setStep("arena_ask");
          setCursor(0);
        }
      } else if (key.escape) {
        setStep("model_pool");
        setPoolAction("menu");
        setCursor(0);
      }
    } else if (step === "arena_ask") {
      if (key.upArrow || key.downArrow) setCursor((c) => (c === 0 ? 1 : 0));
      else if (key.return) {
        if (cursor === 0) {
          setStep("arena_config");
          setArenaAction("menu");
          setCursor(0);
        } else {
          finalize(defaultModel);
        }
      } else if (key.escape) {
        setStep("default_model");
        setCursor(poolModels.indexOf(defaultModel));
      }
    } else if (step === "arena_config") {
      handleArenaInput(key);
    }
  });

  function enterPoolStep(provider: ProviderDef) {
    if (provider.models.length <= 1) {
      const m = provider.defaultModel;
      setPoolModels([...provider.models]);
      setDefaultModel(m);
      saveSettings(
        { provider: provider.provider, model: m, apiKey, baseUrl: provider.baseUrl },
        provider,
        provider.models,
      );
      finalize(m);
      return;
    }
    const draft = new Set<string>([provider.defaultModel]);
    setPoolDraft(draft);
    setPoolAction("menu");
    setStep("model_pool");
    setCursor(0);
  }

  function poolMenuOptions(): string[] {
    const opts: string[] = [];
    const notInPool = selected.models.filter((m) => !poolDraft.has(m));
    if (notInPool.length > 0) opts.push("add");
    if (poolDraft.size > 0) opts.push("remove");
    opts.push("done");
    return opts;
  }

  function handlePoolInput(key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean }) {
    if (poolAction === "menu") {
      const opts = poolMenuOptions();
      if (key.upArrow) setCursor((c) => (c > 0 ? c - 1 : opts.length - 1));
      else if (key.downArrow) setCursor((c) => (c < opts.length - 1 ? c + 1 : 0));
      else if (key.return) {
        const action = opts[cursor]!;
        if (action === "done") {
          const list = poolDraft.size > 0 ? [...poolDraft] : [selected.defaultModel];
          setPoolModels(list);
          if (list.length === 1) {
            const m = list[0]!;
            setDefaultModel(m);
            saveSettings(
              { provider: selected.provider, model: m, apiKey, baseUrl: selected.baseUrl },
              selected,
              list,
            );
            finalize(m);
          } else {
            setStep("default_model");
            const idx = list.indexOf(selected.defaultModel);
            setCursor(idx >= 0 ? idx : 0);
          }
        } else if (action === "add") {
          setPoolAction("add");
          setCursor(0);
        } else if (action === "remove") {
          setPoolAction("remove");
          setCursor(0);
        }
      } else if (key.escape) {
        if (selected.noKey || detected.some((d) => d.apiKey === apiKey)) {
          setStep("provider");
        } else {
          setStep("apikey");
        }
        setCursor(0);
      }
    } else if (poolAction === "add") {
      const opts = selected.models.filter((m) => !poolDraft.has(m));
      if (opts.length === 0) { setPoolAction("menu"); setCursor(0); return; }
      if (key.upArrow) setCursor((c) => (c > 0 ? c - 1 : opts.length - 1));
      else if (key.downArrow) setCursor((c) => (c < opts.length - 1 ? c + 1 : 0));
      else if (key.return) {
        const m = opts[cursor]!;
        const next = new Set(poolDraft); next.add(m);
        setPoolDraft(next);
        setPoolAction("menu");
        setCursor(0);
      } else if (key.escape) {
        setPoolAction("menu");
        setCursor(0);
      }
    } else if (poolAction === "remove") {
      const opts = [...poolDraft];
      if (opts.length === 0) { setPoolAction("menu"); setCursor(0); return; }
      if (key.upArrow) setCursor((c) => (c > 0 ? c - 1 : opts.length - 1));
      else if (key.downArrow) setCursor((c) => (c < opts.length - 1 ? c + 1 : 0));
      else if (key.return) {
        const m = opts[cursor]!;
        const next = new Set(poolDraft); next.delete(m);
        setPoolDraft(next);
        setPoolAction("menu");
        setCursor(0);
      } else if (key.escape) {
        setPoolAction("menu");
        setCursor(0);
      }
    }
  }

  function arenaMenuOptions(): string[] {
    const opts: string[] = [];
    const notInArena = poolModels.filter((m) => !arenaParticipants.has(m));
    if (notInArena.length > 0) opts.push("add");
    if (arenaParticipants.size > 0) opts.push("remove_last");
    opts.push("done");
    return opts;
  }

  function handleArenaInput(key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean }) {
    if (arenaAction === "menu") {
      const opts = arenaMenuOptions();
      if (key.upArrow) setCursor((c) => (c > 0 ? c - 1 : opts.length - 1));
      else if (key.downArrow) setCursor((c) => (c < opts.length - 1 ? c + 1 : 0));
      else if (key.return) {
        const action = opts[cursor]!;
        if (action === "done") {
          if (arenaParticipants.size >= 2) {
            const keys = [...arenaParticipants].map((m) => modelKey(m));
            saveArenaSettingsByKeys(keys);
          }
          finalize(defaultModel);
        } else if (action === "add") {
          setArenaAction("add");
          setCursor(0);
        } else if (action === "remove_last") {
          const arr = [...arenaParticipants];
          arr.pop();
          setArenaParticipants(new Set(arr));
          setCursor(0);
        }
      } else if (key.escape) {
        setStep("arena_ask");
        setCursor(0);
      }
    } else if (arenaAction === "add") {
      const opts = poolModels.filter((m) => !arenaParticipants.has(m));
      if (opts.length === 0) { setArenaAction("menu"); setCursor(0); return; }
      if (key.upArrow) setCursor((c) => (c > 0 ? c - 1 : opts.length - 1));
      else if (key.downArrow) setCursor((c) => (c < opts.length - 1 ? c + 1 : 0));
      else if (key.return) {
        const m = opts[cursor]!;
        const next = new Set(arenaParticipants); next.add(m);
        setArenaParticipants(next);
        setArenaAction("menu");
        setCursor(0);
      } else if (key.escape) {
        setArenaAction("menu");
        setCursor(0);
      }
    }
  }

  function finalize(model: string) {
    setStep("done");
    onComplete({
      provider: selected.provider,
      model,
      apiKey,
      baseUrl: selected.baseUrl,
    });
  }

  async function submitApiKey(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      setErrorMsg("请输入 API Key (Esc 返回)");
      return;
    }
    setValidating(true);
    setErrorMsg(null);
    const valid = await validateApiKey(selected.baseUrl, trimmed);
    setValidating(false);
    if (!valid) {
      setErrorMsg("API Key 验证失败 (Esc 返回上一步)");
      return;
    }
    setApiKey(trimmed);
    enterPoolStep(selected);
  }

  // ─── Render ───────────────────────────────────────────────────────

  const Header = (
    <Box>
      <Text color="ansi:cyan" bold>{"✦ Code Shell — 配置向导"}</Text>
      <Text dim>{"  (Esc 返回 / 取消)"}</Text>
    </Box>
  );

  if (step === "provider") {
    return (
      <Box flexDirection="column" marginLeft={1}>
        {Header}
        <Box marginLeft={2}><Text dim>选择 API 提供商:</Text></Box>
        {providerOptions.map((opt, i) => (
          <Box key={i} marginLeft={2}>
            <Text color={i === cursor ? "ansi:cyan" : undefined} bold={i === cursor}>
              {i === cursor ? "❯ " : "  "}{opt.label}
            </Text>
            {opt.hint && <Text dim>{" "}{opt.hint}</Text>}
          </Box>
        ))}
        {errorMsg && <Box marginLeft={2}><Text color="ansi:yellow">{errorMsg}</Text></Box>}
      </Box>
    );
  }

  if (step === "apikey") {
    return (
      <Box flexDirection="column" marginLeft={1}>
        {Header}
        <Box marginLeft={2}><Text dim>{selected.name}</Text></Box>
        {selected.keyUrl && (
          <Box marginLeft={2}><Text dim>获取 Key: {selected.keyUrl}</Text></Box>
        )}
        <Box marginLeft={2}>
          <Text color="ansi:cyan">{selected.envKey || "API Key"}{": "}</Text>
          <TextInput
            value={apiKeyInput}
            onChange={setApiKeyInput}
            onSubmit={submitApiKey}
            placeholder={validating ? "验证中..." : "粘贴你的 API Key, Enter 确认"}
            focus={!validating}
          />
        </Box>
        {errorMsg && <Box marginLeft={2}><Text color="ansi:yellow">{errorMsg}</Text></Box>}
      </Box>
    );
  }

  if (step === "model_pool") {
    if (poolAction === "menu") {
      const opts = poolMenuOptions();
      const labels: Record<string, string> = {
        add: "添加模型",
        remove: "移除模型",
        done: poolDraft.size > 0 ? `✓ 确认 (${poolDraft.size} 个模型)` : "跳过",
      };
      return (
        <Box flexDirection="column" marginLeft={1}>
          {Header}
          <Box marginLeft={2}><Text dim>当前模型池:</Text></Box>
          {poolDraft.size === 0 ? (
            <Box marginLeft={4}><Text dim>(空)</Text></Box>
          ) : (
            [...poolDraft].map((m) => (
              <Box key={m} marginLeft={4}><Text color="ansi:cyan">✓</Text><Text>{" "}{m}</Text></Box>
            ))
          )}
          <Box marginLeft={2}><Text dim>操作:</Text></Box>
          {opts.map((a, i) => (
            <Box key={a} marginLeft={2}>
              <Text color={i === cursor ? "ansi:cyan" : undefined} bold={i === cursor}>
                {i === cursor ? "❯ " : "  "}{labels[a]}
              </Text>
            </Box>
          ))}
        </Box>
      );
    }
    if (poolAction === "add") {
      const opts = selected.models.filter((m) => !poolDraft.has(m));
      return (
        <Box flexDirection="column" marginLeft={1}>
          {Header}
          <Box marginLeft={2}><Text dim>添加到模型池:</Text></Box>
          {opts.map((m, i) => (
            <Box key={m} marginLeft={2}>
              <Text color={i === cursor ? "ansi:cyan" : undefined} bold={i === cursor}>
                {i === cursor ? "❯ " : "  "}{m}
              </Text>
              {m === selected.defaultModel && <Text dim>{" (推荐)"}</Text>}
            </Box>
          ))}
        </Box>
      );
    }
    // remove
    const opts = [...poolDraft];
    return (
      <Box flexDirection="column" marginLeft={1}>
        {Header}
        <Box marginLeft={2}><Text dim>从模型池移除:</Text></Box>
        {opts.map((m, i) => (
          <Box key={m} marginLeft={2}>
            <Text color={i === cursor ? "ansi:cyan" : undefined} bold={i === cursor}>
              {i === cursor ? "❯ " : "  "}{m}
            </Text>
          </Box>
        ))}
      </Box>
    );
  }

  if (step === "default_model") {
    return (
      <Box flexDirection="column" marginLeft={1}>
        {Header}
        <Box marginLeft={2}><Text dim>选择默认模型 (日常对话使用):</Text></Box>
        {poolModels.map((m, i) => (
          <Box key={m} marginLeft={2}>
            <Text color={i === cursor ? "ansi:cyan" : undefined} bold={i === cursor}>
              {i === cursor ? "❯ " : "  "}{m}
            </Text>
            {m === selected.defaultModel && <Text dim>{" (推荐)"}</Text>}
          </Box>
        ))}
      </Box>
    );
  }

  if (step === "arena_ask") {
    const labels = ["是", "否"];
    return (
      <Box flexDirection="column" marginLeft={1}>
        {Header}
        <Box marginLeft={2}><Text dim>是否配置 Arena 多模型对比?</Text></Box>
        {labels.map((l, i) => (
          <Box key={l} marginLeft={2}>
            <Text color={i === cursor ? "ansi:cyan" : undefined} bold={i === cursor}>
              {i === cursor ? "❯ " : "  "}{l}
            </Text>
          </Box>
        ))}
      </Box>
    );
  }

  if (step === "arena_config") {
    if (arenaAction === "menu") {
      const opts = arenaMenuOptions();
      const labels: Record<string, string> = {
        add: "从模型池添加",
        remove_last: "移除最后添加的",
        done: arenaParticipants.size >= 2
          ? `✓ 完成配置 (${arenaParticipants.size} 个模型)`
          : "跳过 (至少需要 2 个模型)",
      };
      return (
        <Box flexDirection="column" marginLeft={1}>
          {Header}
          <Box marginLeft={2}><Text dim>Arena 阵容:</Text></Box>
          {arenaParticipants.size === 0 ? (
            <Box marginLeft={4}><Text dim>(空)</Text></Box>
          ) : (
            [...arenaParticipants].map((m, i) => (
              <Box key={m} marginLeft={4}>
                <Text dim>{i + 1}. </Text>
                <Text color="ansi:cyan">{modelDisplayName(m)}</Text>
                <Text dim>{" ("}{m}{")"}</Text>
              </Box>
            ))
          )}
          <Box marginLeft={2}><Text dim>操作:</Text></Box>
          {opts.map((a, i) => (
            <Box key={a} marginLeft={2}>
              <Text color={i === cursor ? "ansi:cyan" : undefined} bold={i === cursor}>
                {i === cursor ? "❯ " : "  "}{labels[a]}
              </Text>
            </Box>
          ))}
        </Box>
      );
    }
    const opts = poolModels.filter((m) => !arenaParticipants.has(m));
    return (
      <Box flexDirection="column" marginLeft={1}>
        {Header}
        <Box marginLeft={2}><Text dim>选择模型加入 Arena:</Text></Box>
        {opts.map((m, i) => (
          <Box key={m} marginLeft={2}>
            <Text color={i === cursor ? "ansi:cyan" : undefined} bold={i === cursor}>
              {i === cursor ? "❯ " : "  "}{modelDisplayName(m)}
            </Text>
            <Text dim>{"  "}{m}</Text>
          </Box>
        ))}
      </Box>
    );
  }

  return null;
}
