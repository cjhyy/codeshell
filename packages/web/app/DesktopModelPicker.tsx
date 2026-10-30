import React from "react";
import type { MobileRuntimeModel } from "../src/hooks/useRemoteApp.js";
import { ModelChoicePicker, type ModelChoice } from "./ModelChoicePicker.js";
import type { HubConfiguration } from "./configuration.js";

export const CURRENT_NATIVE_MODEL = "session:current-native";
export const nativeModelChoice = (connectionId: string) => `native:${connectionId}`;
export const nativeConnectionId = (choice: string) =>
  choice.startsWith("native:") ? choice.slice("native:".length) : undefined;

export function nativeModelChoices(configuration: HubConfiguration | null): ModelChoice[] {
  return (configuration?.connections ?? []).flatMap((connection) => {
    if (connection.tag !== "text") return [];
    const provider = configuration?.catalog.find((item) => item.id === connection.catalogId);
    if (!provider) return [];
    const preset = provider.modelPresets?.find((item) => item.value === connection.model);
    return [
      {
        value: nativeModelChoice(connection.id),
        label: `${preset?.label ?? connection.model} · ${connection.id}`,
        group: provider.displayName,
        description: [
          !preset ? "自定义模型 · 高级参数由桌面管理" : undefined,
          preset?.supportsVision ? "支持图片" : undefined,
          preset?.maxContextTokens
            ? `${preset.maxContextTokens.toLocaleString()} 上下文`
            : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
      },
    ];
  });
}

/** Persisted provider identity also covers sessions saved without a model alias. */
export function desktopRuntimeModel(session?: { model?: string; provider?: string }): string {
  if (session?.provider === "codex" || session?.provider === "claude-code")
    return session.model?.startsWith(`${session.provider}/`)
      ? session.model
      : `${session.provider}/${session.model ?? ""}`;
  // Legacy external rows can lack a provider, but a known native provider may
  // legitimately expose a custom model ID beginning with e.g. "codex/".
  if (!session?.provider && /^(codex|claude-code)\//.test(session?.model ?? ""))
    return session!.model!;
  return "";
}

export function DesktopModelPicker({
  models,
  value,
  defaultLabel,
  defaultDisabled,
  nativeChoices = [],
  currentNativeLabel,
  loading,
  error,
  disabled,
  onChange,
  onRefresh,
  onRetryCreation,
}: {
  models: MobileRuntimeModel[];
  value: string;
  defaultLabel: string;
  defaultDisabled?: boolean;
  nativeChoices?: ModelChoice[];
  currentNativeLabel?: string;
  loading?: boolean;
  error?: string;
  disabled: boolean;
  onChange: (modelKey: string) => void;
  onRefresh?: () => void;
  onRetryCreation?: () => void;
}) {
  const choices: ModelChoice[] = [
    { value: "", label: `${defaultLabel} · 默认`, disabled: defaultDisabled },
  ];
  if (value === CURRENT_NATIVE_MODEL)
    choices.push({
      value,
      label: `${currentNativeLabel || "原生模型"} · 当前会话`,
      disabled: true,
    });
  else if (
    value &&
    !models.some((model) => model.key === value) &&
    !nativeChoices.some((model) => model.value === value)
  )
    choices.push({ value, label: `${value} · 当前会话`, disabled: !!nativeConnectionId(value) });
  choices.push(...nativeChoices);
  for (const kind of ["claude-code", "codex"] as const)
    choices.push(
      ...models
        .filter((model) => model.kind === kind)
        .map((model) => ({
          value: model.key,
          label: model.label,
          group: kind === "codex" ? "Codex" : "Claude Code",
        })),
    );
  return (
    <div className="desktop-model-picker">
      <ModelChoicePicker
        className="model-button"
        label="选择模型或外部运行时"
        value={value}
        choices={choices}
        disabled={disabled}
        onChange={onChange}
        status={
          !models.length ? (loading ? "正在检测外部模型…" : error || "暂无可用的外部模型") : error
        }
      />
      {onRetryCreation ? (
        <button className="library-button" disabled={disabled} onClick={onRetryCreation}>
          重试建立会话
        </button>
      ) : null}
      {!models.length && !loading && onRefresh ? (
        <button className="library-button" disabled={disabled} onClick={onRefresh}>
          重新检测
        </button>
      ) : null}
    </div>
  );
}
