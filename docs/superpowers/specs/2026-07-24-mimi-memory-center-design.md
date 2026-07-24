# Mimi 记忆中心与 Segment 收尾统一 Pipeline 设计

日期:2026-07-24
状态:待评审

## 背景与现状

仓库里存在两套互不相干的 memory 系统:

- **Pet(mimi)记忆**:`packages/desktop/src/main/pet/pet-memory-store.ts`,扁平文本条目存
  `<userData>/pet/memories.json`,上限 200 条,`source: "user" | "mimi"`,纯手动逐条增删
  (用户在工作台 `PetMemorySection` 里加,或 mimi 用 `Memory` host-action 工具记)。
- **core 会话记忆**:工作 session 结束后 aux 模型自动提取,写入
  `~/.code-shell/memory/` 的 user/dream/pending 分层体系,并生成
  `session-memories/<id>.json` 收尾摘要。

mimi 的主对话是一个**永不结束的 engine session**(`petSessionId`),没有 session 概念,
由此产生三个问题:

1. **记忆纯手动**:mimi 对话中的偏好、事实没有自动沉淀,与 core 侧体验割裂。
2. **历史无限增长**:renderer 启动时 `getSessionTranscript` 全量 hydrate 整个
   transcript(`PetStateProvider.tsx:271-283`),UI 消息列表只增不减;唯一的折叠来自
   engine 触顶 compaction 产生的 `context_boundary`,不触顶永不折叠。
   模型上下文同样持续膨胀,token 成本和延迟随之上升。
3. **无处回看**:已完成事件没有整理入口;session 收尾摘要类的能力 mimi 侧没有;
   历史原文虽然都在 transcript.jsonl 里,但没有查看器。

已有可复用的积木:

- `PetSegmentController`(`pet-segment-controller.ts`):空闲超过 idleMs 时切段
  (topic segment),生成 carryover brief;内置 `archiveRange` seam 接
  `engine.archiveTurnRange`,当前休眠(委派收尾拿不到可靠 turn 范围)。
- `engine.archiveTurnRange(sessionId, {start, end})`(`engine.ts:3585`):把指定
  消息范围用主模型摘要**替换**(非删除),billing 记在 session 上。
- `pet-summary-service.ts`:aux 模型一次性调用的完整范式(settings 解析、
  `requestVisible:false`、空值 marker、持久缓存)。
- `packages/pet/src/disclosure/`:磁盘 transcript 的只读读取(jsonl 解析、搜索)。

## 决策记录(与用户确认)

1. **素材只从 mimi 对话提取**;core 的 memory / session-memory 体系完全不动、不接入。
2. **自动提取直接写入**,标 `source: "auto"`,不做待确认收件箱;靠上限 + 可删兜底。
3. **事件档案只包含 mimi 对话段落小结**(不含工作 session 摘要、不含委派任务收尾)。
4. **模型上下文主动压缩纳入第一版**:segment 收尾时 `archiveRange` 压缩刚关闭的段。

## 目标

- mimi 的记忆管理收拢到专门页面(从设置页进入),支持自动提取。
- 已完成的对话段落自动整理成「事件档案」时间线,可回看原文。
- 聊天 UI 与模型上下文都不再无限增长:老段落折叠为档案卡片 / 压缩为摘要。

## 非目标

- 不改 core 的 memory 提取、dream、pending 体系。
- 不做置信度分流、待确认审批、周/月巩固总结、向量检索(留待后续版本)。
- 不给 mimi 引入显式 session 概念——segment 就是 mimi 的"隐形 session"。

## 总体架构:一个收尾时机,四份产出

**segment 收尾**(`PetSegmentController.beginTurn` 检测到 idle 切段的那一刻)是唯一的
处理时机,fire-and-forget,不阻塞新 turn:

```
segment 关闭
  ├─ 1. 定位范围:从 petSessionId 的 transcript 中把边界 clientMessageId
  │      映射为消息 index 区间 {start, end}
  ├─ 2. aux 模型一次调用 → { title, summary, memories: [0-2 条候选] }
  ├─ 3. journal:{title, summary, 时间范围, range} → PetJournalStore(事件档案)
  ├─ 4. memory 候选:canonicalMemoryText 精确去重后
  │      petMemoryStore.remember(text, "auto")(UI 折叠、上下文压缩共享此产出)
  └─ 5. archiveRange(petSessionId, range):模型上下文中该段被摘要替换
```

- 步骤 2 失败:整段跳过,仅记日志,不重试(下个 segment 自然再来)。
- 步骤 5 与 3/4 解耦:archive 失败不影响 journal/memory 已写入的结果;
  engine 触顶自动 compaction 仍是兜底。
- **补偿**:app 启动时检查最近若干已关闭 segment 是否有对应 journal 条目
  (按 segmentId),缺失则补跑,防止退出丢失。
- 门槛:段内 user+assistant 消息 < 3 条整段跳过。
- 消息文本送入 LLM 前脱敏(密钥模式过滤,参照 core `sanitizeContent` 的做法)。

### 新组件:`pet-segment-closure-service.ts`(main/pet)

