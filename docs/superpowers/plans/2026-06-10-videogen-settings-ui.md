# 视频生成配置 UI 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** 把 desktop 设置页「视频生成」空壳换成真配置面板,通过把图片面板抽成泛型 `GenConnectionsPanel` 复用;纯 renderer 改动。

**Architecture:** 提取 `GenConnectionsPanel`(泛型,config 注入差异)→ `ImageGenConnectionsPanel`/`VideoGenConnectionsPanel` 各自薄封装调它。video 预置 fal(可配)+ 即梦(disabled 占位),无测试按钮。

**Tech Stack:** React + TypeScript,desktop renderer(无 core import,经 window.codeshell.*),shadcn Button + 现有 conn-card class。

**约束:**
- subagent **不动 git**。
- desktop 有独立检查:改完必在 `packages/desktop` 跑 `bunx tsc --noEmit` 和 `bun run build:renderer`(根目录不覆盖)。
- **动了图片面板 → 必须保证图片面板不回归**(openai/google 可配、测试生图、保存、设默认、清除)。
- renderer 不 import `@cjhyy/code-shell-core`。

---

## 关键参考:现有 ImageGenConnectionsPanel 结构

`packages/desktop/src/renderer/settings/ImageGenConnectionsPanel.tsx`(347 行)关键点:
- `type Kind = "openai" | "google"`,硬编码 `PROVIDERS: ProviderMeta[]`(2 个)
- `ProviderMeta`: { id, kind, displayName, description, defaultBaseUrl, defaultModel, signupUrl? }
- `ProviderState`: { apiKey, baseUrl, model, probe?, testing, saving, showKey, dirty }
- 组件:`ImageGenConnectionsPanel({scope, activeRepoPath})` 持 `byProvider: Record<Kind, ProviderState>` + `defaultProvider`
- 读 `load()`:getSettings → `imageGen.providers[]` → 按 id 匹配填入
- 写 `writeBack(next, nextDefault)`:`writeSettings(scope, { imageGen: { defaultProvider, providers } }, cwd)`,只持久化有 apiKey 的
- 动作:`save`/`clear`/`test`(调 `window.codeshell.probeImage`)/`setDefault`
- 渲染:`.connections-card-grid` 容器 → 每 provider 一个 `ImageGenCard`(class `conn-card`)
- Card 内:API Key(密码框+显示切换)、Base URL、默认模型 三个 `.settings-field`;footer 有 测试/保存/设为默认/清除 按钮;test ok 时显示 `previewDataUrl` 预览

video 与 image 差异:settingsKey、providers 列表、无 test 按钮、有 disabled 占位卡。

---

## Task 1: 提取泛型 GenConnectionsPanel(承载 image 现有行为)

**Files:**
- Create: `packages/desktop/src/renderer/settings/GenConnectionsPanel.tsx`

- [ ] **Step 1: 新建 GenConnectionsPanel.tsx,定义 config 类型 + 泛化组件**

把 ImageGenConnectionsPanel 的全部逻辑搬进来,泛化掉 image 专属部分。完整内容:

```tsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ImageProbeResult } from "../../preload/types";
import { writeSettings } from "../settingsBus";
import { Button } from "@/components/ui/button";

/** Probe result shape (reused from image probe; video has no probe → unused). */
export type ProbeResult = ImageProbeResult;

export interface ProviderMeta {
  /** Instance id stored in <settingsKey>.providers[].id. v1: one instance per kind. */
  id: string;
  kind: string;
  displayName: string;
  description: string;
  defaultBaseUrl: string;
  defaultModel: string;
  signupUrl?: string;
  /** Placeholder card: rendered greyed-out, all inputs/buttons disabled. */
  disabled?: boolean;
  /** Coming-soon note shown on a disabled card. */
  comingSoonNote?: string;
}

export interface GenPanelConfig {
  /** settings.<settingsKey>.providers[] */
  settingsKey: "imageGen" | "videoGen";
  providers: ProviderMeta[];
  /** Render the "test" button + probe UI (image) vs not (video). */
  showTest: boolean;
  /** Probe function used when showTest; required if showTest. */
  testFn?: (input: { kind: string; apiKey?: string; baseUrl?: string; model?: string }) => Promise<ProbeResult>;
  labels: {
    testIdle: string;   // e.g. "测试生图"
    testBusy: string;   // e.g. "生成中…"
    testTitleConfigured: string; // tooltip when configured
    keyHint: string;    // field hint under API key
  };
}

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
  config: GenPanelConfig;
}

interface ProviderState {
  apiKey: string;
  baseUrl: string;
  model: string;
  probe?: ProbeResult;
  testing: boolean;
  saving: boolean;
  showKey: boolean;
  dirty: boolean;
}

const initialState = (meta: ProviderMeta): ProviderState => ({
  apiKey: "",
  baseUrl: meta.defaultBaseUrl,
  model: meta.defaultModel,
  testing: false,
  saving: false,
  showKey: false,
  dirty: false,
});

function isProbeResult(value: unknown): value is ProbeResult {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    (rec.status === "ok" || rec.status === "error" || rec.status === "unconfigured") &&
    typeof rec.lastProbedAt === "string"
  );
}

export function GenConnectionsPanel({ scope, activeRepoPath, config }: Props) {
  const { settingsKey, providers, showTest, testFn, labels } = config;
  const firstConfigurable = providers.find((p) => !p.disabled) ?? providers[0];
  const [defaultProvider, setDefaultProvider] = useState<string>(firstConfigurable?.id ?? "");
  const buildInitial = useCallback((): Record<string, ProviderState> => {
    const m: Record<string, ProviderState> = {};
    for (const meta of providers) m[meta.id] = initialState(meta);
    return m;
  }, [providers]);
  const [byProvider, setByProvider] = useState<Record<string, ProviderState>>(buildInitial);
  const [loaded, setLoaded] = useState(false);
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const load = useCallback(async () => {
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    const gen = (s[settingsKey] && typeof s[settingsKey] === "object") ? (s[settingsKey] as Record<string, unknown>) : {};
    const list = Array.isArray(gen.providers) ? (gen.providers as Array<Record<string, unknown>>) : [];

    const next = buildInitial();
    for (const meta of providers) {
      if (meta.disabled) continue;
      const entry = list.find((p) => p.id === meta.id || (p.kind === meta.kind && !p.id));
      if (entry) {
        next[meta.id] = {
          ...next[meta.id],
          apiKey: typeof entry.apiKey === "string" ? entry.apiKey : "",
          baseUrl: typeof entry.baseUrl === "string" && entry.baseUrl ? entry.baseUrl : meta.defaultBaseUrl,
          model: typeof entry.defaultModel === "string" && entry.defaultModel ? entry.defaultModel : meta.defaultModel,
          probe: isProbeResult(entry.lastProbe) ? entry.lastProbe : undefined,
        };
      }
    }
    const dp = typeof gen.defaultProvider === "string" ? gen.defaultProvider : undefined;
    if (dp && providers.some((p) => p.id === dp && !p.disabled)) setDefaultProvider(dp);

    setByProvider(next);
    setLoaded(true);
  }, [scope, cwd, settingsKey, providers, buildInitial]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (id: string, patch: Partial<ProviderState>) => {
    setByProvider((cur) => ({ ...cur, [id]: { ...cur[id], ...patch } }));
  };

  const writeBack = useCallback(
    async (next: Record<string, ProviderState>, nextDefault: string) => {
      const providersOut: Array<Record<string, unknown>> = [];
      for (const meta of providers) {
        if (meta.disabled) continue;
        const st = next[meta.id];
        if (!st.apiKey) continue;
        const entry: Record<string, unknown> = {
          id: meta.id,
          kind: meta.kind,
          baseUrl: st.baseUrl || meta.defaultBaseUrl,
          apiKey: st.apiKey,
          defaultModel: st.model || meta.defaultModel,
        };
        if (st.probe) entry.lastProbe = st.probe;
        providersOut.push(entry);
      }
      await writeSettings(scope, { [settingsKey]: { defaultProvider: nextDefault, providers: providersOut } }, cwd);
    },
    [scope, cwd, settingsKey, providers],
  );

  const save = async (id: string) => {
    update(id, { saving: true });
    try {
      const next = { ...byProvider, [id]: { ...byProvider[id], saving: false, dirty: false } };
      await writeBack(next, defaultProvider);
      setByProvider(next);
    } catch (err) {
      console.error(`${settingsKey} save failed`, err);
      update(id, { saving: false });
    }
  };

  const clear = async (id: string) => {
    const meta = providers.find((p) => p.id === id)!;
    const next = { ...byProvider, [id]: initialState(meta) };
    setByProvider(next);
    try {
      await writeBack(next, defaultProvider);
    } catch (err) {
      console.error(`${settingsKey} clear failed`, err);
      void load();
    }
  };

  const test = async (id: string) => {
    if (!showTest || !testFn) return;
    const meta = providers.find((p) => p.id === id)!;
    const st = byProvider[id];
    update(id, { testing: true });
    try {
      const result = await testFn({
        kind: meta.kind,
        apiKey: st.apiKey || undefined,
        baseUrl: st.baseUrl || undefined,
        model: st.model || undefined,
      });
      const next = { ...byProvider, [id]: { ...byProvider[id], probe: result, testing: false } };
      setByProvider(next);
      if (result.status === "ok") await writeBack(next, defaultProvider);
    } catch (e) {
      update(id, {
        probe: {
          status: "error",
          errorMessage: String(e instanceof Error ? e.message : e),
          lastProbedAt: new Date().toISOString(),
        },
        testing: false,
      });
    }
  };

  const setDefault = async (id: string) => {
    setDefaultProvider(id);
    await writeBack(byProvider, id);
  };

  if (!loaded) {
    return <div className="connections-card-grid"><div className="view-loading">加载中…</div></div>;
  }

  return (
    <div className="connections-card-grid">
      {providers.map((meta) => {
        const st = byProvider[meta.id];
        const isDefault = defaultProvider === meta.id;
        const isConfigured = !!st.apiKey;
        return (
          <GenCard
            key={meta.id}
            meta={meta}
            state={st}
            isDefault={isDefault}
            isConfigured={isConfigured}
            showTest={showTest}
            labels={labels}
            onConfigChange={(patch) => update(meta.id, { ...patch, dirty: true, probe: undefined })}
            onUiChange={(patch) => update(meta.id, patch)}
            onSave={() => void save(meta.id)}
            onTest={() => void test(meta.id)}
            onClear={() => void clear(meta.id)}
            onSetDefault={() => void setDefault(meta.id)}
          />
        );
      })}
    </div>
  );
}

interface CardProps {
  meta: ProviderMeta;
  state: ProviderState;
  isDefault: boolean;
  isConfigured: boolean;
  showTest: boolean;
  labels: GenPanelConfig["labels"];
  onConfigChange: (patch: Partial<ProviderState>) => void;
  onUiChange: (patch: Partial<ProviderState>) => void;
  onSave: () => void;
  onTest: () => void;
  onClear: () => void;
  onSetDefault: () => void;
}

function GenCard({
  meta, state, isDefault, isConfigured, showTest, labels,
  onConfigChange, onUiChange, onSave, onTest, onClear, onSetDefault,
}: CardProps) {
  const disabled = !!meta.disabled;
  const statusPill = useMemo(() => {
    if (disabled) return <span className="conn-pill unknown">即将支持</span>;
    if (showTest && state.testing) return <span className="conn-pill probing">生成测试中…</span>;
    if (showTest && state.probe?.status === "ok") return <span className="conn-pill ok">可用</span>;
    if (showTest && state.probe?.status === "error") return <span className="conn-pill err">生成失败</span>;
    if (!isConfigured) return <span className="conn-pill unknown">未配置</span>;
    return <span className="conn-pill unknown">已配置</span>;
  }, [disabled, showTest, state.testing, state.probe, isConfigured]);

  if (disabled) {
    return (
      <article className="conn-card" style={{ opacity: 0.6 }}>
        <header className="conn-card-head">
          <div className="conn-card-title">
            <strong>{meta.displayName}</strong>
            {statusPill}
          </div>
        </header>
        <p className="conn-card-desc">{meta.comingSoonNote ?? meta.description}</p>
      </article>
    );
  }

  return (
    <article className={`conn-card${isDefault ? " is-default" : ""}`}>
      <header className="conn-card-head">
        <div className="conn-card-title">
          <strong>{meta.displayName}</strong>
          {isDefault && <span className="conn-default-pill">默认</span>}
          {statusPill}
        </div>
        <div className="conn-card-head-actions">
          {meta.signupUrl && (
            <button className="conn-link-btn" onClick={() => void window.codeshell.openExternal(meta.signupUrl!)}>
              获取 key
            </button>
          )}
        </div>
      </header>

      <p className="conn-card-desc">{meta.description}</p>

      <div className="settings-form-grid">
        <label className="settings-field">
          <span>API Key</span>
          <div className="conn-secret-row">
            <input
              type={state.showKey ? "text" : "password"}
              value={state.apiKey}
              onChange={(e) => onConfigChange({ apiKey: e.target.value.trim() })}
              placeholder="粘贴 API key"
            />
            <button className="conn-secret-toggle" type="button" onClick={() => onUiChange({ showKey: !state.showKey })}>
              {state.showKey ? "隐藏" : "显示"}
            </button>
          </div>
          <span className="conn-field-hint">{labels.keyHint}</span>
        </label>
        <label className="settings-field">
          <span>Base URL</span>
          <input
            value={state.baseUrl}
            onChange={(e) => onConfigChange({ baseUrl: e.target.value.trim() })}
            placeholder={meta.defaultBaseUrl}
          />
        </label>
        <label className="settings-field">
          <span>默认模型</span>
          <input
            value={state.model}
            onChange={(e) => onConfigChange({ model: e.target.value.trim() })}
            placeholder={meta.defaultModel}
          />
        </label>
      </div>

      {showTest && state.probe?.status === "ok" && state.probe.previewDataUrl && (
        <div className="conn-probe-image">
          <div className="conn-probe-title">测试生成成功</div>
          <img src={state.probe.previewDataUrl} alt="probe preview" />
        </div>
      )}
      {showTest && state.probe?.status === "error" && <div className="conn-probe-err">{state.probe.errorMessage}</div>}

      <footer className="conn-card-footer">
        {showTest && (
          <Button variant="default" onClick={onTest} disabled={state.testing || !isConfigured} title={isConfigured ? labels.testTitleConfigured : "请先填写 API key"}>
            {state.testing ? labels.testBusy : labels.testIdle}
          </Button>
        )}
        <Button variant="solid" onClick={onSave} disabled={state.saving || !state.dirty}>
          {state.saving ? "保存中…" : "保存"}
        </Button>
        {isConfigured && !isDefault && (
          <Button variant="default" onClick={onSetDefault}>
            设为默认
          </Button>
        )}
        {isConfigured && (
          <Button variant="destructive" onClick={onClear}>
            清除
          </Button>
        )}
      </footer>
    </article>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit 2>&1 | tail -20`
