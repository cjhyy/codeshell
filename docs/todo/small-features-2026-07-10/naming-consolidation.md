# repo / workspace / project / cwd 命名收口落地方案

日期：2026-07-10  
体量：M（建议拆成 6 个可独立合并的 PR）  
上游调研：`docs/nightly-2026-07-10/naming-consolidation-plan.md`

## 1. 问题与现状

### 1.1 目标概念已经明确，但代码尚未迁移

上游 plan 的结论是：用户加入侧栏的根目录统一叫 **Project**；core/工具真正执行的位置叫 **cwd**；单个 session 在
main/worktree 之间的当前指针叫 **Workspace**。该文档在 `docs/nightly-2026-07-10/naming-consolidation-plan.md:4-8`
明确声明“仅调研与迁移方案，不做代码改名”，所以当前仓库仍处于“产品文案已经是 Project、内部主干仍叫 Repo”的过渡态。

### 1.2 renderer 的 Repo 实际是 Project cache

`packages/desktop/src/renderer/repos.ts:1-9` 的注释已经说明这是 sidebar 的“项目”列表和 no-project 选择，但类型仍叫
`Repo`（`:14-25`）。其中 `path` 的真实语义也明确写成 “Absolute project path”（`:18`），不是“任意 Git repository”。

该文件同时承担了三个不能混为一谈的职责：

1. 产品对象：`Repo`、`repoLabel()`、`sortRepos()`。
2. renderer 兼容 cache：`codeshell.repos`、`codeshell.activeRepoId`、`codeshell.removedRepoPaths`
   （`:27-29`）。
3. disk project registry 到稳定 renderer id 的 reconcile：`reconcileReposFromDiskWithRemap()` 会保留旧 id，避免会话 bucket
   消失（`:183-223`）。

`App.tsx` 仍以 `repos/activeRepoId` 持有主状态：`packages/desktop/src/renderer/App.tsx:367-368`，磁盘 project
会在 `:754-805` 被重新投影为 repos；添加/删除日志仍叫 `repo.*`，删除主流程见 `:1177-1193`。类型和 props 又扩散到
Sidebar、ChatView、TopBar、automation 与 settings 组件。

### 1.3 repoId 已成为持久化 bucket 的字节协议

`packages/desktop/src/renderer/transcripts.ts:1-21` 仍用 per-repo 描述，但真正的持久化 key 是：

```text
codeshell.sessionIndex.<repoKey>
codeshell.transcript.<repoKey>.<sessionId>
<repoId-or-__no_repo__>::<sessionId-or-_none_>
```

`NO_REPO_KEY` 的值是 `"__no_repo__"`（`:27-29`）；`bucketKey()` 在 `:98-108` 明确要求跨版本 byte-identical。
同一 bucket 还被 overrides（`:174-228`）、panel state（`:237-307`）、stream routing
（`packages/desktop/src/renderer/streamRouting.ts:1-49`）、anchor buckets 和 prompt history 使用。
因此“把 `repoId` 搜索替换成 `projectId`”只能改 TypeScript 标识符，绝不能改变 id 值、分隔符、key prefix 或 no-project sentinel。

### 1.4 cwd 与 workspace 不是 Project 的别名

Core state 同时保存：

- `SessionState.cwd`：旧字段和 legacy fallback，`packages/core/src/types.ts:229-233`；
- `SessionWorkspace.root/kind/worktree`：当前 session workspace 指针，`:209-218`。

`SessionManager.create()` 当前把两者都初始化为传入 cwd：
`packages/core/src/session/session-manager.ts:146-188`；之后 `setSessionWorkspace()` 只改 `workspace`、不改 legacy cwd：
`:277-300`。resume 时无 workspace 才把 `state.cwd` 当 main：`:326-365`；Engine 对新 session 优先使用
workspace root，即使 host 仍传旧 cwd：`packages/core/src/engine/engine.ts:957-1000`。

这意味着：

- 不能把 core 的所有 `cwd` 改为 `projectPath`；worktree、no-project sandbox、临时目录都可能是 execution cwd。
- 不能把 `SessionWorkspace` 改成 Project；它是一个 session 的 current working pointer。
- `state.cwd` 也不能直接改 JSON 字段名；旧 state 和 desktop cold-start 仍读取它：
  `packages/core/src/session/session-manager.ts:227-250`。

