# SDK 配置隔离设计

> 2026-05-27 · 让 codeshell 作为库/SDK 嵌入时不再静默继承宿主机 TUI/desktop 用户的个人配置。
> 范围:在配置加载层引入 scope 概念,默认安全隔离;TUI/desktop/CLI 显式声明完整继承。

---

## 1. 问题

codeshell 的三个入口 —— SDK(`@cjhyy/code-shell-core` 的 `Engine` export)、TUI、desktop —— 创建 `SettingsManager` 的方式完全相同,都无差别读取同一份磁盘配置层级:

```
managed (~/.code-shell/settings.managed.json)
  → user    (~/.code-shell/settings.json)
  → project (${cwd}/.code-shell/settings.json)
  → local   (${cwd}/.code-shell/settings.local.json)
  → flag overrides
```

证据:
- SDK:`engine.ts:1586` `new SettingsManager(this.config.cwd)`(lazy 单例)
- TUI:`packages/tui/src/cli/commands/run.ts:106`、`repl.ts:58`
- desktop worker:`packages/core/src/cli/agent-server-stdio.ts:47`
- 合并层级:`packages/core/src/settings/manager.ts:48-71`

`EngineConfig` / `SettingsManager` **没有任何注入或 scope 控制入口** —— 没有 `preloadedSettings`、没有 `disableUserSettings`、没有 `configDir` override。唯一可改的是 `cwd`(只影响 project 级)。

后果:一个把 codeshell 当库嵌入的程序,**无法阻止**它读取宿主机用户的 `~/.code-shell/settings.json`(含个人的 model、API key、MCP 服务器、hooks)。其中 hooks 会 spawn 子进程、MCP 会连外部服务 —— 宿主的个人配置被静默注入 SDK 流程,既违反惊讶最小原则,也是安全与可复现性问题。

## 2. 目标

- **安全默认**:Engine 不显式声明 scope 时,默认不读取宿主机用户级配置(`~/.code-shell` 下的 managed + user),只读随仓库走的项目级配置。
- **入口显式解锁**:TUI / desktop / CLI 这些"个人终端环境"入口显式声明完整继承,行为不变。
- **可全隔离**:处理不可信仓库的 SDK 调用方可一键关闭所有磁盘读取。
- **向后行为可控**:对外口子收敛到 `EngineConfig`,SDK 调用方只跟 `new Engine({...})` 打交道。

## 3. 设计

### 3.1 `settingsScope` 类型与三档语义

在 `EngineConfig` 增加可选字段:

```typescript
/**
 * 控制 Engine 加载哪些层级的磁盘配置。
 * 默认 'project' —— 安全默认:不读宿主机用户级 ~/.code-shell(含个人 key/model/MCP/hooks),
 * 只读随仓库走的项目级 ${cwd}/.code-shell。
 */
settingsScope?: SettingsScope; // 'isolated' | 'project' | 'full'
```

各档对应 `SettingsManager.load()` 现有 5 层优先级的读取层级:

| 层级 | 路径 | isolated | project (默认) | full |
|---|---|---|---|---|
| managed | `~/.code-shell/settings.managed.json` | ❌ | ❌ | ✅ |
| user | `~/.code-shell/settings.json` | ❌ | ❌ | ✅ |
| project | `${cwd}/.code-shell/settings.json` | ❌ | ✅ | ✅ |
| local | `${cwd}/.code-shell/settings.local.json` | ❌ | ✅ | ✅ |
| flag overrides | (调用方显式传入) | ✅ | ✅ | ✅ |

设计要点:
- **flag overrides 任何档都生效**。它不是磁盘读取,是调用方显式传入的;隔离的目标是"不静默捡磁盘上的宿主配置",显式传入的不在隔离范围内。
- **managed 跟 user 同档处理**。managed.json 也在 `~/.code-shell/` 下,同样是宿主机物件;隔离档语义统一为"不碰宿主 `~/.code-shell` 的任何东西"。不为 managed 单独建模。
- **默认值是 `'project'`**,即安全默认。