Expected: 无错误(此时 GenConnectionsPanel 还没被引用,但应自洽编译)。
注意:`s[settingsKey]` 索引 settings 对象——若 getSettings 返回类型不支持 string 索引,用 `(s as Record<string, unknown>)[settingsKey]`。

---

## Task 2: ImageGenConnectionsPanel 改为薄封装

**Files:**
- Modify: `packages/desktop/src/renderer/settings/ImageGenConnectionsPanel.tsx`(整文件替换)

- [ ] **Step 1: 整文件替换为薄封装**

```tsx
import React from "react";
import { GenConnectionsPanel, type GenPanelConfig, type ProviderMeta } from "./GenConnectionsPanel";

const IMAGE_PROVIDERS: ProviderMeta[] = [
  {
    id: "openai",
    kind: "openai",
    displayName: "OpenAI Images (gpt-image)",
    description: "OpenAI 图像 API。需要 OpenAI key；baseUrl 默认官方端点。",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-image-2",
    signupUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "google",
    kind: "google",
    displayName: "Gemini Images (Nano Banana)",
    description:
      "Gemini 图像生成。可直接用你已有的 Google key；OpenAI 兼容 baseUrl（/v1beta/openai）也会被自动规范到原生端点。",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash-image",
    signupUrl: "https://aistudio.google.com/apikey",
  },
];

const IMAGE_CONFIG: GenPanelConfig = {
  settingsKey: "imageGen",
  providers: IMAGE_PROVIDERS,
  showTest: true,
  testFn: (input) => window.codeshell.probeImage(input),
  labels: {
    testIdle: "测试生图",
    testBusy: "生成中…",
    testTitleConfigured: "用当前配置真生成一张测试图",
    keyHint: "保存于 ~/.code-shell/settings.json，按 scope 隔离。",
  },
};

export function ImageGenConnectionsPanel({ scope, activeRepoPath }: { scope: "user" | "project"; activeRepoPath: string | null }) {
  return <GenConnectionsPanel scope={scope} activeRepoPath={activeRepoPath} config={IMAGE_CONFIG} />;
}
```

