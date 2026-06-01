# Renderer 重连 / 事件不丢失 — 设计文档

日期:2026-06-02
状态:待审

## 1. 背景与问题(已实锤)

### 症状

会话 `s-mpvdy41w-fbde8fa0`(读 core 源码的长任务,promptTokens 1100 万 / turn 99):worker
重启后 resume 同一 engine 会话,**仍在工作、仍在写文件**(`docs/core-source-file-index.md`
在 00:17 被写出,`turn_complete` 在 00:18:51 正常发出),但**前端 UI 这一轮完全空白**
——"session 都一样,却连不上"。

### 根因(日志证据)

- `app.mount` 在 16:18:51 / 16:19:21 / 16:20:11 / 16:20:17 反复出现 → **renderer 在反复重新挂载**。
- `lifecycle exited/restarted` 一条都没有 → **worker 没崩,重挂的是 renderer 自己**。
- `run.resolved`(16:18:37)+ `turn_complete`(16:18:51)都正常 → 后端这一轮成功、有产出。

前端"连得上某会话"只依赖 renderer 内存里的路由表 `engineToBucketRef`(`engineSessionId → bucket`):

```
App.tsx:632  const fromTable = env.sessionId ? engineToBucketRef.current.get(env.sessionId) : undefined;
App.tsx:633  const target = fromTable ?? runningBucketRef.current;
App.tsx:634  if (!target) return;            // ← 查不到就静默丢弃事件
```

这张表:**只在 `send()`(822)写入、`session_started`(660)加固**;renderer 一重挂就归零
(ref 重新初始化为空 Map),`exited`(782)还会主动 `clear()`。worker resume 后发的事件,
因为表里没这条路由 → 632 miss → 633 `runningBucketRef` 也 null → **634 裸 `return` 丢弃**。

→ **"连接"这个事实只活在随时会清零的 renderer 内存里,且只能由"用户主动发送"建立,无法恢复。**

## 2. 参考:Codex Desktop 怎么做(本机实测)

- 事实源 = 磁盘 append-only JSONL "rollout",一个 session 一个文件,路径带 session id。
- 每条事件带 `timestamp` + `turn_id`(UUIDv7,粒度=轮次,非 session id、非事件序号)。
- **整条 UI 可见事件流全部落盘**(连 token_count / task_complete 都落)。
- session 内全序靠**文件追加顺序**,timestamp 兜底;**无显式 seq 字段**。
- 重连 = 按 session id 重新订阅 + 读 rollout 对齐。UI 是投影,事实在磁盘。

## 3. codeshell 现状对照(本机实测 transcript.jsonl)

`~/.code-shell/sessions/<id>/transcript.jsonl` 每条事件字段:

| 字段 | 含义 | 对游标的价值 |
|---|---|---|
| `id` | 每条事件唯一 id | **去重键 / 游标**(比 Codex 还强,Codex 无事件级 id) |
| `type` | session_meta / message / tool_use / tool_result / turn_boundary | |
| `timestamp` | 毫秒 | 排序兜底 |
| `turnNumber` | **单调递增整数 0,1,2…** | 轮次定位(比 Codex 的 UUID turn_id 好用) |
| `data` | 载荷 | |

外加显式 `turn_boundary` 事件标记轮次边界。

**结论:codeshell 已具备 Codex 那套 80% 的基础设施,且游标字段(`id` + `turnNumber` + `timestamp`)
现成,无需发明 seq。** 缺的 20% = "按 id 重连(快照+增量对齐)",正是 bug 全部。

## 4. 关键决策(已与用户确认 — 学 Codex:main 持共享快照)

Codex 实证(见 §2):renderer↔main 是**泛化订阅总线 + main 持共享快照**;renderer 启动时
`get-shared-object-snapshot` 同步拉快照,之后 `subscribeToWorkerMessages` 订阅增量,刷新后
重新 subscribe 即可,不绑"哪次发起"。**用户确认走这条:把连接状态/快照放进 main 进程。**

### 4.1 main 进程(AgentBridge)持每 session 的事件快照

`AgentBridge` 已是 **process-global、不随 renderer 重挂**,且**所有 `worker→renderer` 事件都过它**
(`agent-bridge.ts:113 safeSend("agent:msg", line)`)。它就是天然的快照宿主。

- 在转发的同时,按 `sessionId` 把事件累积进一份内存快照(`Map<sessionId, EventLog>`)。
- 快照保留足以重建 UI 的事件(text/tool/turn 边界等);可设上限(如每 session 最近 N 条 / 截至上次
  turn_complete),超限部分由磁盘 transcript 兜底回读。
- renderer 重挂不影响它——这正是根治"刷新即失联"的关键。

### 4.2 renderer 重连 = subscribe(sessionId) + 拉快照 + 订阅增量

新增 main↔renderer IPC:
- `agent:subscribe(sessionId)` → main 返回该 session 的**当前快照**(及游标 = 最后事件 `id`)。
- 之后 main 对该 session 的新事件继续 `safeSend` 增量;renderer 按 `id` 去重对齐快照接缝。
- renderer 启动/挂载时对所有在途 session 自动 subscribe;`engineToBucketRef` 退化为纯缓存。