### 3.2 `SettingsScope` 类型放置

类型定义放在 `packages/core/src/settings/manager.ts`(与 `SettingsSourceName` 同处),并从 core 的 barrel(`packages/core/src/index.ts`)export,供 SDK 调用方使用:

```typescript
export type SettingsScope = "isolated" | "project" | "full";
```

### 3.3 `SettingsManager` 接受 scope

`SettingsManager` 构造函数增加可选 scope 参数(默认 `'project'`):

```typescript
constructor(
  private readonly cwd: string = process.cwd(),
  private readonly scope: SettingsScope = "project",
) {}
```

`load()`(`manager.ts:48-71`)按 scope gate 各层读取:

```typescript
load(flagOverrides?: Record<string, unknown>): ValidatedSettings {
  this.sources = [];
  const readUser = this.scope === "full";
  const readProject = this.scope !== "isolated";

  if (readUser) {
    this.loadJsonFile(join(userHome(), ".code-shell", "settings.managed.json"), "managed", 0);
    this.loadJsonFile(join(userHome(), ".code-shell", "settings.json"), "user", 1);
  }
  if (readProject) {
    this.loadJsonFile(join(this.cwd, ".code-shell", "settings.json"), "project", 2);
    this.loadJsonFile(join(this.cwd, ".code-shell", "settings.local.json"), "local", 3);
  }
  // flag overrides 始终生效
  if (flagOverrides && Object.keys(flagOverrides).length > 0) {
    this.sources.push({ name: "flag", priority: 4, data: flagOverrides });
  }
  // ...排序、合并、migrate
}
```

注意 `load()` 末尾的 model migration(`manager.ts:83+`)直接读 user 文件做写回。**migration 也必须 gate 在 `readUser` 之下** —— 隔离档下不该读、更不该写宿主的 user 文件。

### 3.4 Engine 透传 scope

`Engine.getSettingsManager()`(`engine.ts:1586`)把 `config.settingsScope` 传给 `SettingsManager`:

```typescript
private getSettingsManager(): SettingsManager {
  if (!this.settingsManager) {
    this.settingsManager = new SettingsManager(
      this.config.cwd,
      this.config.settingsScope ?? "project",
    );
  }
  return this.settingsManager;
}
```

默认 `'project'` 在两处保证:`EngineConfig.settingsScope` 不传时此处兜底,`SettingsManager` 构造默认值再兜一层。两者一致。

### 3.5 三个入口显式声明 scope

为保持 TUI / desktop / CLI 现有行为(读 user + project),这些入口需显式传 `'full'`:

- **TUI run**:`packages/tui/src/cli/commands/run.ts:106` `new SettingsManager(cwd)` → `new SettingsManager(cwd, "full")`;并在 `new Engine({...})`(`run.ts:173`)处传 `settingsScope: "full"`。
- **TUI repl**:`packages/tui/src/cli/commands/repl.ts:58` 同上;`repl.ts:149` Engine 同上。
- **desktop worker**:`packages/core/src/cli/agent-server-stdio.ts:47` `new SettingsManager(cwd, "full")`;`agent-server-stdio.ts:61` Engine 同上。

这三个入口都走"先建 SettingsManager → 塞进 EngineRuntime → Engine 复用 runtime 的 settings"的路径。因此 scope 真正生效的地方是这些入口**自己 new 出来的那个 SettingsManager**;Engine 上的 `settingsScope` 字段对走 runtime 注入的入口不参与 SettingsManager 构造(runtime 已经提供了 settings),但仍需设置以便子 agent 继承(见 3.6)。

### 3.6 子 agent 继承父级 scope

子 agent 由 `Engine.spawn()`(`engine.ts:563-577`)创建新 Engine。spawn 时把父级 scope 原样传给子 Engine:

```typescript
const child = new Engine({
  // ...现有字段...
  settingsScope: this.config.settingsScope ?? "project",
  isSubAgent: true,
});
```

