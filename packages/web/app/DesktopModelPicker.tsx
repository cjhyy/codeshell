import React from "react";
import type { MobileRuntimeModel } from "../src/hooks/useRemoteApp.js";
import { ModelChoicePicker, type ModelChoice } from "./ModelChoicePicker.js";

/** Persisted provider identity also covers sessions saved without a model alias. */
export function desktopRuntimeModel(session?: { model?: string; provider?: string }): string {
  if (/^(codex|claude-code)\//.test(session?.model ?? "")) return session!.model!;
  if (session?.provider === "codex" || session?.provider === "claude-code")
    return `${session.provider}/${session.model ?? ""}`;
  return "";
}

export function DesktopModelPicker({
  models,
  value,
  defaultLabel,
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
  loading?: boolean;
  error?: string;
  disabled: boolean;
  onChange: (modelKey: string) => void;
  onRefresh?: () => void;
  onRetryCreation?: () => void;
}) {
  const choices: ModelChoice[] = [{ value: "", label: defaultLabel }];
  if (value && !models.some((model) => model.key === value))
    choices.push({ value, label: `${value} · 当前会话` });
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
