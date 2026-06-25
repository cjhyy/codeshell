# 记忆系统:全局/项目分流 + 召回生命周期(设计稿)

日期:2026-06-25
范围:codeshell 自己的记忆系统(`~/.code-shell/memory`),不涉及 Claude Code 那套。

## 背景与真因

用户体感:「全局 memory 从来没记上过」「感觉不到在 work」。

调研(CC / Codex / Cursor / Windsurf / Mem0 / 学术界)+ 读现有代码后确认真因:

1. **全局层一直空** —— 不是机制坏了,而是**提取和注入都被项目隔离切碎**:
   - `extract-memories` 提取出的记忆,经 `MemoryOrchestrator` 一律存进 `new MemoryManager({ projectDir })`(项目级),无论这条经验是否跨项目通用。
   - `composer.getMemoryContext()` 注入时也只 `new MemoryManager(cwd)`(项目级),全局 `new MemoryManager()`(无 projectDir)从不被注入。
   - 记忆工具 `mmFor(ctx)` 永远用 `ctx.cwd`,只读写项目级,全局既不写也不读。
   - 结果:`~/.code-shell/memory/{user,dream}` 永远空;Dream 产物全落 `projects/<hash>/memory/dream/`(实测 34 个,全局 0 个)。

2. **完成态只增不减** —— 提取无脑 `mm.save()` 新建,从不更新/删除;age 过滤只在注入期生效,磁盘只增。

3. **Dream 其实在跑**(`lastDreamAt` 在更新),但只按项目跑、且只整理 dream scope,从不沉淀跨项目经验到全局。

## 用户心智模型(设计的锚)

- **通用工作经验/护栏**(换个项目还成立)→ **全局**。例:「判死代码先 grep」「git 子进程加 `--`」。
- **项目特定偏好/约定**(只适本项目)→ **项目级**。例:「seedance 要短剧风格」「这个 repo 走 worktree」。

判定关键:**「这条换个项目还成立吗?」** 成立→global,不成立→project。

## 两条正交的轴(对齐现有代码,不新造概念)

现有代码已有两条轴,本设计**复用**:

| 轴 | 取值 | 含义 | 由谁决定 |
|---|---|---|---|
| **location**(本设计核心) | global / project | 存全局还是项目级 | `MemoryManager` 的 `projectDir` 有无 |
| **MemoryScope**(已有) | user / dream | 写权限语义(dream 可自由写) | 构造参数 `scope` |

「scope:global\|project」= location 轴 = **projectDir 有无**,与 MemoryScope 无关。提取出的记忆仍走 `user` MemoryScope,只是按 location 选 global 还是 project 的 MemoryManager 落盘。

## 本期范围:A + B + C(+ 注入两层 + 可见性)

D(入库前审批门)下期。

### A. 提取时判 location 并据此落盘

- `ExtractedMemory` 加字段 `scope: "global" | "project"`(命名沿用用户语汇;内部即 location 轴)。
- `buildExtractionPrompt` 加判定说明:「换个项目还成立 → global;只适本项目 → project」。
- `parseExtractionResponse` 解析 `scope`,缺省/非法 → `project`(保守:不误把一次性事件推全局)。
- `MemoryOrchestrator.run` 按 `entry.scope` 选 MemoryManager:
  - `global` → `new MemoryManager({ scope: "user" })`(无 projectDir)
  - `project` → `new MemoryManager({ projectDir, scope: "user" })`
  - 两个 manager 各 save,均打 `origin: "auto"`。

### B. 去重(不做 Reconcile,复用已有两条路)

不新建 Mem0 式入库 Reconcile 链。改为让已有的两条去重路径真正生效:

1. **运行中模型自更新** —— 记忆工具描述里引导:发现已有记忆过时/矛盾时,主动 `MemorySave`(同名覆盖)或 `MemoryDelete`。当下有完整上下文,质量最高。
2. **Dream 兜底** —— Dream consolidation 修为也能整理 global scope(现在只按项目跑);系统提示已含 merge/forget/archive-completed 规则,沿用。

记忆工具 `mmFor` 扩展为可寻址 global(见「注入两层」一节的工具改造)。

### C. 召回 TTL(usage 记账 + 不用就裁)

- `MemoryEntry` 加 frontmatter 字段:`usage_count`(默认 0)、`last_used`(ISO,缺省=created)、`created`(ISO,首次 save 时写,UPDATE 保留原值)。
  - 这些字段进 frontmatter,**不引 SQLite**(文件即单一真相,可 git diff)。
  - 向后兼容:旧文件无这些字段 → 读出时 `usage_count=0`、`created/last_used` 回退 mtime。
