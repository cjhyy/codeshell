import React from "react";
import type { RemoteApp } from "../src/hooks/useRemoteApp.js";
import { ModelChoicePicker, type ModelChoice } from "./ModelChoicePicker.js";
import { cliSessionControlBlock } from "./cliSessionControls.js";

export function DesktopCliModelPicker({ app, busy = false }: { app: RemoteApp; busy?: boolean }) {
  const room = app.activeRoom;
  const supported = app.ccRoomModelSelection && !!app.setCcRoomModel;
  const blocked = busy ? "正在发送消息，完成后可调整。" : cliSessionControlBlock(app);
  const models = (app.runtimeModels ?? []).filter((model) => model.kind === room?.kind);
  const value = room?.modelKey ?? "";
  const choices: ModelChoice[] = [{ value: "", label: "CLI 默认模型" }];
  if (value && !models.some((model) => model.key === value))
    choices.push({ value, label: `${value} · 当前模型`, disabled: true });
  choices.push(...models.map((model) => ({ value: model.key, label: model.label })));
  return (
    <div className="desktop-model-picker desktop-cli-model-picker">
      <ModelChoicePicker
        className="model-button"
        label="选择 CLI 模型"
        value={value}
        choices={choices}
        disabled={!!blocked || !supported}
        status={
          app.runtimeModelsError ||
          (app.runtimeModelsLoading
            ? "正在读取可用模型…"
            : !models.length
              ? "尚未读取到可选模型，可使用 CLI 默认模型。"
              : "切换后从下一条消息开始生效。")
        }
        onChange={(next) => {
          if (!blocked && supported && next !== value) app.setCcRoomModel?.(next || null);
        }}
      />
      {room && !supported ? (
        <span className="desktop-model-note" role="note">
          更新电脑端后可切换 CLI 模型。
        </span>
      ) : !models.length && !app.runtimeModelsLoading && app.refreshRuntimeModels ? (
        <button className="library-button" disabled={!!blocked} onClick={app.refreshRuntimeModels}>
          重新检测模型
        </button>
      ) : null}
    </div>
  );
}