子 agent 跑在与父级相同的 cwd / 会话里,scope 一致才合理:父是 TUI(full)→ 子也 full(能读用户配的 model/MCP);父是 SDK(默认 project / 或 isolated)→ 子同样隔离。scope 由最外层入口决定,往下一路继承。

子 Engine 不走 runtime 注入(`engine.ts:563` 不传 runtime),会自行 `getSettingsManager()`,因此 3.4 的透传对子 agent 直接生效。

## 4. 数据流

```
入口 (TUI/desktop/CLI)            SDK 调用方
  │ 显式 settingsScope:'full'        │ 默认(不传)→ 'project'
  │                                  │ 或显式 'isolated'
  ▼                                  ▼
EngineConfig.settingsScope ──────────┘
  │
  ▼
Engine.getSettingsManager()
  │  new SettingsManager(cwd, scope)
  ▼
SettingsManager.load()
  readUser    = scope==='full'
  readProject = scope!=='isolated'
  │
  ▼
按 gate 读取磁盘层 → 合并 → ValidatedSettings

Engine.spawn() ──► 子 Engine(settingsScope 原样继承)──► 同上
```

## 5. 错误处理与边界

- **scope 未知值**:TypeScript 类型已约束为三档;运行时若收到非法值(JS 调用方),`load()` 的 `readUser`/`readProject` 布尔计算会安全地落到"都不读"(等同 isolated),不抛异常 —— 失败方向偏安全。
- **migration 写回**:隔离/project 档下完全不触碰 user 文件读写(3.3)。
- **flag overrides**:三档均生效,不受影响。
- **runtime 注入入口**:scope 生效于入口自建的 SettingsManager;Engine 字段仅用于子 agent 继承。这一不对称在 3.5 注明,实现时需在三个入口同时设置 SettingsManager 的 scope 和 Engine 的 settingsScope 字段,保持一致。

## 6. 测试

单元(`SettingsManager`):
- 在临时 HOME + 临时 cwd 下铺设 managed/user/project/local 四个文件,分别用三档 scope 调 `load()`,断言合并结果只含应读层级的键。
- isolated:仅 flag overrides 生效,磁盘四层全不读。
- project:只读 project+local,user+managed 不进结果。
- full:四层全读(现状回归)。
- 隔离/project 档下,即使 user 文件存在 legacy `models[]`,migration 不被触发(不写回 user 文件)。

集成(Engine):
- `new Engine({ cwd, llm })` 不传 scope → SettingsManager 以 'project' 构造(断言不读 user)。
- `new Engine({ cwd, llm, settingsScope: 'full' })` → 读 user。
- spawn 子 agent → 子 Engine 的 settingsScope 等于父级。

入口回归:
- TUI run/repl、desktop worker:断言传了 'full',读取行为与改动前一致。

## 7. 改动文件清单

| 文件 | 改动 |
|---|---|
| `packages/core/src/settings/manager.ts` | 加 `SettingsScope` 类型;构造函数加 scope 参数(默认 'project');`load()` 按 scope gate 各层 + migration |
| `packages/core/src/index.ts` | export `SettingsScope` |
| `packages/core/src/engine/engine.ts` | `EngineConfig` 加 `settingsScope`;`getSettingsManager()` 透传;`spawn()` 子 agent 继承 |
| `packages/tui/src/cli/commands/run.ts` | SettingsManager + Engine 传 'full' |
| `packages/tui/src/cli/commands/repl.ts` | 同上 |
| `packages/core/src/cli/agent-server-stdio.ts` | 同上 |

## 8. 非目标(YAGNI)

- 不引入 `CODE_SHELL_HOME` / 独立配置目录(方案 C 已否决)。
- 不为 managed 单独建模 scope。
- 不做 `preloadedSettings` 对象注入(flag overrides 已覆盖"显式传配置"的需求)。
- 不改 desktop 的 `settings-service.ts`(renderer 的读写接口,与 Engine 配置加载无关)。