- **召回信号**:`MemoryRead` 命中一条 → 该条 `usage_count++`、`last_used=now`(原地改写 frontmatter,不动 content)。
- **召回 TTL 裁剪**(只作用 project 类、且仅 location=project 的库):
  - `type ∈ {user, feedback, reference}` 或 `pinned` → 免 TTL,永久留。
  - `type === "project"` → `now - last_used > recallTtlDays`(默认 30)→ 软删进 memory-trash。
  - 注意是「最后被**读到**」不是「创建时间」——常用的 project 记忆不会被裁。
  - 裁剪时机:在 `MemoryOrchestrator.run` 末尾顺手扫一遍(不另起调度)。

### 注入改两层(用户拍板,兼做可见性)

现状:`buildMemoryContext` 把所有记忆的 name+description 全量平铺进每轮 system context。

改为两层(类 CC MEMORY.md / Codex memory_summary):

- **注入层**:`composer.getMemoryContext()` 同时加载 **global + project** 两个库,内联一份**精简索引**(每条一行:`[scope][type] name: description`),并明确告诉模型:要用某条的全文,调 `MemoryRead`。
  - 不再注入 content;不再只看项目级。global 通用经验处处可见,这是修复「全局没用」的注入侧。
- **召回层**:模型按需 `MemoryRead(name)` 读全文 → 即召回信号:
  - `usage_count++` / `last_used=now`(C 块)。
  - 派 UI 事件 `memory_recalled { name, scope }` → 渲染端显示「📖 读取了记忆 X」,用户肉眼看到记忆被用上。

工具改造(`tool-system/builtin/memory.ts`):

- location 轴落到工具参数:`MemoryRead/List/Save/Delete` 的 `scope` 含义保持 user/dream(MemoryScope),**另加** `location?: "global" | "project"`(缺省 project,保持现状行为)。`mmFor` 据此选 projectDir 有无。
- `MemoryRead` 命中后:usage 记账 + 派 `memory_recalled` 事件(经 ToolContext 的事件 sink,若有)。

### 可见性(回答「感觉不到 work」)

1. **MemoryRead 时** UI 显示被读到(上面 `memory_recalled` 事件)。
2. **提取/裁剪决策走日志**:`memory.extraction_done` 已有,补 `scope` 维度;新增 `memory.recall_ttl_pruned { name, lastUsed }`。
3. **设置页记忆面板**:每条显示 location/type/usage_count/last_used/距裁还有几天(desktop,本期若 core 字段就绪即可加;UI 改动小)。

## 单元职责(边界)

| 单元 | 职责 | 改动 |
|---|---|---|
| `extract-memories.ts` | 提取候选 + 判 scope(global/project) | 加 scope 字段 + 提示词 + 解析 |
| `memory-orchestrator.ts` | 按 scope 路由落盘 + 末尾召回 TTL 裁剪 | 双 manager 落盘 + 裁剪扫 |
| `session/memory.ts` | frontmatter 读写(+usage/created/last_used)、召回记账、TTL 裁剪、软删 | 加字段 + `recordRecall()` + `pruneByRecall()` |
| `prompt/composer.ts` | 注入精简索引(global+project 合并) | 改 getMemoryContext |
| `tool-system/builtin/memory.ts` | 工具加 location 维度;Read 记账+派事件 | 加 location 参数 + 记账 |
| `auto-dream.ts` | Dream 也能整理 global scope | 提示/落盘允许 global |

不拆 engine.ts。不引向量库(全行业对单用户小库共识:关键词足够,LIMIT 论文佐证向量对代码标识符更差)。

## 错误处理

- 提取/裁剪全程 try/catch + logger.warn,绝不阻塞 Engine 结果(沿用现状 fire-and-forget)。
- `memory_recalled` 事件 sink 缺省时静默(no-op),不报错。
- frontmatter 新字段读取失败 → 回退默认(usage_count=0,created/last_used=mtime),永不因缺字段隐藏记忆。
- DELETE 一律软删进 memory-trash(可恢复)。

## 测试

- `extract-memories`:scope 解析(global/project/缺省→project/非法→project);提示词含判定语。
- `memory.ts`:save 写 created;UPDATE 保留 created;`recordRecall` 增计数+改 last_used;`pruneByRecall` 只裁过期 project 类、保 pinned/stable/常用。
- `memory-orchestrator`:按 scope 路由到 global vs project manager(用 CODE_SHELL_HOME 隔离临时目录断言落盘位置)。
- `composer`:注入索引同时含 global + project,不含 content。
- 向后兼容:旧 frontmatter(无新字段)能正常读、不被裁。

## 验收

- core `bun test` 绿(含新测试);core + desktop tsc 0;无回归。
- 真机:跨项目跑两轮,确认通用经验落全局、项目偏好落项目级;MemoryRead 时 UI 有提示;设置页能看到 usage/TTL。
- 测试隔离:所有写真实 `~/.code-shell` 的路径用 `CODE_SHELL_HOME` 临时目录(沿用 [[project_test_pollutes_real_settings]] 教训)。

## 范围外(下期 D)

入库前审批门(Cursor 1.2 路线:propose → approve 才入库)。牵涉 desktop 待审队列 UI,单独一期。