- [ ] **Step 2: typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit 2>&1 | tail -20`
Expected: 无错误。若 `window.codeshell.probeImage` 的入参类型与 `testFn` 签名不兼容,把 testFn 写成 `(input) => window.codeshell.probeImage(input as ImageProbeInput)` 并 import 该类型;或放宽 GenPanelConfig.testFn 入参为 `any`(最后手段)。

---

## Task 3: VideoGenConnectionsPanel 改为真面板(fal + 即梦占位)

**Files:**
- Modify: `packages/desktop/src/renderer/settings/VideoGenConnectionsPanel.tsx`(整文件替换)

- [ ] **Step 1: 整文件替换**

```tsx
import React from "react";
import { GenConnectionsPanel, type GenPanelConfig, type ProviderMeta } from "./GenConnectionsPanel";

const VIDEO_PROVIDERS: ProviderMeta[] = [
  {
    id: "fal",
    kind: "fal",
    displayName: "fal.ai (Kling 等)",
    description:
      "通过 fal.ai 统一 API 调用 Kling/字节等视频模型。需要 fal key；模型 id 决定底层模型与文生/图生。",
    defaultBaseUrl: "https://queue.fal.run",
    defaultModel: "fal-ai/kling-video/v3/pro/text-to-video",
    signupUrl: "https://fal.ai/dashboard/keys",
  },
  {
    id: "jimeng",
    kind: "jimeng",
    displayName: "即梦 / 火山引擎",
    description: "即梦同源视频模型。",
    defaultBaseUrl: "",
    defaultModel: "",
    disabled: true,
    comingSoonNote:
      "即将支持。core 已预留 videoGen schema 与 submit/poll/download 接口,待接入火山引擎 AK/SK 签名适配器后开放。",
  },
];

