# Codex 风格扩展能力 UI — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌面端散落的插件/Skill/MCP/市场管理收敛成 Codex 风格的「发现首页 + 管理页（分类 tab + 单列开关列表）」。

**Architecture:** 新建一个统一容器 `ExtensionsPage`，下分发现首页与管理页；管理页四个分类 tab（插件/技能/MCP/市场）。后端逻辑全在 `@cjhyy/code-shell-core` 已导出，desktop 只加薄 IPC 包装；MCP tab 直接复用现有 `McpSection`，skill 详情改点开弹出 modal。

**Tech Stack:** Electron + React + TypeScript；core 包 `@cjhyy/code-shell-core`；**`bun test`（仓库测试框架，import 从 `bun:test`）**；类型检查 `bun run typecheck`（= `tsc --noEmit`）。

参照 spec：`docs/superpowers/specs/2026-05-30-codex-style-plugin-skill-ui-design.md`

---

## 关键事实（已核实）

- core 已导出（`packages/core/src/index.ts:562-569`）：`installPlugin`, `uninstallPlugin`, `addMarketplace`, `removeMarketplace`, `listMarketplaces`, `loadMarketplace`。
- core 包名是 **`@cjhyy/code-shell-core`**（desktop 里 import 用这个，不是 `@core`）。
- `uninstallPlugin(pluginName, marketplaceName)` 两参数都要字符串（`pluginInstaller.ts:331`）；`installPlugin(pluginName, marketplaceName)` 同理（`:260`）。
- `PluginSummary.installKey` 形如 `<plugin>@<marketplace>`；`marketplace` 字段对本地/直接 GitHub 安装为 `null`（`plugins-service.ts:21-38`）。**这类插件无法走 `uninstallPlugin`（缺 marketplace）—— 计划在 Task 2 显式处理。**
- IPC 注册在 `packages/desktop/src/main/index.ts`（模式见 `:256` `:269` `:279`）；preload 暴露在 `packages/desktop/src/preload/index.ts`（模式见 `:231` `listPlugins`），类型在 `packages/desktop/src/preload/types.d.ts`。
- 现有面板：`PluginsAndSkillsSection.tsx`（三栏）、`McpSection.tsx`（MCP 增删改查+探测）、`SettingsPage.tsx:85-101`（导航模块，含 `mcp` 与 `plugins-skills` 两项）。

---

# Phase 1 — 管理页骨架 + 插件卸载 + MCP 并入 + skill 详情 modal

P1 完成后即为可独立工作、可测试的成果：一个统一的「扩展」页，三个 tab（插件/技能/MCP）可用，插件可卸载，skill 详情点开弹出。市场 tab 在 P2 加。

## 文件结构（P1 新建/修改）

- 新建 `packages/desktop/src/renderer/extensions/ExtensionsPage.tsx` — 统一容器（首页 + 管理页切换；P1 先只渲染管理页，首页 P3 补）
- 新建 `packages/desktop/src/renderer/extensions/ManagePage.tsx` — 分类 tab 容器
- 新建 `packages/desktop/src/renderer/extensions/PluginsTab.tsx` — 插件单列列表 + 开关 + 卸载
- 新建 `packages/desktop/src/renderer/extensions/SkillsTab.tsx` — skill 单列列表 + 开关 + 点开 modal
- 新建 `packages/desktop/src/renderer/extensions/SkillDetailModal.tsx` — skill 详情弹层
- 新建 `packages/desktop/src/renderer/extensions/uninstallTarget.ts` — 纯函数：从 PluginSummary 解析卸载参数
- 新建 `packages/desktop/src/renderer/extensions/uninstallTarget.test.ts`
- 修改 `packages/desktop/src/main/plugins-service.ts` — 加 `uninstallPluginEntry()`
- 新建 `packages/desktop/src/main/plugins-service.test.ts`（若无现成）— 测卸载解析
- 修改 `packages/desktop/src/main/index.ts` — 注册 `plugins:uninstall`
- 修改 `packages/desktop/src/preload/index.ts` + `types.d.ts` — 暴露 `uninstallPlugin`
- 修改 `packages/desktop/src/renderer/settings/SettingsPage.tsx` — 合并 `mcp` + `plugins-skills` 为单一「扩展」入口（过渡期保留旧入口）