### 1.5 project settings 仍借 cwd 参数落盘

`capabilityOverrides` 已明确是 project-scoped overlay，但注释以 `${cwd}` 表达物理路径：
`packages/core/src/settings/schema.ts:360-367`。Core `SettingsManager` 的 scope `"project"` 表示只读 project/local layers，
并不表示 workspace：`packages/core/src/settings/manager.ts:182-191`；project setting 仍写到 `${cwd}/.code-shell/settings.json`：
`:423-431`。

Desktop main 的 `resolveSettingsPath(scope, cwd?)` 也在 project scope 使用 cwd：
`packages/desktop/src/main/settings-service.ts:20-35`。IPC 是 positional `(scope, cwd?)`，channel 为 `settings:get/set`：
`packages/desktop/src/main/index.ts:3345-3358`、`packages/desktop/src/preload/index.ts:750-753`。这些 wire/channel 不需要改，
但 settings UI 的 `activeRepoPath` 和局部 `cwd` 应收口为 `activeProjectPath/projectPath`。

## 2. 目标

1. 新 renderer 代码只用 `TrackedProject`/`ProjectId`、`projects`、`activeProjectId`、`projectPath/projectName`；
   `Repo` 只存在于带 `legacy` 注释的兼容 facade。
2. Git 语境只使用 `gitRepository`/`gitRoot`/`repository`；不再用裸 `repo` 泛指用户加入的目录。
3. Core 保留 `cwd`（执行目录）与 `SessionWorkspace`（当前 main/worktree 指针）；通过 helper/注释消除
   `state.cwd` 是“永远当前目录”的误解，而不改 state.json shape。
4. project settings 的 UI/main 局部参数改为 `projectPath`；scope 字符串 `"project"`、目录 `.code-shell`、IPC channel 和
   positional payload 保持不变。
5. 所有旧 localStorage key、bucket 字符串、`Repo` JSON 字段 `id/name/path/addedAt/displayName/pinned`、
   state.json `cwd/workspace.root` 均继续原样读写。
6. 每个 PR 只改一种边界，并在合并时具备明确回归断言；不安排一次性全仓 rename。

## 3. 详细修改方案

### 3.1 固定改名映射

| 当前标识符 | 目标标识符 | 是否改持久化/wire | 说明 |
| --- | --- | --- | --- |
| `Repo` | `TrackedProject` | 否 | 避免与泛化的 `Project`/Git repository 混淆；表示侧栏跟踪的根目录。 |
| `Repo.id`（代码语义） | `ProjectId` / `project.id` | JSON 字段仍是 `id` | id 值不变，仍用于历史 bucket segment。 |
| `repos` / `repoList` | `projects` / `projectList` | 否 | renderer state/props/locals。 |
| `activeRepoId` | `activeProjectId` | key 仍为 `codeshell.activeRepoId` | storage adapter 隐藏旧 key。 |
| `repoPath` / `repoName` | `projectPath` / `projectName` | 否 | 仅当变量表示 tracked project；Git 场景改 `gitRoot`。 |
| `repoLabel` / `sortRepos` | `projectLabel` / `sortProjects` | 否 | 旧导出保留 deprecated alias。 |
| `makeRepoId` | `makeProjectId` | id 前缀 `r-` 暂不变 | 改前缀会造成无价值的格式分裂。 |
| `repoKey` / `repoKeyOf` | `projectBucketSegment` / `projectBucketSegmentOf` | 输出不变 | 明确这是 bucket segment，不是产品对象。 |
| `NO_REPO_KEY` | `NO_PROJECT_BUCKET_SEGMENT` | 值仍为 `"__no_repo__"` | 保留旧常量 alias，禁止迁移存量 key。 |
| `migrateRepoSessionBucket` | `migrateProjectSessionBucket` | key/value 不变 | 只是函数语义收口。 |
| settings 局部 `cwd` | `projectPath` | IPC 位置和 channel 不变 | 只在 scope 已确定为 project 时改。 |
| Engine/Tool `cwd` | 保留 `cwd`，必要时 `executionCwd` | 不变 | 可能是 worktree/no-project/临时目录。 |
| `SessionWorkspace` | 保留 | `root/kind/worktree` 不变 | session 的当前 workspace pointer。 |
| Git `repo` | `gitRepository` / `gitRoot` | 不变 | 只改真正 Git 语境。 |