### 4.3 磁盘 transcript 作为快照的兜底/超长回读

main 快照有上限;断点过久(快照已淘汰)时,renderer 回读 transcript.jsonl 补齐(见 §5 约束:
需读原始事件流而非 FoldItem)。常态走 main 快照(快),超长才回读磁盘。

### 4.4 `exited` 不再 clear 路由表

worker 崩溃重启 resume 同会话时,清表正是失联根源之一。`exited` 时只清 `runningBucketRef`
和 busy 标记,**路由表保留**;且 main 快照不因 worker exit 而清(快照属于 session,不属于 worker 生命周期)。

## 5. 已知约束(落地时必须解决)

**`getSessionTranscript` 当前返回 `FoldItem[]`,不是原始事件流。**

- `transcript-reader.ts:42 transcriptToFoldItems` 把原始事件转成 `FoldItem`(kind: stream/user/…),
  **转换中丢掉了事件级 `id`**,`turnNumber` 仅部分保留在 stream event 内。
- 游标去重依赖原始 `id`。因此**必须新增一个"读原始事件流(保留 id/turnNumber/timestamp)"的 main API**,
  例如 `getSessionEvents(sessionId, sinceId?)`,而非复用 fold 后的 `getSessionTranscript`。

## 6. 三层职责(目标架构 — main 持快照)

```
core/worker ──事件──▶ main / AgentBridge ──IPC──▶ renderer(薄客户端)
   │                    │ ① 转发(已有)
   │                    │ ② 按 sessionId 累积快照(新)  ◀── 不随 renderer 重挂
   └─ append transcript.jsonl(磁盘 = 超长兜底)        │ ③ subscribe → 返快照+游标(新)
```

- **core/worker**:继续 append 事件到 transcript.jsonl(已有,不改)。
- **main / AgentBridge**:
  - ① 实时转发 `agent:msg`(已有,`safeSend` line 113);
  - ② 新增 `Map<sessionId, EventLog>` 快照:转发时按 sessionId 累积(带上限);
  - ③ 新增 IPC `agent:subscribe(sessionId)` → 返回快照 + 游标(末事件 id);
  - ④ 新增 `getSessionEvents(sessionId, sinceId?)`(读原始事件流,带 id/turnNumber/timestamp)
    作超长兜底(见 §5)。
  - 快照**不随 worker exit 清除**(属 session,非 worker 生命周期)。
- **renderer(薄客户端)**:
  - `engineToBucketRef` 退化为**纯缓存**,丢失可重建。
  - **挂载/会话索引变化时**:对每个有 `engineSessionId` 的在途会话 `agent:subscribe(id)`,
    拉快照并预热路由表。
  - **`onStreamEvent` miss 时**:不裸 `return`;用 `env.sessionId` 反查 `sessionIndices` 得 bucket,
    回填路由表并投递(正确性下限)。
  - **去重对齐**:快照 + 增量推送按事件 `id` 去重,`turnNumber`+`timestamp` 排序。
  - **`exited`**:不再 `engineToBucketRef.clear()`。

## 7. 单元测试

- **main 快照**(`SessionSnapshotStore` 抽纯类):
  - `append(sessionId, event)` 累积;`get(sessionId)` 返回快照 + 游标(末 id);
  - 上限淘汰:超 N 条后丢最旧;`turn_complete` 截断策略;
  - worker exit 不清快照。
- **renderer 去重对齐**:`mergeByEventId(snapshot, incoming)` 按 `id` 去重、`turnNumber`+`timestamp` 排序。
- **renderer 路由**:`resolveBucket(sessionId, engineToBucket, sessionIndices, runningBucket)`:
  表命中→返回;miss 但 indices 有→反查回填;都没有→null;legacy(engineId≠uiId)→按 engineId 匹配。
- **main `getSessionEvents`**:空文件→[];`sinceId` 之后的尾部;`sinceId` 不存在→全量。

## 8. 分阶段(全部做齐,但有顺序)

1. **止血(纯 renderer,零 IPC 改动)**:`onStreamEvent` miss 反查兜底 + `exited` 不清表。
   任何重挂不再丢事件——先让当前卡住的会话能连上。
2. **main 快照宿主**:`AgentBridge` 加 `SessionSnapshotStore`,转发时累积;新增 `agent:subscribe`。
3. **renderer 薄客户端化**:挂载时对在途 session `subscribe` 拉快照 + 订阅增量 + 按 id 去重;
   `engineToBucketRef` 降级为缓存。
4. **超长兜底**:`getSessionEvents`(原始事件流)+ renderer 在快照淘汰时回读磁盘。

每步 TDD,直接在 `main` 分支提交(用户 Goal:直接在 main 分支完成)。

## 9. YAGNI(明确不做)

- 不引入 sqlite / 独立事件库 —— main 快照 + 磁盘 transcript.jsonl 已够。
- 不发明显式 seq 字段 —— `id` + `turnNumber` + `timestamp` 已够。
- 不学 Codex 的"泛化 worker 总线"重写整个 IPC —— 复用现有 `agent:msg` 通道,只加 `subscribe`。