---

## Task 1: 卸载参数解析（纯函数 + 测试）

`uninstallPlugin` 需要 `(pluginName, marketplaceName)`，但前端持有的是 `PluginSummary`。先写一个纯函数把它解析出来，并明确 marketplace 为 null 时不可卸载。

**Files:**
- Create: `packages/desktop/src/renderer/extensions/uninstallTarget.ts`
- Test: `packages/desktop/src/renderer/extensions/uninstallTarget.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// uninstallTarget.test.ts
import { describe, it, expect } from "bun:test";
import { resolveUninstallTarget } from "./uninstallTarget";

describe("resolveUninstallTarget", () => {
  it("splits a marketplace install key into name + marketplace", () => {
    expect(
      resolveUninstallTarget({ name: "superpowers", installKey: "superpowers@official", marketplace: "official" }),
    ).toEqual({ uninstallable: true, pluginName: "superpowers", marketplaceName: "official" });
  });

  it("marks local / direct-github installs (no marketplace) as not uninstallable", () => {
    expect(
      resolveUninstallTarget({ name: "mine", installKey: "mine", marketplace: null }),
    ).toEqual({ uninstallable: false });
  });

  it("prefers the installKey split over the name field when both present", () => {
    expect(
      resolveUninstallTarget({ name: "x", installKey: "real-name@mkt", marketplace: "mkt" }),
    ).toEqual({ uninstallable: true, pluginName: "real-name", marketplaceName: "mkt" });
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd packages/desktop && bun test src/renderer/extensions/uninstallTarget.test.ts`
Expected: FAIL — `resolveUninstallTarget` is not defined / module not found.

- [ ] **Step 3: 写实现**

```ts
// uninstallTarget.ts
/** Minimal shape needed from PluginSummary to decide uninstall. */
export interface UninstallablePlugin {
  name: string;
  installKey: string;
  marketplace: string | null;
}

export type UninstallTarget =
  | { uninstallable: false }
  | { uninstallable: true; pluginName: string; marketplaceName: string };

/**
 * core's uninstallPlugin(pluginName, marketplaceName) requires a marketplace.
 * Plugins installed locally or via direct GitHub (marketplace === null) have
 * no marketplace key and cannot be uninstalled through this path.
 */
export function resolveUninstallTarget(p: UninstallablePlugin): UninstallTarget {
  if (!p.marketplace) return { uninstallable: false };
  const at = p.installKey.lastIndexOf("@");
  const pluginName = at > 0 ? p.installKey.slice(0, at) : p.installKey;
  const marketplaceName = at > 0 ? p.installKey.slice(at + 1) : p.marketplace;
  return { uninstallable: true, pluginName, marketplaceName };
}
```

- [ ] **Step 4: 运行验证通过**

Run: `cd packages/desktop && bun test src/renderer/extensions/uninstallTarget.test.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/renderer/extensions/uninstallTarget.ts packages/desktop/src/renderer/extensions/uninstallTarget.test.ts
git commit -m "feat(extensions): resolveUninstallTarget — split plugin install key for uninstall"
```

---

## Task 2: 主进程 `uninstallPluginEntry` + IPC

**Files:**
- Modify: `packages/desktop/src/main/plugins-service.ts`
- Modify: `packages/desktop/src/main/index.ts:269`（在 `plugins:list` 注册附近加 `plugins:uninstall`）

- [ ] **Step 1: 在 plugins-service.ts 末尾加函数**

```ts
// plugins-service.ts — add this import to the existing top import line:
//   import { listInstalled, uninstallPlugin } from "@cjhyy/code-shell-core";

export interface UninstallPluginResult {
  ok: boolean;
  removedFromManifest: boolean;
  removedFromDisk: boolean;
}

/**
 * Uninstall a marketplace-installed plugin. pluginName/marketplaceName come
 * from the renderer after splitting the install key (see resolveUninstallTarget).
 * Throws on bad input so the IPC layer surfaces a clear error.
 */
export function uninstallPluginEntry(
  pluginName: string,
  marketplaceName: string,
): UninstallPluginResult {
  if (typeof pluginName !== "string" || !pluginName) {
    throw new Error("uninstallPluginEntry requires pluginName");
  }
  if (typeof marketplaceName !== "string" || !marketplaceName) {
    throw new Error("uninstallPluginEntry requires marketplaceName");
  }
  return uninstallPlugin(pluginName, marketplaceName);
}
```