### 3.2 renderer 兼容类型/adapter

#### 新增 `packages/desktop/src/renderer/projects.ts`

第一批不移动 `repos.ts` 的实现，只建立 canonical facade：

```ts
import {
  type Repo,
  loadRepos,
  saveRepos,
  loadActiveRepoId,
  saveActiveRepoId,
  // ...其余旧 helper
} from "./repos";

export type ProjectId = string;
export type TrackedProject = Repo;

export const loadProjects = loadRepos;
export const saveProjects = saveRepos;
export const loadActiveProjectId = loadActiveRepoId;
export const saveActiveProjectId = saveActiveRepoId;
// projectLabel/sortProjects/makeCreateProjectForCwd/reconcileProjectsFromDisk...
```

`repos.ts` 在每个旧导出上增加 `@deprecated Project semantics; use projects.ts`，但实现与 key 常量一字不动。这样 PR1
只增加入口，不迫使整个 App 同批迁移，也不做双写。

最终清理批再把实现移动到 `projects.ts`，让 `repos.ts` 反向成为纯 re-export：

```ts
/** @deprecated Legacy module path. Storage keys intentionally retain repo names. */
export {
  loadProjects as loadRepos,
  saveProjects as saveRepos,
  // ...
} from "./projects";
export type { TrackedProject as Repo } from "./projects";
```

### 3.3 localStorage 与 bucket 兼容 shim

本次迁移明确**不创建** `codeshell.projects`、`codeshell.activeProjectId` 等新 key，也不 one-shot 搬迁数据。canonical
API 的内部常量要显式命名为 legacy contract：

```ts
const LEGACY_PROJECTS_KEY = "codeshell.repos";
const LEGACY_ACTIVE_PROJECT_KEY = "codeshell.activeRepoId";
const LEGACY_REMOVED_PROJECT_PATHS_KEY = "codeshell.removedRepoPaths";
const LEGACY_NO_PROJECT_SEGMENT = "__no_repo__";
```

兼容矩阵：

| 数据 | 读 | 写 | 本批必须保持的字节形状 |
| --- | --- | --- | --- |
| project cache | `codeshell.repos` | `codeshell.repos` | `[{id,name,path,addedAt,displayName?,pinned?}]` |
| active project | `codeshell.activeRepoId` | 同 key | raw stable id 或 key 缺失 |
| removed denylist | `codeshell.removedRepoPaths` | 同 key | normalized path string[] |
| session index | `codeshell.sessionIndex.<id-or-__no_repo__>` | 同 key | prefix/segment 不变 |
| transcript | `codeshell.transcript.<segment>.<sessionId>` | 同 key | prefix/dot 不变 |
| conversation bucket | runtime/localStorage | 同字符串 | `<segment>::<sessionId-or-_none_>` |
| overrides | `codeshell.overrides.permission/model/goal` | 同 key | 内层 bucket key 不变 |
| panel state | `codeshell.panelState.<bucket>` | 同 key | bucket 不变 |
| prompt history | `codeshell.promptHistory.<id-or-__global__>` | 同 key | prefix/sentinel 不变 |

`packages/desktop/src/renderer/transcripts.ts` 新增 canonical names，但保留旧 alias：

```ts
export const NO_PROJECT_BUCKET_SEGMENT = "__no_repo__";
/** @deprecated */ export const NO_REPO_KEY = NO_PROJECT_BUCKET_SEGMENT;

export function projectBucketSegmentOf(projectId: ProjectId | null): string {
  return projectId ?? NO_PROJECT_BUCKET_SEGMENT;
}
/** @deprecated */ export const repoKeyOf = projectBucketSegmentOf;
```

`bucketKey(projectId, sessionId)` 名称本身正确，不改；只改参数名和注释。所有 storage key builder 必须继续只调用这个
canonical segment helper。`migrateProjectSessionBucket()` 可包旧实现，但测试必须逐项断言迁移前后 key 字符串相同。

### 3.4 Core session 语义 helper

