# 设置中心信息架构统一(工作流 A)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置中心成为所有配置的单一信息架构:支持「全局 / 按项目」scope 切换,收编数字人、数据源、项目指令模块;项目配置页变为预选项目 scope 的同一套页面;侧边栏升设置为一级入口、移除「扩展」双门;删除死代码。

**Architecture:** `SettingsPage` 已有分组左导航,且各 section 组件已接受 `scope: "user" | "project"` + `activeProjectPath` props(现被硬编码为 `"user"`,见 `SettingsPage.tsx:202-205`)。本计划把 scope 变成页面级状态 + 顶部切换器,模块声明自己支持的 scope;新增三个模块(数字人/数据源/项目指令)复用现有组件;`ProjectConfigPage` 删除,`project_config` 路由改渲染预选项目 scope 的 `SettingsPage`。

**Tech Stack:** React 19 + shadcn/ui + Tailwind v4(见 `packages/desktop/CLAUDE.md`:必须用 `@/components/ui` 组件,语义 token,不写原生控件);测试是 bun test 的文件内容契约测试(仓库既有风格);i18n 词条在 `packages/desktop/src/renderer/i18n/ns/*.ts`。

**验证命令**(每个任务完成时跑):

```bash
cd packages/desktop && bun test src/renderer && bun run typecheck
```

所有路径相对 `packages/desktop/src/renderer/`,除非另有说明。

---

### Task 1: SettingsPage scope 模型 + 顶部切换器

**Files:**
- Modify: `settings/SettingsPage.tsx`
- Modify: `i18n/ns/settings.ts`(新增词条,zh + en 两处)
- Test: `settings/SettingsPage.scope.contract.test.ts`(新建)

- [ ] **Step 1: 写失败的契约测试**

新建 `settings/SettingsPage.scope.contract.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "SettingsPage.tsx"), "utf-8");

describe("SettingsPage scope contract", () => {
  test("scope is page state with a header switcher, not a hardcoded user constant", () => {
    expect(source).not.toContain('const scope = "user" as const');
    expect(source).toContain("SettingsScope");
    expect(source).toContain("scopeOptions");
  });

  test("modules declare supported scopes and the nav filters by the active scope", () => {
    expect(source).toContain("scopes:");
    expect(source).toContain("moduleSupportsScope");
  });

  test("project scope forwards the selected project path to sections", () => {
    expect(source).toContain("scopeProjectPath");
  });

  test("opening with an initial project preselects project scope", () => {
    expect(source).toContain("initialProjectPath");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/desktop && bun test src/renderer/settings/SettingsPage.scope.contract.test.ts`
Expected: FAIL(4 条断言均不满足)

- [ ] **Step 3: 实现 scope 模型**

在 `SettingsPage.tsx` 中:

3a. `ModuleDefinition` 增加 scopes 声明(在 `buildModuleGroups` 上方补类型;现有 module 对象逐个加 `scopes`):

```ts
type SettingsScopeKind = "user" | "project";
export type SettingsScope = { kind: "user" } | { kind: "project"; path: string };

interface ModuleDefinition {
  id: ModuleId;
  label: string;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  /** Which scopes this module can render in. Defaults to user-only. */
  scopes?: SettingsScopeKind[];
}

export function moduleSupportsScope(
  module: { scopes?: SettingsScopeKind[] },
  scope: SettingsScope,
): boolean {
  return (module.scopes ?? ["user"]).includes(scope.kind);
}
```

`buildModuleGroups` 中给以下模块加 `scopes: ["user", "project"]`:`general`、`config`、`model-catalog`、`personalization`、`mcp`、`connections`。其余模块不加(默认 user-only)。

3b. Props 增加:

```ts
interface Props {
  // ...现有字段不动...
  /** When set, open in project scope for this project (project_config route). */
  initialProjectPath?: string | null;
}
```