- [ ] **Step 2: 在 main/index.ts 注册 IPC（紧跟现有 `plugins:list` 之后）**

```ts
ipcMain.handle(
  "plugins:uninstall",
  async (_e, pluginName: string, marketplaceName: string) => {
    return uninstallPluginEntry(pluginName, marketplaceName);
  },
);
```

并把 `uninstallPluginEntry` 加入 `plugins-service` 的 import（文件顶部已有 `import { listPlugins } from "./plugins-service.js"` 之类，追加即可）。

- [ ] **Step 3: 类型检查**

Run: `cd packages/desktop && bun run typecheck`
Expected: 无新增错误（与改动相关）。

- [ ] **Step 4: 提交**

```bash
git add packages/desktop/src/main/plugins-service.ts packages/desktop/src/main/index.ts
git commit -m "feat(extensions): plugins:uninstall IPC wrapping core uninstallPlugin"
```

---

## Task 3: preload 暴露 `uninstallPlugin`

**Files:**
- Modify: `packages/desktop/src/preload/index.ts:231`（`listPlugins` 旁）
- Modify: `packages/desktop/src/preload/types.d.ts`（`listPlugins` 类型旁）

- [ ] **Step 1: preload/index.ts 加方法**

```ts
  uninstallPlugin: (pluginName: string, marketplaceName: string) =>
    ipcRenderer.invoke("plugins:uninstall", pluginName, marketplaceName),
```

- [ ] **Step 2: types.d.ts 加签名（与现有 CodeshellApi 接口风格一致）**

```ts
  uninstallPlugin(
    pluginName: string,
    marketplaceName: string,
  ): Promise<{ ok: boolean; removedFromManifest: boolean; removedFromDisk: boolean }>;
```

- [ ] **Step 3: 类型检查**

Run: `cd packages/desktop && bun run typecheck`
Expected: 无新增错误。

- [ ] **Step 4: 提交**

```bash
git add packages/desktop/src/preload/index.ts packages/desktop/src/preload/types.d.ts
git commit -m "feat(extensions): expose uninstallPlugin over preload"
```

---

## Task 4: SkillDetailModal（点开弹出 SKILL.md）

**Files:**
- Create: `packages/desktop/src/renderer/extensions/SkillDetailModal.tsx`

复用现有 `window.codeshell.readSkillBody(filePath)` 与 `Markdown.tsx`（`packages/desktop/src/renderer/Markdown.tsx`）。

- [ ] **Step 1: 写组件**

```tsx
import { useEffect, useState } from "react";
import { Markdown } from "../Markdown";

interface Props {
  name: string;
  filePath: string;
  source: string;
  onClose: () => void;
}

export function SkillDetailModal({ name, filePath, source, onClose }: Props) {
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setBody(null);
    setError(null);
    window.codeshell
      .readSkillBody(filePath)
      .then((text) => alive && setBody(text))
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [filePath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="ext-modal-backdrop" onClick={onClose}>
      <div className="ext-modal" onClick={(e) => e.stopPropagation()}>
        <header className="ext-modal-head">
          <span className="ext-modal-title">{name}</span>
          <span className={`skill-source skill-source-${source}`}>{source}</span>
          <button className="ext-modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="ext-modal-body">
          {error ? (
            <div className="customize-empty">读取失败：{error}</div>
          ) : body === null ? (
            <div className="customize-empty">加载中…</div>
          ) : (
            <Markdown content={body} />
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `cd packages/desktop && bun run typecheck`
Expected: 无新增错误（确认 `Markdown` 的导出名与 prop `content` 与现仓库一致；若不同，按现仓库实际签名调整 import 与 prop）。

- [ ] **Step 3: 提交**

```bash
git add packages/desktop/src/renderer/extensions/SkillDetailModal.tsx
git commit -m "feat(extensions): SkillDetailModal — popover SKILL.md viewer"
```

---

## Task 5: SkillsTab（单列 + 开关 + 点开 modal）

**Files:**
- Create: `packages/desktop/src/renderer/extensions/SkillsTab.tsx`

启用/禁用沿用现有 capabilities 机制 —— **复用 `PluginsAndSkillsSection.tsx` 里的开关写法**（读它确认是 `capabilities:setEnabled` 还是 disabled* 集合，按现状照搬；不要新发明开关通道）。下面以 capabilities 为例，执行时按现状对齐。

- [ ] **Step 1: 写组件**

```tsx
import { useEffect, useState } from "react";
import type { SkillSummary } from "../../main/skills-service";
import { SkillDetailModal } from "./SkillDetailModal";