const VIDEO_CONFIG: GenPanelConfig = {
  settingsKey: "videoGen",
  providers: VIDEO_PROVIDERS,
  showTest: false,
  labels: {
    testIdle: "",
    testBusy: "",
    testTitleConfigured: "",
    keyHint: "保存于 ~/.code-shell/settings.json，按 scope 隔离。生成的视频较慢,提交后台轮询,完成会通知。",
  },
};

export function VideoGenConnectionsPanel({ scope, activeRepoPath }: { scope: "user" | "project"; activeRepoPath: string | null }) {
  return <GenConnectionsPanel scope={scope} activeRepoPath={activeRepoPath} config={VIDEO_CONFIG} />;
}
```

- [ ] **Step 2: typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit 2>&1 | tail -20`
Expected: 无错误。

---

## Task 4: 构建验证 + 回归自检

- [ ] **Step 1: desktop typecheck**

Run: `cd packages/desktop && bunx tsc --noEmit 2>&1 | tail -20`
Expected: 0 错误。

- [ ] **Step 2: desktop renderer build**

Run: `cd packages/desktop && bun run build:renderer 2>&1 | tail -15`
Expected: 构建成功(无 error;warning 可接受)。

- [ ] **Step 3: 回归自检(读代码确认)**

确认:
- `ImageGenConnectionsPanel.tsx`:IMAGE_CONFIG.settingsKey==="imageGen",showTest===true,testFn 调 probeImage,IMAGE_PROVIDERS 含 openai+google,均无 disabled。
- `VideoGenConnectionsPanel.tsx`:VIDEO_CONFIG.settingsKey==="videoGen",showTest===false,无 testFn,fal 可配 + jimeng disabled。
- `GenConnectionsPanel.tsx`:disabled 卡不写 settings、不渲染输入框;showTest:false 不渲染测试按钮。
- `SearchConnectionsPanel.tsx` 仍 import 并渲染 VideoGenConnectionsPanel(无需改)。

- [ ] **Step 4: 报告** —— subagent 贴出 tsc + build 真实输出,列改动文件,不 commit。

---

## 验证标准
- 新建 GenConnectionsPanel,image/video 各薄封装调用。
- desktop tsc --noEmit 0 错误;build:renderer 成功。
- 图片面板配置项不变(openai/google + 测试生图 + settingsKey imageGen)——回归自检通过。
- video 面板:fal 可配(默认 baseUrl/model 正确)+ 即梦 disabled 占位;无测试按钮。
- (人工,主代理验证)启动 desktop 进设置→连接→视频生成,看到 fal 配置卡 + 即梦灰态占位。