3c. 组件内用 scope state 替换硬编码(删除 L202-205 的 `const scope = "user" as const` 及其注释):

```tsx
const [scopeState, setScopeState] = useState<SettingsScope>(() =>
  initialProjectPath ? { kind: "project", path: initialProjectPath } : { kind: "user" },
);
// The selected project disappeared (removed from tracked list) → fall back to global.
useEffect(() => {
  if (scopeState.kind === "project" && !projects.some((p) => p.path === scopeState.path)) {
    setScopeState({ kind: "user" });
  }
}, [projects, scopeState]);
const scope: "user" | "project" = scopeState.kind;
const scopeProjectPath = scopeState.kind === "project" ? scopeState.path : null;
```

所有 section 渲染处把 `activeProjectPath={activeProjectPath}` 改为 `activeProjectPath={scopeProjectPath ?? activeProjectPath}`(project scope 时指向所选项目,全局时保留原行为)。

3d. 顶部切换器(header 区,替换 L382 固定的 `globalScope` Badge):

```tsx
const scopeOptions = [
  { value: "__user__", label: t("settingsX.page.scopeSwitchGlobal") },
  ...projects.map((project) => ({ value: project.path, label: projectLabel(project) })),
];
// header 内:
<SimpleSelect<string>
  value={scopeState.kind === "user" ? "__user__" : scopeState.path}
  options={scopeOptions}
  ariaLabel={t("settingsX.page.scopeSwitcher")}
  onChange={(value) =>
    setScopeState(value === "__user__" ? { kind: "user" } : { kind: "project", path: value })
  }
/>
```

需要 `import { SimpleSelect } from "@/components/ui/simple-select";` 与 `import { projectLabel } from "../projects";`。副标题 hint:project scope 时显示 `t("settingsX.page.projectScopeHint")`,全局时保留 `globalScopeHint`。

3e. 导航过滤:`filteredGroups` 的 filter 链前加 scope 过滤:

```ts
modules: group.modules.filter(
  (module) =>
    moduleSupportsScope(module, scopeState) &&
    matchesSettingsModule(query, module.label, group.title),
),
```

scope 切换后若 `active` 模块不支持新 scope,自动跳到该 scope 下第一个可用模块:

```ts
useEffect(() => {
  if (!moduleSupportsScope(activeModule ?? {}, scopeState)) {
    const first = MODULES.find((module) => moduleSupportsScope(module, scopeState));
    if (first) setActive(first.id);
  }
}, [scopeState]);
```

3f. i18n:`i18n/ns/settings.ts` 的 `settingsX.page` 区块(zh 和 en 各一处)新增:

```ts
// zh
scopeSwitcher: "配置范围",
scopeSwitchGlobal: "全局",
projectScopeHint: "以下设置仅作用于所选项目,覆盖全局默认值。",
// en
scopeSwitcher: "Configuration scope",
scopeSwitchGlobal: "Global",
projectScopeHint: "These settings apply only to the selected project and override global defaults.",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/desktop && bun test src/renderer/settings && bun run typecheck`
Expected: PASS,无新增类型错误

- [ ] **Step 5: 人工 spot-check section 的 project 写入路径**