#### `packages/core/src/types.ts`、`packages/core/src/session/session-manager.ts`

不改 interface 字段，新增一个纯 helper并让 workspace 读取/resume 复用，去掉三处“手写 workspace-or-cwd”语义漂移：

```ts
export function persistedSessionWorkspace(state: Pick<SessionState, "cwd" | "workspace">):
  SessionWorkspace | undefined {
  if (isSessionWorkspace(state.workspace)) return structuredClone(state.workspace);
  return state.cwd ? { root: state.cwd, kind: "main" } : undefined;
}
```

注释统一为：

- `state.cwd`：session 创建时的 cwd / legacy main fallback；为了旧 state 与 host cold-start 保留，不保证等于当前执行目录。
- `state.workspace.root`：有 workspace 字段时，resume/下一 turn 的 authoritative execution cwd。
- `readCwd()`：读取 legacy/boot cwd；若调用者需要当前 workspace，必须用 `getSessionWorkspace()` 或
  `resolveSessionWorkspaceForResume()`。

`getSessionWorkspace()`（当前 `session-manager.ts:253-275`）和
`resolveSessionWorkspaceForResume()`（`:326-365`）改用该 helper；`setSessionWorkspace()` 继续不更新 cwd。
这一步只收口命名/语义，不把 `cwd` 重命名为 `projectRoot`，也不迁移 state.json。

### 3.5 settings 边界命名

#### Desktop renderer

所有 settings component props 从 `activeRepoPath` 改为 `activeProjectPath`；当 `scope === "project"` 时局部变量叫
`projectPath`，调用仍是 positional：

```ts
const projectPath = scope === "project" ? activeProjectPath ?? undefined : undefined;
await window.codeshell.getSettings(scope, projectPath);
```

重点入口 `packages/desktop/src/renderer/settings/SettingsView.tsx:18-22`、`:41-68`、`:87-115`。
`scope`、显示文案 “Project”、物理路径 `.code-shell/settings.json` 不变。

#### Desktop main/preload

`packages/desktop/src/main/settings-service.ts` 的参数名改为 `projectPath?: string`，错误改为
`"project scope requires projectPath"`；`readSettings/writeSettings/resolveSettingsPath` 内部均使用该名。
`packages/desktop/src/main/index.ts:3345-3358` 和 `packages/desktop/src/preload/index.ts:750-753` 只改 TypeScript
parameter/local 名，IPC channel、参数顺序 `(scope, patch?, projectPath?)` 不变。preload 类型声明同步。

#### Core settings

`SettingsManager` 继续接受 cwd，因为它是通用库层的路径上下文；只把 schema 注释
`packages/core/src/settings/schema.ts:361-363` 改为“project settings resolved from the manager's cwd/project path”，
并在 `saveProjectSetting()` 文档中明确 project scope != `SessionWorkspace`。`ApprovalScope` 字符串 `"project"` 和
permission settings 文件布局不改。

## 4. 分 PR / 分步骤实施顺序

### PR 1：建立 canonical Project facade 和兼容合同

**文件清单**

- 新增 `packages/desktop/src/renderer/projects.ts`
- `packages/desktop/src/renderer/repos.ts`
- `packages/desktop/src/renderer/repos.test.ts`
- `packages/desktop/src/renderer/transcripts.test.ts`

**改动**

- 引入 `TrackedProject`、`ProjectId` 及 canonical helper aliases。
- 给旧 `Repo`/`loadRepos` 等加 deprecated 注释。
- 增加 storage contract 测试：canonical API 仍只读写三个旧 key，JSON 字段和值不变。
- 暂不改任何业务调用点。

**合并门槛**

旧 import 与新 import 同时可编译；用旧 key 预置 localStorage 后，canonical API 可无损读取并原样写回。

### PR 2：迁移 App 主状态与主导航 props

**文件清单**

- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/renderer/Sidebar.tsx`
- `packages/desktop/src/renderer/ChatView.tsx`
- `packages/desktop/src/renderer/TopBar.tsx`
- `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx`
- `packages/desktop/src/renderer/chat/ProjectPicker.tsx`
- `packages/desktop/src/renderer/shell/SessionSearchModal.tsx`
- 对应 `App*.test.tsx`、`topbar/WorkspaceIndicator.test.tsx`、`streamRouting.test.ts`

**改动**

- `repos/setRepos/activeRepoId` -> `projects/setProjects/activeProjectId`。
- handler 变为 `handleAdd/Remove/Pin/RenameProject`，日志改 `project.added/removed`；如日志被外部采集，过渡一版同时带
  `{eventAlias:"repo.removed"}`，不双发业务事件。
- props 和 callbacks 全部用 `projectId/projectPath/projectName`。
- WorkspaceIndicator 的 `repoPath` 实际是 main project path，改为 `projectPath`；组件名 WorkspaceIndicator 保留，因为它管理
  session main/worktree pointer。
- Git probe 内真正代表 repository root 的局部变量改 `gitRoot`，不把它叫 projectPath。

**兼容 shim**

所有加载/保存通过 PR1 `projects.ts`；bucket 调用仍传同一个 stable id，不碰 `transcripts.ts` 导出名。

**合并门槛**

添加、选择、重命名、pin、删除 project；no-project draft；reload 后 active selection；已有 session 仍出现在原 project 下。

### PR 3：迁移次级页面、settings UI 与 automation 的 Project props

**文件清单**

- `packages/desktop/src/renderer/automation/AutomationView.tsx`
- `packages/desktop/src/renderer/automation/importRuns.ts`
- `packages/desktop/src/renderer/automation/liveSession.ts`
- `packages/desktop/src/renderer/automation/rebuildFromDisk.ts`
- `packages/desktop/src/renderer/automation/projectOptions.ts`
- `packages/desktop/src/renderer/credentials/CredentialsPage.tsx`
- `packages/desktop/src/renderer/customize/CustomizeView.tsx`
- `packages/desktop/src/renderer/extensions/ExtensionsPage.tsx`
- `packages/desktop/src/renderer/extensions/ManagePage.tsx`
- `packages/desktop/src/renderer/settings/SettingsPage.tsx`
- `packages/desktop/src/renderer/settings/ProjectPicker.tsx`
- `packages/desktop/src/renderer/settings/AgentsSection.tsx`
- `packages/desktop/src/renderer/settings/CapabilitiesOverviewSection.tsx`
- `packages/desktop/src/renderer/settings/SandboxSection.tsx`
- `packages/desktop/src/renderer/settings/MemorySection.tsx`
- `packages/desktop/src/renderer/settings/AdvancedSections.tsx`
- 以上模块现有 `.test.ts/.test.tsx`，重点是 `automation/{importRuns,liveSession,rebuildFromDisk,projectOptions}.test.ts`

**改动**

- 类型 import 改自 `projects.ts`，props/locals 机械改名。
- automation 的返回 shape `repoId` -> `projectId`，但写入 bucket 时仍是同一 id 值；若函数由多模块调用，先提供
  `{projectId, /** @deprecated */ repoId}` 一版兼容，再在本 PR 内清完调用者并删除旧返回字段。
- `CredentialsPage.activeRepoPath` 等产品路径统一为 `activeProjectPath`。
- `projectOptions.ts` 已是用户可见 Project 语义，删除其局部 `ProjectRepo/repoLabel` 重复类型，复用 `TrackedProject/projectLabel`。

**合并门槛**

disk rebuild 不创建重复 project；被用户删除的 path 不被 automation resurrect；settings/credentials/extensions 都跟随当前 project；
automation session 仍落入原 bucket。

### PR 4：收口 conversation bucket 术语，锁死字节兼容

**文件清单**

- `packages/desktop/src/renderer/transcripts.ts`
- `packages/desktop/src/renderer/transcripts.test.ts`
- `packages/desktop/src/renderer/streamRouting.ts`
- `packages/desktop/src/renderer/streamRouting.test.ts`
- `packages/desktop/src/renderer/chat/anchorBuckets.ts`
- `packages/desktop/src/renderer/promptHistory.ts`
- `packages/desktop/src/renderer/archiveAllSessions.test.ts`
- `packages/desktop/src/renderer/automation/AutomationView.tsx`（只改 bucket locals）
- `packages/desktop/src/renderer/App.tsx`、`Sidebar.tsx`（只改 helper import/local）

**改动**

- 引入 `NO_PROJECT_BUCKET_SEGMENT`、`projectBucketSegmentOf()`、`migrateProjectSessionBucket()`；旧导出做 deprecated alias。
- 所有参数 `repoId` 改 `projectId`，所有迭代局部 `repoKey` 改 `projectBucketSegment` 或 `conversationBucket`。
- prompt history 只改参数名/注释，key prefix 和 `__global__` 不变。
- 不改 `bucketKey` 函数名，因为它已经表达 routing primitive；不把它叫 workspace key。

**合并门槛（精确字符串断言）**

```text
bucketKey("r-1", "s-1") === "r-1::s-1"
bucketKey(null, null) === "__no_repo__::_none_"
session index key === "codeshell.sessionIndex.r-1"
transcript key === "codeshell.transcript.r-1.s-1"
panel key === "codeshell.panelState.r-1::s-1"
prompt history key === "codeshell.promptHistory.r-1"
```

并用旧 localStorage fixture reload，验证 session/override/panel/history 全部可见。

### PR 5：settings 边界 projectPath 化

**文件清单**

- `packages/desktop/src/main/settings-service.ts`
- `packages/desktop/src/main/index.ts`（仅 `settings:get/set` handlers）
- `packages/desktop/src/preload/index.ts`
- `packages/desktop/src/preload/types.d.ts`
- `packages/desktop/src/renderer/settings/SettingsView.tsx`
- `packages/desktop/src/renderer/settings/SettingsPage.tsx`
- `packages/desktop/src/renderer/settings/{GeneralSection,ConversationSettingsSection,PermissionSection,McpSection,MemorySection,ModelCatalogPanel,TextConnectionsPanel,SearchConnectionsPanel,PluginsAndSkillsSection,AdvancedSections}.tsx`
- `packages/desktop/src/main/settings-service.test.ts`（若尚无则新增）
- `packages/core/src/settings/schema.ts`
- `packages/core/src/settings/manager.test.ts`

**改动**

- renderer/main/preload 的 project-specific locals 和 props 改名；channel、scope、参数位置不变。
- Core API 的 cwd 保留，只修正文档和测试描述。
- 不把 `.code-shell/settings.json` 放到 worktree root；调用方继续传 tracked project path。若业务确实需要 worktree-local settings，另立 feature，
  不借命名迁移改变语义。

**合并门槛**

user scope 写 `~/.code-shell/settings.json`；project scope 写 `<projectPath>/.code-shell/settings.json`；切到 worktree 后 project settings
仍命中原 project 层；IPC 与旧 preload/main 组合的参数位置不变。

### PR 6：Core session 注释/helper + legacy module 清理

**文件清单**

- `packages/core/src/types.ts`
- `packages/core/src/session/session-manager.ts`
- `packages/core/src/session/session-manager.workspace.test.ts`
- `packages/core/src/session/session-manager.workspace-resume.test.ts`
- `packages/core/src/engine/engine.workspace-cwd.test.ts`
- `packages/desktop/src/main/session-workspace-service.ts`（只复用 helper/改注释）
- `packages/desktop/src/renderer/projects.ts`
- `packages/desktop/src/renderer/repos.ts`（收缩为 deprecated re-export）
- `packages/desktop/src/renderer/repos.test.ts`（迁移到 `projects.test.ts`，旧 module 加一个兼容 smoke）

**改动**

- 引入 `persistedSessionWorkspace()` 并统一 legacy fallback。
- 最终移动 project 实现，旧 module path 继续导出至少一个 release；禁止仓库新代码从 `./repos` import。
- 用 CI `rg` 清单而不是自定义 lint 起步：renderer 产品代码不再出现 `type Repo`、`activeRepoId`、`repoPath/repoName`；
  白名单只允许 legacy storage constants、兼容 alias、Git repository 语境和 fixture 字符串。

**合并门槛**

legacy state（无 workspace）从 cwd resume；worktree state 从 workspace.root resume；worktree 丢失分支存在时继续阻断、分支也丢失时回 main；
保存 state 后 JSON 仍含 `cwd` 和 `workspace.root` 原字段。

## 5. 测试策略

### 5.1 renderer 自动化测试

1. `projects/repos` compatibility：旧 key fixture、无效 JSON、stable id、displayName/pinned、removed denylist normalization。
2. `transcripts.test.ts`：上述精确 key 断言；旧 bucket fixture 的 load/save/clear/migrate；no-project sentinel；draft `_none_`；
   override/panel 不丢。
3. `permissionOverrides`/`promptHistory`/`anchorBuckets`：只改标识符后序列化完全一致。
4. `automation/rebuildFromDisk.test.ts`、`importRuns.test.ts`、`projectOptions.test.ts`：cwd -> project 匹配、删除 denylist、
   normalized duplicate path 的 id remap。
5. App/Sidebar/Chat smoke：旧 localStorage 启动、project picker、add/remove/restore、session search、no-project chat、reload active project。

### 5.2 Desktop main/preload 测试

1. settings path：user/project、缺 projectPath 报错、原子写、并发写锁行为不变。
2. IPC contract：`settings:get(scope, secondArg)` 与 `settings:set(scope, patch, thirdArg)` 参数顺序不变。
3. recents registry 继续是 disk source of truth，不修改 `~/.code-shell/desktop/recents.json` shape。
4. session workspace service 仍把 project/main root 和 current workspace 分开，cleanup owner guard 不受 prop rename 影响。

### 5.3 Core 测试

1. `persistedSessionWorkspace()`：workspace 优先；legacy cwd fallback；空/非法字段 fail closed；返回值深拷贝。
2. `SessionManager.readCwd()` 继续返回 state.cwd；`getSessionWorkspace()` 返回 current pointer。用两个不同路径的 fixture 锁定区别。
3. Engine resume：host stale cwd 不覆盖 persisted worktree root；legacy session 仍遵守原 cwd precedence。
4. SettingsManager：scope `"project"`、路径和危险字段 trust filtering 均不变。

### 5.4 手工验收矩阵

用一份含旧 key 的真实 profile 依次验收：启动 -> 选择 project -> 新建/恢复对话 -> 切 worktree -> 重启 -> settings 写入 ->
automation disk rebuild -> 删除 project -> no-project 对话。全程比较迁移前后 localStorage 导出与 state.json，除 UI 内部变量不可见外不应产生
任何 key/field 迁移。

## 6. 风险与兼容性注意

1. **最危险的是 id/key，不是类型名。** `Repo.id` 虽改称 ProjectId，值仍是历史随机 id；不能改为 path hash、disk recents id 或新 `p-` 前缀。
2. **禁止 storage key 双轨扩散。** 本任务没有产品收益要求迁移到 `codeshell.projects`；同时写新旧 key 会引入冲突 source of truth，故明确不做。
3. **`NO_REPO_KEY` 只能别名化。** 值 `__no_repo__` 已嵌入 index/transcript/bucket；改成 `__no_project__` 会让全部 no-project 会话“消失”。
4. **不要把 cwd 机械改为 projectPath。** Engine、ToolContext、git/shell/attachment、no-project sandbox 和 workspace resume 的 cwd 都是执行路径。
   只有 scope 已经确定为 project 的 UI/main settings 局部变量可改。
5. **不要把 workspace 文案消灭。** TopBar 的 WorkspaceIndicator 真实管理 main/worktree；只把它的 `repoPath` 输入改为 projectPath，组件概念保留。
6. **state.json 不迁移。** `cwd` 和 `workspace.root` 是外部持久化合同；新增 helper只能解释/集中读取，不能在保存时删除旧字段或改名。
7. **磁盘 registry 与 renderer cache 不同。** `recents.json` 决定 project 集合/pinned，legacy localStorage 决定 stable id/displayName；reconcile 的优先级
   不能因改名颠倒。
8. **日志兼容。** 若 `repo.added/removed` 已进入分析系统，先在 payload 提供 alias/version，再切 event name；不要永久双发导致计数翻倍。
9. **巨大 PR 的回归定位差。** App state、bucket、settings、core session 必须分批；任何一批都不同时迁 key 和 TypeScript 名。
10. **文件名兼容窗口。** `repos.ts` 至少保留一个 release 的 deprecated re-export，避免测试、插件或尚未同批迁移的 renderer 文件立即断裂；
    新代码检查只允许它出现在白名单。