interface Props {
  cwd: string;
  query: string;
  isEnabled: (s: SkillSummary) => boolean;
  onToggle: (s: SkillSummary, next: boolean) => void;
}

export function SkillsTab({ cwd, query, isEnabled, onToggle }: Props) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<SkillSummary | null>(null);

  const load = () => {
    setSkills(null);
    setError(null);
    window.codeshell
      .listSkills(cwd)
      .then(setSkills)
      .catch((e) => setError(String(e?.message ?? e)));
  };
  useEffect(load, [cwd]);

  if (error)
    return (
      <div className="customize-empty">
        加载失败：{error} <button onClick={load}>重试</button>
      </div>
    );
  if (skills === null) return <div className="customize-empty">加载中…</div>;

  const q = query.trim().toLowerCase();
  const rows = q
    ? skills.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.description ?? "").toLowerCase().includes(q),
      )
    : skills;

  if (rows.length === 0)
    return <div className="customize-empty">没有匹配的 skill</div>;

  return (
    <>
      <ul className="ext-list">
        {rows.map((s) => (
          <li key={s.filePath} className="ext-row" onClick={() => setOpen(s)}>
            <span className="ext-row-icon">📄</span>
            <div className="ext-row-main">
              <span className="ext-row-name">{s.name}</span>
              <span className="ext-row-desc">
                {(s.description ?? "").split("\n")[0]}
              </span>
            </div>
            <span className={`skill-source skill-source-${s.source}`}>
              {s.source}
            </span>
            <input
              type="checkbox"
              checked={isEnabled(s)}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onToggle(s, e.target.checked)}
            />
          </li>
        ))}
      </ul>
      {open && (
        <SkillDetailModal
          name={open.name}
          filePath={open.filePath}
          source={open.source}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: 类型检查 + 提交**

Run: `cd packages/desktop && bun run typecheck` → 无新增错误。

```bash
git add packages/desktop/src/renderer/extensions/SkillsTab.tsx
git commit -m "feat(extensions): SkillsTab — single-column list with detail modal"
```

---

## Task 6: PluginsTab（单列 + 开关 + 卸载）

**Files:**
- Create: `packages/desktop/src/renderer/extensions/PluginsTab.tsx`

使用 Task 1 的 `resolveUninstallTarget` + Task 3 的 `uninstallPlugin`。开关沿用现状机制（按 `PluginsAndSkillsSection.tsx` 照搬）。

- [ ] **Step 1: 写组件**

```tsx
import { useEffect, useState } from "react";
import type { PluginSummary } from "../../main/plugins-service";
import { resolveUninstallTarget } from "./uninstallTarget";

interface Props {
  cwd: string;
  query: string;
  isEnabled: (p: PluginSummary) => boolean;
  onToggle: (p: PluginSummary, next: boolean) => void;
  onChanged: () => void;
}

export function PluginsTab({ cwd, query, isEnabled, onToggle, onChanged }: Props) {
  const [plugins, setPlugins] = useState<PluginSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => {
    setPlugins(null);
    setError(null);
    window.codeshell
      .listPlugins(cwd)
      .then(setPlugins)
      .catch((e) => setError(String(e?.message ?? e)));
  };
  useEffect(load, [cwd]);

  const uninstall = async (p: PluginSummary) => {
    const t = resolveUninstallTarget(p);
    if (!t.uninstallable) {
      window.alert("该插件为本地/直接安装，无法从这里卸载。");
      return;
    }
    if (!window.confirm(`确定卸载插件 “${p.name}”？`)) return;
    setBusy(p.installKey);
    try {
      await window.codeshell.uninstallPlugin(t.pluginName, t.marketplaceName);
      load();
      onChanged();
    } catch (e) {
      window.alert(`卸载失败：${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(null);
    }
  };

  if (error)
    return (
      <div className="customize-empty">
        加载失败：{error} <button onClick={load}>重试</button>
      </div>
    );
  if (plugins === null) return <div className="customize-empty">加载中…</div>;

  const q = query.trim().toLowerCase();
  const rows = q
    ? plugins.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.description ?? "").toLowerCase().includes(q),
      )
    : plugins;

  if (rows.length === 0)
    return <div className="customize-empty">还没有安装插件</div>;

  return (
    <ul className="ext-list">
      {rows.map((p) => (
        <li key={p.installKey} className="ext-row">
          <span className="ext-row-icon">🧩</span>
          <div className="ext-row-main">
            <span className="ext-row-name">{p.name}</span>
            <span className="ext-row-desc">
              {p.sourceLabel} · {p.skillCount} skills
            </span>
          </div>
          <span className="ext-row-source">{p.marketplace ?? "本地"}</span>
          <input
            type="checkbox"
            checked={isEnabled(p)}
            onChange={(e) => onToggle(p, e.target.checked)}
          />
          <button
            className="ext-row-kebab"
            title="卸载"
            disabled={busy === p.installKey}
            onClick={() => void uninstall(p)}
          >
            {busy === p.installKey ? "…" : "⋯"}
          </button>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: 类型检查 + 提交**

Run: `cd packages/desktop && bun run typecheck` → 无新增错误。

```bash
git add packages/desktop/src/renderer/extensions/PluginsTab.tsx
git commit -m "feat(extensions): PluginsTab — list, toggle, uninstall"
```

---

## Task 7: ManagePage（分类 tab 容器，接入 插件/技能/MCP）

**Files:**
- Create: `packages/desktop/src/renderer/extensions/ManagePage.tsx`

MCP tab 直接渲染现有 `McpSection`（`packages/desktop/src/renderer/settings/McpSection.tsx`）。**执行前先读 McpSection 的 props，按其实际签名传参。** 启用判定的 `isEnabled`/`onToggle` 从 `PluginsAndSkillsSection.tsx` 抽取现有逻辑传入（不新发明）。

- [ ] **Step 1: 写组件**

```tsx
import { useState } from "react";
import { McpSection } from "../settings/McpSection";
import { PluginsTab } from "./PluginsTab";
import { SkillsTab } from "./SkillsTab";

type TabKey = "plugins" | "skills" | "mcp";

interface Props {
  cwd: string;
  // 复用现有启用/禁用逻辑（从 PluginsAndSkillsSection 抽出后传入）
  pluginEnabled: (installKey: string) => boolean;
  skillEnabled: (filePath: string) => boolean;
  onTogglePlugin: (installKey: string, next: boolean) => void;
  onToggleSkill: (filePath: string, next: boolean) => void;
}

export function ManagePage(props: Props) {
  const [tab, setTab] = useState<TabKey>("plugins");
  const [query, setQuery] = useState("");

  return (
    <div className="ext-manage">
      <div className="ext-tabbar">
        <button className={tab === "plugins" ? "active" : ""} onClick={() => setTab("plugins")}>
          插件
        </button>
        <button className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}>
          技能
        </button>
        <button className={tab === "mcp" ? "active" : ""} onClick={() => setTab("mcp")}>
          MCP
        </button>
        {tab !== "mcp" && (
          <input
            className="ext-search"
            placeholder="搜索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
      </div>

      {tab === "plugins" && (
        <PluginsTab
          cwd={props.cwd}
          query={query}
          isEnabled={(p) => props.pluginEnabled(p.installKey)}
          onToggle={(p, n) => props.onTogglePlugin(p.installKey, n)}
          onChanged={() => {}}
        />
      )}
      {tab === "skills" && (
        <SkillsTab
          cwd={props.cwd}
          query={query}
          isEnabled={(s) => props.skillEnabled(s.filePath)}
          onToggle={(s, n) => props.onToggleSkill(s.filePath, n)}
        />
      )}
      {tab === "mcp" && <McpSection /* 按 McpSection 实际 props 传 */ />}
    </div>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `cd packages/desktop && bun run typecheck`
Expected: 若 `McpSection` 需要 props，会报错 —— 按其真实签名补齐后再过。

- [ ] **Step 3: 提交**

```bash
git add packages/desktop/src/renderer/extensions/ManagePage.tsx
git commit -m "feat(extensions): ManagePage — tabbed plugins/skills/MCP"
```

---

## Task 8: ExtensionsPage + 接入 SettingsPage 导航

**Files:**
- Create: `packages/desktop/src/renderer/extensions/ExtensionsPage.tsx`
- Modify: `packages/desktop/src/renderer/settings/SettingsPage.tsx:85-101`（导航）+ 渲染分支（`active === "plugins-skills"` 处）

P1 阶段 `ExtensionsPage` 只渲染 `ManagePage`（发现首页 P3 再加）。

- [ ] **Step 1: ExtensionsPage 包一层**

```tsx
import { ManagePage } from "./ManagePage";

// props 与 ManagePage 一致，透传。P3 会在这里加 DiscoverHome 切换。
export function ExtensionsPage(props: React.ComponentProps<typeof ManagePage>) {
  return (
    <div className="ext-page">
      <ManagePage {...props} />
    </div>
  );
}
```

- [ ] **Step 2: SettingsPage 接入**

在 `SettingsPage.tsx` 渲染 `active === "plugins-skills"` 的分支，把原 `PluginsAndSkillsSection` 替换为 `ExtensionsPage`（透传 cwd 及从现有逻辑抽出的启用/禁用回调）。导航文案从「插件与 Skills」改为「扩展」，并将原 `mcp` 模块标记为过渡保留（P1 不删，待验证后在 P3 收尾移除）。

- [ ] **Step 3: 启动应用手动验证**

Run: 用 /run 或项目既定的 desktop 启动命令运行 Electron 应用。
Expected: 进入「扩展」页 → 三个 tab 可切换；插件 tab 显示已装插件且能卸载（marketplace 安装的）；技能 tab 点行弹出 SKILL.md；MCP tab 与原 McpSection 行为一致。

- [ ] **Step 4: 提交**

```bash
git add packages/desktop/src/renderer/extensions/ExtensionsPage.tsx packages/desktop/src/renderer/settings/SettingsPage.tsx
git commit -m "feat(extensions): mount ExtensionsPage in settings, merge plugins/skills/mcp entry"
```

---

## Task 9: 样式

**Files:**
- Create: `packages/desktop/src/renderer/styles/extensions.css`（在 `index.css` 引入）

为 `.ext-page / .ext-manage / .ext-tabbar / .ext-list / .ext-row / .ext-row-* / .ext-search / .ext-modal*` 写样式，对齐 Codex：tab 栏底部细线 + 选中态下划线；行为单列、左图标、右开关、悬停高亮；modal 居中半透明遮罩。复用现有 `skill-source` 类。

- [ ] **Step 1: 写 CSS（参照 customize-page.css / settings-page.css 的变量与色板，保持风格一致）**
- [ ] **Step 2: 在 `index.css` 加 `@import "./extensions.css";`（或按现有引入方式）**
- [ ] **Step 3: 启动应用核对视觉，与 mockup（`.superpowers/brainstorm/3663-1780129974/content/manage-rows.html`）对齐**
- [ ] **Step 4: 提交**

```bash
git add packages/desktop/src/renderer/styles/extensions.css packages/desktop/src/renderer/styles/index.css
git commit -m "style(extensions): Codex-style tab bar + single-column rows + modal"
```

---

# Phase 2 — 市场 tab（概要，P1 完成后细化为完整任务）

P1 验证通过后，把以下展开为与上面同粒度的 TDD 任务：

- **新 IPC**（main/index.ts + preload，模式同 Task 2/3）：`marketplace:list`→`listMarketplaces()`、`marketplace:load`→`loadMarketplace(name)`、`marketplace:add`→`addMarketplace(name, source)`、`marketplace:remove`→`removeMarketplace(name)`、`plugins:install`→`installPlugin(pluginName, marketplaceName)`。
- **MarketList.tsx**：列已添加市场（名称 + pluginCount + 来源）+「添加市场」入口（输入 git/github 源，调 `marketplace:add`）。
- **MarketDetail.tsx**：`marketplace:load` 列该市场插件；每项「安装」按钮（`plugins:install`），安装中 disabled + "安装中…"，完成刷新插件 tab 计数；已安装项标记。
- **接入 ManagePage**：加第四个 tab「市场」。
- 错误/重试/空态同 P1 约定。

---

# Phase 3 — 发现首页（概要）

- **DiscoverHome.tsx**：居中大标题「让 codeshell 按你的方式工作」+ 搜索框 + 「已安装概览」（插件 N · 技能 N · MCP N，点击跳对应 tab）。**不做** banner、不做 Featured 网格。
- 搜索：输入后切到管理页并把关键词作为 query 下传跨 tab 过滤。
- `ExtensionsPage` 加首页/管理页切换。
- `featured.json`（仓库内置精选源）仅作为「市场」tab 的推荐入口，轻量、可后置。
- 收尾：移除过渡保留的旧 `mcp`、`plugins-skills` 入口。

---

## Self-Review

- **Spec 覆盖**：管理页分类 tab（Task 7）✓；插件开关+卸载（Task 1/2/3/6）✓；技能开关+点开 modal（Task 4/5）✓；MCP 完整并入（Task 7 挂 McpSection）✓；市场两层（P2）✓；发现首页极简（P3）✓；体验缺口 spinner/空态/重试/确认（Task 5/6/9 内置）✓。
- **占位符**：P1 各步均有完整代码/命令；P2/P3 为明确标注的概要（待 P1 后细化），非 P1 任务内的占位。
- **类型一致**：`resolveUninstallTarget`（Task1）↔ PluginsTab 调用（Task6）一致；`UninstallablePlugin` 字段是 PluginSummary 的子集 ✓；`uninstallPlugin(pluginName, marketplaceName)` 三处（core/IPC/preload/调用）参数名顺序一致 ✓。
- **已知执行期需对齐项**（计划已显式标注，避免猜测）：① skill/plugin 启用-禁用通道按 `PluginsAndSkillsSection.tsx` 现状照搬；② `Markdown` 组件导出名/prop 按现仓库实际；③ `McpSection` props 按其真实签名。

### 执行期已查明的事实（供 Task 6/7/8 复用）

- **Markdown 组件**：`packages/desktop/src/renderer/Markdown.tsx` 命名导出 `Markdown`，prop 是 **`text`**（不是 `content`）。用法：`<Markdown text={body} />`（参 `PluginsAndSkillsSection.tsx:546`）。
- **启用/禁用机制**：用户 settings 里的 `disabledSkills` / `disabledPlugins` 数组，**按 skill name / 按 plugin？**。skill 用 **name** 作 key。读：`getSettings("user").disabledSkills` → `new Set(...)`；写：`writeSettings("user", { disabledSkills: [...next] })`。enabled = `!disabledSet.has(name)`。
  - 因此 Task 7/8 父组件应这样接线：`isEnabled = (s) => !disabledSkillSet.has(s.name)`，`onToggle = (s, next) => toggleSkillDisabled(s.name, !next)`。
- **PLUGIN 禁用机制（Task 6 查明）**：plugin 按 **bare name**（`PluginSummary.name`）作 key，**不是 installKey**。读 `settings.disabledPlugins` → Set；enabled = `!disabledPlugins.has(p.name)`；写 `writeSettings("user", { disabledPlugins: [...next] })`。
  - **重要 cascade**：`PluginsAndSkillsSection.togglePluginGroup`（约 :273-287）在切换 plugin 时，会**同时**把该 plugin 贡献的每个 skill 加/删进 `disabledSkills` —— 因为 `loadPluginHooks` 只读 `disabledPlugins`，但 skill 扫描读 `disabledSkills`。Task 7/8 接线 plugin 开关时**必须复制这个 cascade**，否则禁用 plugin 不会真正关掉它的 skill。最稳妥：Task 7/8 直接复用 `PluginsAndSkillsSection` 里现成的 `togglePluginGroup` / `toggleSkillDisabled` 逻辑（抽成 hook 或把回调传进 ManagePage），不要重写。