抽查 `GeneralSection`/`McpSection`:确认 `scope === "project"` 时写入走 `saveProjectSetting`/项目 `.code-shell/settings.json`(grep `scope` 在各 section 内的分支)。若某 section 实际忽略 project scope,把该模块从 `scopes: ["user","project"]` 名单移除并在 commit message 注明。

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/renderer/settings packages/desktop/src/renderer/i18n
git commit -m "feat(desktop): settings page scope model — global/per-project switcher"
```

---

### Task 2: 数字人模块(设置中心收编数字人编辑与激活)

**Files:**
- Create: `settings/DigitalHumansSection.tsx`
- Modify: `settings/SettingsPage.tsx`(新模块注册 + 渲染 + 新 prop)
- Modify: `App.tsx`(传 `onOpenDigitalHumans`)
- Modify: `digital-humans/DigitalHumansView.contract.test.ts`
- Modify: `i18n/ns/settings.ts`

- [ ] **Step 1: 更新契约测试(先改成新契约,确认失败)**

`digital-humans/DigitalHumansView.contract.test.ts` 中 L16 `expect(settings).not.toContain("<ProfileSection");` 替换为:

```ts
const dhSection = readFileSync(
  join(import.meta.dir, "..", "settings", "DigitalHumansSection.tsx"),
  "utf-8",
);
// Settings now hosts digital humans through a dedicated dual-scope section:
// global scope manages the library with the SAME editor dialog as the
// digital-humans page; project scope reuses ProfileSection for activation.
expect(settings).toContain("<DigitalHumansSection");
expect(dhSection).toContain("DigitalHumanEditorDialog");
expect(dhSection).toContain("<ProfileSection");
```

Run: `cd packages/desktop && bun test src/renderer/digital-humans/DigitalHumansView.contract.test.ts`
Expected: FAIL(文件不存在 / settings 不含该组件)

- [ ] **Step 2: 新建 `settings/DigitalHumansSection.tsx`**

```tsx
import React from "react";
import { ExternalLink, Pencil, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "../i18n";
import { DigitalHumanEditorDialog } from "../digital-humans/DigitalHumanEditorDialog";
import type { DigitalHumanProfileEntry, DigitalHumanSkillEntry } from "../digital-humans/types";
import { ProfileSection } from "./ProfileSection";

interface Props {
  scope: "user" | "project";
  /** Project path when scope === "project"; used for activation. */
  projectPath: string | null;
  /** Jump to the full digital-humans page (market / teams). */
  onOpenDigitalHumans?: () => void;
}

/**
 * 设置中心「数字人」模块。全局 scope = 数字人库管理(与数字人页共享同一
 * 编辑对话框);项目 scope = 按项目激活/关闭(复用 ProfileSection)。
 */
export function DigitalHumansSection({ scope, projectPath, onOpenDigitalHumans }: Props) {
  const { t } = useT();
  const [profiles, setProfiles] = React.useState<DigitalHumanProfileEntry[]>([]);
  const [skills, setSkills] = React.useState<DigitalHumanSkillEntry[]>([]);
  const [editing, setEditing] = React.useState<DigitalHumanProfileEntry | undefined>();
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const [profileList, skillList] = await Promise.all([
        window.codeshell.listProfiles(),
        window.codeshell.listSkills(projectPath ?? "/", { includeDisabled: true }),
      ]);
      setProfiles(profileList);
      setSkills(skillList);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [projectPath]);

  React.useEffect(() => {
    if (scope === "user") void refresh();
  }, [scope, refresh]);

  if (scope === "project") {
    if (!projectPath) return null;
    return <ProfileSection cwd={projectPath} />;
  }

  const save = async (profile: Omit<DigitalHumanProfileEntry, "active">) => {
    setBusy(true);
    try {
      await window.codeshell.saveProfile(profile);
      setEditorOpen(false);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            {t("settingsX.digitalHumans.title")}
          </h3>
          <p className="text-xs text-muted-foreground">{t("settingsX.digitalHumans.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          {onOpenDigitalHumans ? (
            <Button size="sm" variant="outline" onClick={onOpenDigitalHumans}>
              <ExternalLink className="size-3.5" aria-hidden />
              {t("settingsX.digitalHumans.openMarket")}
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setEditing(undefined);
              setEditorOpen(true);
            }}
          >
            <Plus className="size-3.5" aria-hidden />
            {t("settingsX.digitalHumans.create")}
          </Button>
        </div>
      </div>
      {error ? <p className="text-xs text-status-err">{error}</p> : null}
      {profiles.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("settingsX.digitalHumans.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {profiles.map((profile) => (
            <li
              key={profile.name}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-foreground">{profile.label}</span>
                  {profile.active ? (
                    <Badge variant="accent">{t("settingsX.profiles.activeBadge")}</Badge>
                  ) : null}
                </div>
                {profile.description ? (
                  <p className="truncate text-xs text-muted-foreground">{profile.description}</p>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setEditing(profile);
                  setEditorOpen(true);
                }}
              >
                <Pencil className="size-3.5" aria-hidden />
                {t("settingsX.digitalHumans.edit")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <DigitalHumanEditorDialog
        open={editorOpen}
        profile={editing}
        existingIds={profiles.map((profile) => profile.name)}
        skills={skills}
        busy={busy}
        onOpenChange={setEditorOpen}
        onSave={(profile) => void save(profile)}
      />
    </section>
  );
}
```

注意:`window.codeshell.listProfiles()` 无参调用返回全局库(见 `preload/index.ts:952` 的可选 `cwd?`)。若其返回条目缺少 editor 需要的字段(plugins/mcp/agents),执行时核对 main 端 `profiles:list` handler 的返回形状并按需补齐 mapping——不得静默丢字段。

- [ ] **Step 3: 注册模块**

`SettingsPage.tsx`:
- `ModuleId` union 加 `"digital-humans"`。
- `buildModuleGroups` 顶部第一组(无标题组)`personalization` 之后插入:

```ts
{ id: "digital-humans", label: t("settingsX.page.digitalHumans"), Icon: UsersRound, scopes: ["user", "project"] },
```

(`import { UsersRound } from "lucide-react"` 补进现有 lucide import。)
- Props 加 `onOpenDigitalHumans?: () => void;`。
- 渲染分支:

```tsx
{active === "digital-humans" && (
  <DigitalHumansSection
    scope={scope}
    projectPath={scopeProjectPath}
    onOpenDigitalHumans={onOpenDigitalHumans}
  />
)}
```

- `App.tsx` 两处 `<SettingsPage`(settings_page 分支)加 `onOpenDigitalHumans={() => setViewMode("digital_humans")}`。
- i18n `settingsX.page` 加 `digitalHumans: "数字人"` / `"Digital humans"`;新增 `settingsX.digitalHumans` 区块(zh/en):`title: "数字人库"/"Digital human library"`、`subtitle: "管理全局数字人定义;市场安装与团队编排在数字人页。"/"Manage global digital human definitions; market installs and teams live on the Digital humans page."`、`openMarket: "打开数字人页"/"Open digital humans"`、`create: "新建"/"Create"`、`edit: "编辑"/"Edit"`、`empty: "还没有数字人,点击「新建」或从市场安装。"/"No digital humans yet — create one or install from the market."`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/desktop && bun test src/renderer/digital-humans src/renderer/settings && bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src
git commit -m "feat(desktop): settings hosts digital humans — dual-scope section sharing the editor dialog"
```

---

### Task 3: 数据源模块

**Files:**
- Create: `settings/DataSourcesModule.tsx`
- Modify: `settings/SettingsPage.tsx`
- Modify: `i18n/ns/settings.ts`
- Test: 扩展 `settings/SettingsPage.scope.contract.test.ts`

- [ ] **Step 1: 契约测试加断言(先失败)**

```ts
test("data sources module bridges the global catalog and per-project bindings", () => {
  const module = readFileSync(join(import.meta.dir, "DataSourcesModule.tsx"), "utf-8");
  expect(source).toContain("<DataSourcesModule");
  expect(module).toContain("DataSourceCatalogSection");
  expect(module).toContain("DataSourcesSection");
});
```

Run: `cd packages/desktop && bun test src/renderer/settings/SettingsPage.scope.contract.test.ts` → FAIL

- [ ] **Step 2: 新建 `settings/DataSourcesModule.tsx`**

```tsx
import React from "react";
import { useT } from "../i18n";
import { DataSourceCatalogSection } from "../credentials/DataSourceCatalogSection";
import { DataSourcesSection } from "../project-config/DataSourcesSection";

interface Props {
  scope: "user" | "project";
  projectPath: string | null;
}

/**
 * 设置中心「数据源」模块。全局 scope = 连接目录(与凭证页共享同一组件,
 * 单一数据源);项目 scope = 该项目的绑定与上传(复用项目配置组件)。
 */
export function DataSourcesModule({ scope, projectPath }: Props) {
  const { t } = useT();
  if (scope === "project") {
    if (!projectPath) return null;
    return <DataSourcesSection cwd={projectPath} />;
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">{t("settingsX.dataSources.globalHint")}</p>
      <DataSourceCatalogSection />
    </div>
  );
}
```

(执行时核对 `DataSourcesSection` 的 props 是否恰为 `{ cwd: string }`——`ProjectConfigPage.tsx:365` 是这么用的。)

- [ ] **Step 3: 注册模块**

- `ModuleId` 加 `"data-sources"`;「环境与连接」组 `connections` 之后插入:

```ts
{ id: "data-sources", label: t("settingsX.page.dataSources"), Icon: Database, scopes: ["user", "project"] },
```

(`Database` 来自 lucide。)渲染分支:

```tsx
{active === "data-sources" && (
  <DataSourcesModule scope={scope} projectPath={scopeProjectPath} />
)}
```

- i18n:`settingsX.page.dataSources: "数据源"/"Data sources"`;`settingsX.dataSources.globalHint: "这里管理全局连接目录;把数据源授权给某个项目请切换到项目范围。"/"Manage the global connection catalog here; switch to a project scope to grant sources to a project."`。

- [ ] **Step 4: 验证 + Commit**

Run: `cd packages/desktop && bun test src/renderer/settings && bun run typecheck` → PASS

```bash
git add packages/desktop/src
git commit -m "feat(desktop): settings data-sources module — global catalog + per-project bindings"
```

---

### Task 4: 项目指令模块(抽出 ProjectInstructionsSection)

**Files:**
- Create: `project-config/ProjectInstructionsSection.tsx`(从 `ProjectConfigPage.tsx:51-189` 原样搬出并 export;`InstructionFileDefinition`、内部 JSX、i18n key 全部不变)
- Modify: `project-config/ProjectConfigPage.tsx`(改为 `import { ProjectInstructionsSection } from "./ProjectInstructionsSection";`,删除本地定义)
- Modify: `settings/SettingsPage.tsx`
- Modify: `i18n/ns/settings.ts`
- Test: 扩展 `settings/SettingsPage.scope.contract.test.ts`

- [ ] **Step 1: 契约断言(先失败)**

```ts
test("instructions module: global compat toggles in user scope, project files in project scope", () => {
  expect(source).toContain('active === "instructions"');
  expect(source).toContain("ProjectInstructionsSection");
  expect(source).toContain("InstructionFilesSection");
});
```

- [ ] **Step 2: 搬出组件 + 注册模块**

- 原样抽出组件文件(imports 按需带走:React、lucide `FileText`、Badge/Button、`cn`、`useT`)。
- `ModuleId` 加 `"instructions"`;第一组 `personalization` 前插入:

```ts
{ id: "instructions", label: t("settingsX.page.instructions"), Icon: FileText, scopes: ["user", "project"] },
```

- 渲染分支:user scope 渲染 `InstructionFilesSection`(从 personalization 分支**移走**,personalization 保留 ResponsePrefs + Personalization 两个 section),project scope 渲染 `ProjectInstructionsSection`:

```tsx
{active === "instructions" &&
  (scope === "project" && scopeProjectPath ? (
    <ProjectInstructionsSection cwd={scopeProjectPath} />
  ) : (
    <InstructionFilesSection scope={scope} activeProjectPath={scopeProjectPath ?? activeProjectPath} />
  ))}
```

- i18n:`settingsX.page.instructions: "指令文件"/"Instruction files"`。

- [ ] **Step 3: 验证 + Commit**

Run: `cd packages/desktop && bun test src/renderer && bun run typecheck` → PASS(project-config 既有测试必须仍绿)

```bash
git add packages/desktop/src
git commit -m "refactor(desktop): extract ProjectInstructionsSection; settings instructions module"
```

---

### Task 5: project_config 路由改为预选项目 scope 的 SettingsPage

**Files:**
- Modify: `settings/SettingsPage.tsx`(project-overview 模块)
- Modify: `App.tsx:2228-2234`
- Delete: `project-config/ProjectConfigPage.tsx`
- Modify: 引用它的测试(执行时 `grep -rn "ProjectConfigPage"` 全量处理)
- Modify: `i18n/ns/settings.ts`

- [ ] **Step 1: SettingsPage 增加 project-overview 模块(project-only,项目 scope 首屏)**

- `ModuleId` 加 `"project-overview"`;第一组最前插入:

```ts
{ id: "project-overview", label: t("settingsX.page.projectOverview"), Icon: LayoutDashboard, scopes: ["project"] },
```

- 渲染分支:卡片网格列出当前 scope 下其它可用模块并 onClick 跳转(复用 `ProjectConfigPage.tsx:191-230` 的 `ProjectOverview` 卡片样式,代码搬入 SettingsPage 或独立小组件 `settings/ProjectOverviewSection.tsx`):

```tsx
{active === "project-overview" && (
  <ProjectOverviewSection
    modules={MODULES.filter(
      (module) => module.id !== "project-overview" && moduleSupportsScope(module, scopeState),
    )}
    onSelect={selectModule}
  />
)}
```

- 进入 project scope 时默认 active 设为 `"project-overview"`(Task 1 的 scope 变更 effect 里,project scope 的 fallback 首选它)。
- i18n:`settingsX.page.projectOverview: "项目概览"/"Project overview"`。

- [ ] **Step 2: App.tsx 路由替换**

`App.tsx:2228-2234` 的 `<ProjectConfigPage ... />` 分支替换为:

```tsx
) : activeProject ? (
  <SettingsPage
    activeProjectPath={activeProject.path}
    initialProjectPath={activeProject.path}
    projects={projects}
    sessionIndices={sessionIndices}
    onRestoreArchivedSession={/* 与 settings_page 分支相同 */}
    onDeleteArchivedSession={handleDeleteSession}
    onOpenDigitalHumans={() => setViewMode("digital_humans")}
    isMac={isMac}
    isFullscreen={isFullscreen}
    onBack={() => setViewMode("chat")}
  />
) : null}
```

删除 `ProjectConfigPage` 的 lazy import;`view.ts` 的 `"project_config"` ViewMode 保留(路由语义 = 预选项目 scope)。

- [ ] **Step 3: 删除 ProjectConfigPage 并清理引用**

`grep -rn "ProjectConfigPage" packages/desktop/src` — 删除组件文件,更新所有引用/测试(project-config 目录下 `DataSourcesSection`、`ProjectInstructionsSection` 保留)。涉及 `projectConfig.*` i18n key 的保留(被抽出组件继续用)。

- [ ] **Step 4: 验证 + Commit**

Run: `cd packages/desktop && bun test src/renderer && bun run typecheck` → PASS

```bash
git add -A packages/desktop/src
git commit -m "feat(desktop): project_config route opens the settings center preselected to project scope"
```

---

### Task 6: 侧边栏一级设置入口 + 扩展双门收口 + 死代码清理

**Files:**
- Modify: `Sidebar.tsx`(顶部 nav 加设置项;移除扩展项)
- Modify: `App.tsx`(删 customize 分支与 lazy import、`onOpenCustomize`)
- Modify: `view.ts`(customize 迁移)
- Delete: `customize/CustomizeView.tsx`、`SidebarNav.tsx`
- Modify: `settings/SettingsPage.tsx`(plugins-skills 模块 `showDiscover` 改 true,保住市场入口)
- Test: 扩展 scope 契约测试

- [ ] **Step 1: 契约断言(先失败)**

```ts
const sidebar = readFileSync(join(import.meta.dir, "..", "Sidebar.tsx"), "utf-8");
const view = readFileSync(join(import.meta.dir, "..", "view.ts"), "utf-8");

test("settings is a first-class sidebar entry and the customize double-door is gone", () => {
  expect(sidebar).toContain('t("sidebar.settings")');
  expect(sidebar).not.toContain("onOpenCustomize");
  expect(view).toContain('"customize"'); // migration mapping keeps the literal
  expect(view).toContain("settings_page");
});
```

- [ ] **Step 2: Sidebar 顶部 nav(`Sidebar.tsx:289-294` credentials 项之后)加:**

```tsx
<SidebarItem
  label={t("sidebar.settings")}
  Icon={SettingsIcon}
  onClick={onOpenSettingsPage}
  active={viewMode === "settings_page" || viewMode === "project_config"}
/>
```

(`import { Settings as SettingsIcon } from "lucide-react"` 并入现有 import;`onOpenSettingsPage` prop 已存在。)同时删除 L273-278 的「扩展」`SidebarItem` 与 `onOpenCustomize` prop(接口、解构、App.tsx:1853 传参一并删)。底部 `SettingsMenu` 保留不动。i18n `misc.ts` 或放 sidebar 词条的 ns 加 `sidebar.settings: "设置"/"Settings"`(执行时 grep `sidebar.credentials` 找到正确文件照抄结构)。

- [ ] **Step 3: customize 迁移**

- `view.ts`:union 与 `VALID_MODES` 删除 `"customize"`;`loadView()` 在 VALID_MODES 检查**之前**加:

```ts
if ((merged.viewMode as string) === "customize") merged.viewMode = "settings_page";
```

- `App.tsx`:删 customize lazy import(L1919-1922 分支)及 `view.viewMode === "customize"` 相关逻辑;删除 `customize/CustomizeView.tsx`。
- `SettingsPage.tsx` L440-442 `plugins-skills` 分支 `showDiscover={false}` 改为 `showDiscover`(市场/发现面随双门收口迁入设置)。
- 删除 `SidebarNav.tsx`(先 `grep -rn "SidebarNav" packages/desktop/src` 确认无调用方)。
- `grep -rn "customize" packages/desktop/src` 清理残余(i18n key `auto.customize.*` 若无他用一并删)。

- [ ] **Step 4: 验证 + Commit**

Run: `cd packages/desktop && bun test src/renderer && bun run typecheck` → PASS

```bash
git add -A packages/desktop/src
git commit -m "feat(desktop): sidebar first-class settings entry; retire the customize double-door and dead SidebarNav"
```

---

### Task 7: 全量验证

- [ ] **Step 1: 桌面包全量测试 + 类型 + 构建**

```bash
cd packages/desktop && bun test && bun run typecheck && bun run build
```

Expected: 全绿(仓库惯例:root typecheck 有预存错误不算门禁,desktop 自己的 typecheck 必须干净)。

- [ ] **Step 2: 根 lint**

```bash
bun run lint
```

- [ ] **Step 3: 冒烟(可选,若环境允许)**

`bun run dev` 启动,验证:侧边栏「设置」入口 → scope 切到某项目 → 数字人激活/数据源绑定/项目指令三模块可见;项目右键「项目配置」落到同一页面且预选该项目;旧 customize localStorage 值migration 到 settings_page。

- [ ] **Step 4: 更新 TODO.md 小 feature 段记录本工作流完成状态(一行)并 commit**

```bash
git add TODO.md
git commit -m "docs(todo): settings-center IA workstream landed"
```
