# Undo 撤销系统(/undo 单步)设计

> 2026-06-07 · core + tui · 三大功能第二项

## 背景与现状

仓库里**已有两套互不连通的撤销机制**:

1. **`FileHistory`**(`packages/core/src/session/file-history.ts`)——改动前的**内容快照**(path+content-hash 命名的备份 + 持久化 index.json),`restore`/`restoreLatest`/`getSnapshots`/`getTrackedFiles`。`engine.ts:1609` 用 `on_tool_start` hook 在 **Write/Edit 前** 自动 `saveSnapshot`。**目前没有任何命令或 UI 调用它的 restore** —— 是个 orphan。
2. **desktop 逐卡撤销**(`FilesChangedCard` → `undoFiles`)——走 **git**(tracked → `git restore --source=HEAD`;untracked → `unlink`)。语义是"回到所有工作开始前的 HEAD",对非 git 项目无效。

## 决策(已确认)

- **底层用 FileHistory 快照**:语义 = 撤销到「上一次 AI 编辑前」,不依赖 git、不要求干净工作树、对非 git 项目也有效,最贴近用户对 `/undo` 的预期。
- **首版只做 `/undo`(单步)**:撤销最近一次文件修改。`/undo all`、git 兜底、desktop 按钮改造 —— 全部留后。

## 范围(YAGNI)

**做**:
- `/undo` TUI 命令:定位最近一次被快照的文件 → 显示 diff 预览 → 确认后 restore。
- 补 **ApplyPatch** 的 auto-backup(现仅 Write/Edit 有,ApplyPatch 同样改文件却没快照,会让 `/undo` 漏掉补丁式修改)。
- 纯函数把"最近修改"的选取逻辑抽出来单测。

**不做**(留后):`/undo all`、diff 预览的富交互(首版用文本 unified diff)、desktop UI 端 `/undo`(desktop 无 slash 系统,继续用逐卡按钮)、git 兜底、撤销 AI 之外的人工改动。

## 架构 / 数据流

```
TUI /undo (cli/commands/builtin/...)
  │ 1. sessionDir = <sessionStorageDir>/<sessionId>   (同 engine.ts:1603 推导)
  │ 2. fh = FileHistory.loadFromDir(sessionDir)
  │ 3. target = latestUndoTarget(fh.snapshots)   ← 新纯函数
  │      最近 timestamp 的快照;它的 backup = 该文件「上一次编辑前」内容
  │ 4. 读当前磁盘内容 + backup 内容 → 文本 unified diff 预览(addMessage)
  │ 5. 确认 = 两段式文本流(ctx 无 confirm 原语,且不值得为此引 Ink 弹窗):
  │      - 裸 `/undo`     → addMessage(目标文件 + unified diff 预览) + 提示「运行 /undo confirm 执行」
  │      - `/undo confirm` → 实际 restore;若距上次预览太久/历史已变可重新预览
  │      纯文本、零新 ctx plumbing、可单测。
  │ 6. fh.restore(target)   ← 已存在;restore 内部会先给当前态再存一个快照
  │      (= redo 的基础,本版不做 redo 但快照留着无害)
```

### 新增纯函数(可单测,DOM/fs-free)

```ts
// core: session/undo-target.ts
function latestUndoTarget(snapshots: FileSnapshot[]): FileSnapshot | null
//   返回 timestamp 最大的快照;空 → null。
//   多文件同毫秒并列时取数组中最后一个(稳定、可预期)。
```

把它放 core 并从 index 导出,这样 TUI 命令和未来 desktop 都能复用同一"最近一步"定义。

### ApplyPatch 备份补齐

`engine.ts` 的 `file_history_backup` hook 现在判 `toolName === "Write" || "Edit"`。ApplyPatch 的 args 不是单个 `file_path`,而是一个补丁(可能含多文件)。补齐方式:
- 在 hook 里加 `toolName === "ApplyPatch"` 分支,从补丁 args 解析出受影响文件路径列表,对每个**已存在**的文件 `saveSnapshot`(新建文件没有"改前"内容,saveSnapshot 本就返回 null,跳过)。
- 复用 ApplyPatch 已有的路径解析(`apply-patch/` 下 applier 能列出 target 文件);若解析接口不便复用,退而求其次在 hook 里轻量扫补丁头的 `*** Update File:` / `--- a/...` 行。实现期定具体接口,spec 不锁死解析手段,只锁"ApplyPatch 改前也要快照"这个契约。

## 边界与正确性

- **restore 会先给当前态存快照**(file-history.ts:100)——所以 `/undo` 后当前内容不丢,理论上可再 `/undo` 回去(redo 雏形),但本版不暴露 redo。
- **快照是 AI 编辑前**:若用户在 AI 编辑后又手动改了文件,`/undo` 会把手动改动一起覆盖回 AI 编辑前。首版接受此语义(与"撤销最近一次修改"一致),预览 diff 会让用户看到将丢什么再确认。
- **跨会话**:`/undo` 只看当前 session 的 FileHistory。换 session 后看不到上个 session 的快照——符合预期。
- **空历史**:无快照 → `addStatus("没有可撤销的文件修改")`,不报错。

## 测试 / 验收

- **单测** `undo-target.test.ts`:空→null;单快照→它;多快照取最新 timestamp;同毫秒取末位。
- **单测**(若 ApplyPatch 路径解析抽成纯函数)补丁→受影响文件列表。
- **集成/手动 smoke**:① Edit 一个文件后 `/undo` → 内容回到编辑前;② ApplyPatch 改文件后 `/undo` → 回到补丁前(验证 backup 补齐);③ 无修改时 `/undo` → 友好提示;④ diff 预览正确显示将还原的差异。
- **回归**:core 现有 file-history + apply-patch 测试全绿;`bun test src/` (core) + tui typecheck。

## 影响文件

- 新增:`core/src/session/undo-target.ts` + `.test.ts`;`tui/src/cli/commands/builtin/undo-command.ts`(注册进命令表)。
- 改:`core/src/engine/engine.ts`(hook 加 ApplyPatch 分支)、`core/src/index.ts`(导出 latestUndoTarget)、tui 命令注册处。
- desktop:本版**不改**(无 slash 系统;逐卡按钮维持现状)。