仿 `pet-summary-service` 的模式:读 settings 解析 aux 模型(回退 defaults.text)、
单次 tool-less `createMessage`、`requestVisible:false`、`maxTokens` 有界。
prompt 要求输出单个 JSON `{title, summary, memories[]}`,解析复用 extractJSON 式
容错;memories 每条 ≤ 200 字,最多 2 条,禁止密钥/临时状态。

## 数据层

### PetMemoryEntry 扩展(向后兼容)

```ts
source: "user" | "mimi" | "auto";      // 新增 "auto"
segmentId?: string;                     // 可选:提取自哪个 segment(回链)
```

存储文件与 version 不变;驱逐策略更新:满时先驱逐最老的 `auto`,其次最老的
`mimi`,`user` 条目始终保护(沿用 oldestMimiEntry 的思路扩一级)。

### 新增 PetJournalStore(main/pet/pet-journal-store.ts)

- 存储:`<userData>/pet/journal.json`,`{version: 1, entries: []}`,
  原子写 + mutation 串行化(直接仿 `pet-memory-store.ts`)。
- 条目:

```ts
interface PetJournalEntry {
  id: string;
  segmentId: string;          // 幂等键:同一 segment 不重复写入
  title: string;
  summary: string;
  startedAt: number;
  endedAt: number;
  messageCount: number;
  range: { start: number; end: number };   // transcript 消息 index 区间,供原文回看
}
```

- 上限 500 条,满时驱逐最老;newest-first 排序。

## IPC 与 preload

- `getSessionTranscript(sessionId, opts?)` 增加 `{ tail?: number }` 与
  `{ range?: {start, end} }` 两种有界读取(默认行为保持全量,避免破坏其他调用方)。
- 新增 `pet.journal.list()` / `pet.journal.onChanged(cb)`。
- `petPreferences` 增加 `autoExtract: boolean`(默认开);关闭时收尾 pipeline
  跳过步骤 2-4(不再产出 journal 与记忆),但步骤 5 的上下文压缩**不受开关影响**
  ——archiveTurnRange 自带摘要能力,不依赖步骤 2 的产出;否则关掉开关又回到
  上下文无限膨胀。

## UI

### 1. 记忆中心页(新,`renderer/pet/PetMemoryCenterPage.tsx`)

入口:`PetSettingsPage` 新增「记忆」卡片。页面两个 tab:

- **长期记忆**:现有 `PetMemorySection` 的完整管理迁移至此(列表/编辑/删除/手动
  添加),加来源徽标(user / mimi / auto)与自动提取开关。
- **事件档案**:journal 时间线,按天分组;每条展示 title,展开见 summary,
  「查看原文」打开 transcript 查看器并定位到该 range。

### 2. 工作台 `PetMemorySection` 缩减

只读显示最近若干条 + 「管理记忆」跳转记忆中心;移除内联增删改。

### 3. 聊天历史分层加载(`PetStateProvider` + `PetChatHost`)

- **hydration 只取尾部**:启动时按最近的 journal `range` 边界,加载「当前活跃
  segment + 上一个已关闭 segment」的消息;无 journal 时按条数兜底(最多 200 条)。
- **顶部「更早的对话」区域**:显示 journal 卡片(title + summary)代替原文,
  倒序分页(「加载更早」按 segment 批量取卡片);点开某张卡 → 以 `range`
  lazy 加载该段原文,渲染在卡片内(只读)。
- 现有 `context_boundary` 折叠、segment-divider、carryover brief 卡片行为保持。

### 4. transcript 原文查看器(新,只读)

事件档案「查看原文」与聊天卡片展开共用同一组件:按 `range` 读取消息,
沿用聊天气泡渲染,只读、可滚动加载相邻范围。

## 错误处理汇总

| 故障 | 行为 |
|---|---|
| aux 模型未配置 / 调用失败 | 记日志,整段跳过,不重试 |
| JSON 解析失败 | 丢弃本次产出,记日志 |
| archiveRange 失败 | 记日志;journal/memory 已写入不回滚;engine 兜底 compaction |
| app 中途退出 | 启动补查:已关闭 segment 无 journal 条目则补跑 |
| journal/memory 写入竞争 | 沿用 store 的 mutation 串行化;segmentId 幂等去重 |

## 测试策略

- 纯函数单测:closure prompt 构建与解析、边界 clientMessageId → index 定位、
  驱逐策略、journal 幂等。
- store 单测:PetJournalStore 原子写/上限/排序(仿 pet-memory-store.test.ts)。
- controller 集成:idle 切段触发收尾 pipeline 的时序(注意:现有 ~14 个手工
  engine fake 因 Engine setter 变更需要同步,见既有测试基建现状)。
- renderer:tail hydration、journal 卡片折叠/展开 lazy 加载的组件测试。

## 实施切分建议

1. 数据层:PetMemoryEntry.source 扩展 + PetJournalStore。
2. 收尾 pipeline:closure service + segment controller 挂接 + 启动补偿 + archiveRange 激活。
3. IPC:transcript 有界读取 + journal 通道 + autoExtract 偏好。
4. UI:记忆中心页 → 聊天 tail hydration + 「更早的对话」卡片 → 原文查看器 → 工作台缩减。
