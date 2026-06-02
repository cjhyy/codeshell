# disk 作权威源 + 会话/项目可恢复(学 Codex)

日期:2026-06-02
状态:待审

## 1. 背景与问题(已实锤)

用户清空了浏览器 localStorage,**所有会话数据"全没了"**——尽管 disk 上有 **841 个完整 session**
(`~/.code-shell/sessions/<id>/` 含 `state.json` + `transcript.jsonl`)。根因:

- **前端把 localStorage 当唯一真相源**:
  - 会话列表 `sessionIndices`、项目列表 `repos` 都只存 localStorage(transcripts.ts)。
  - 内容 hydrate:普通会话 `base = local` —— **只读 localStorage,不读 disk**
    (App.tsx:342);只有 `source==="automation"` 才 fold disk(:343)。
- disk 上权威完整的 `state.json`(sessionId/cwd/summary/startedAt)+ `transcript.jsonl`
  前端基本不消费。
- 连带:`listSessions`(sessions-service.ts:23)是**旧扁平布局**实现(`if (!e.isFile())`
  跳过目录),**漏掉全部 841 个目录式会话**,所以即便想从 disk 列举也列不出来。

→ localStorage 清空/丢失/schema 升级清理 = 列表、项目、内容全丢。这也是之前那个
「23 命令孤儿组」的同源问题(merge 脆弱),根治权威源即一并解决。

## 2. 参考:Codex(本机实测)

**磁盘 = 会话列表 + 历史的唯一权威源,浏览器存储不参与持久化。**

- 列表源:扫 `~/.codex/sessions/**/rollout-*.jsonl`(60 个文件 = 60 会话)。
- 每会话元数据:rollout **第一行 `session_meta`**(id/cwd/timestamp/model/git…)。
- 历史内容:读该会话 rollout 全文。
- 列表用 **`cursor`/`limit` 分页**(asar 实测 24+12 处),不一次性全扫。
- 浏览器 localStorage 只存 UI 偏好,不存会话。

**对照:你们已具备 Codex 的全部磁盘素材**(state.json↔session_meta,transcript.jsonl↔rollout),
只差"前端把 disk 当权威源去读 + 列表分页重建"。本设计即补这一层。

## 3. 关键决策(已与用户逐条确认)

| 决策 | 选择 |
|---|---|
| 恢复范围 | **列表 + 内容都能恢复** |
| 列表重建策略 | **懒加载/分页**(学 Codex,`{limit, cursor}`,不全扫 841) |
| 权威关系 | **disk 权威,localStorage 降为缓存** |
| 列表重建触发时机 | **localStorage 缺失/某 repo 列表为空时才拉 disk**(日常零扫盘) |
| 无匹配项目的 disk 会话 | **自动按 cwd 重建项目**(复用 createRepoForCwd) |
| 子代理 session 过滤 | **给 state.json 加 parentSessionId,重建时过滤带父的**(根治) |

## 4. 设计

### A. listSessions 修复 + 分页(main)

`sessions-service.ts` 的 `listSessions` 改为扫**目录式**会话:

```
listDiskSessions({ limit, cursor }): { sessions: DiskSessionMeta[]; nextCursor: string | null }
  - readdir(SESSIONS_DIR, withFileTypes) → 只取 isDirectory() 的 <id>
  - 按目录 mtime 降序排序(最近优先)
  - 从 cursor 位置取 limit 个;对每个读 <id>/state.json →
      DiskSessionMeta { id, engineSessionId:id, cwd, title:summary, updatedAt }
  - 返回 sessions + nextCursor(下一页起点;无更多则 null)
  - state.json 缺失/损坏 → 跳过该目录(不抛)
```

纯逻辑(排序/分页/解析)抽出可单测;fs 读用 baseDir 注入测试。
保留旧 `listSessions`(扁平)或并入——落地计划定。preload 暴露 `listDiskSessions`。

### B. 列表/项目重建(renderer,缺失才触发)

启动加载 `sessionIndices` 时,对**为空的 repo**(或 localStorage 整体缺失)拉 disk 第一页:

```
若 sessionIndices[repoKey] 为空:
  page = listDiskSessions({ limit: 30 })
  for s in page.sessions:
    repoId = matchRepoIdForCwd(s.cwd) ?? createRepoForCwd(s.cwd)   // 无匹配→自动建项目
    upsertImportedSession(repoId, { id:s.id, engineSessionId:s.id, title:s.title,
                                    source: undefined, updatedAt:s.updatedAt, ... })
  侧边栏滚到底 → 拉 nextCursor 下一页
```

- localStorage 有列表时**不触发**(快,零扫盘)。
- 项目随之自动重建(state.json 的 cwd → matchRepoIdForCwd/createRepoForCwd)。

### C. 内容 hydrate 改 disk 优先(renderer)

打开**任意**会话(不再限 automation):

```
disk = foldTranscript(getSessionTranscript(engineId))     // 权威基底
state = disk.messages.length
        ? mergeTranscripts(disk, local)                   // 同步点版:仅补 disk 未 flush 的尾巴
        : local                                           // disk 没有(纯前端新会话)→ 用 local
```

- 普通会话不再 `base = local`;disk 优先。
- 复用已修的 `mergeTranscripts`(同步点逻辑,不再追加 disk 已覆盖的 live 残留)。
- 顺带根治「23 命令孤儿组」(顺序以 disk 为准,真实数据已验证末项为 assistant 答复)。

### D. localStorage 角色

降为**缓存 + 未 flush 尾巴**:仍 saveTranscript 加速下次打开;但它不再是唯一源,清空可从 disk 重建。

## 5. 组件与改动面

- `core/session/session-manager.ts` + SessionState 类型:加 `parentSessionId?`,子代理 child.run 写入(§E)。
- `main/sessions-service.ts`:`listDiskSessions`(扫目录+读 state.json+分页+过滤 parentSessionId/启发式);纯函数抽离可单测。
- `main/index.ts` + `preload`:暴露 `listDiskSessions({limit,cursor})` + 类型 `DiskSessionMeta`。
- `renderer/App.tsx`:① 列表加载时空 repo 拉 disk 重建(B);② hydrate 改 disk 优先(C)。
- `renderer/transcripts.ts`:复用 `upsertImportedSession`;可能加"从 DiskSessionMeta 建 summary"小helper。
- 复用:`foldTranscript`、`getSessionTranscript`、`mergeTranscripts`(同步点版)、`matchRepoIdForCwd`、
  `createRepoForCwd`(automation liveSession 那套)。

## 6. 测试(纯函数优先)

- `listDiskSessions` 分页/排序(纯逻辑 + fs):空目录→[];按 mtime 降序;limit/cursor 正确;
  state.json 缺失跳过;只取目录不取文件。
- 列表重建归并:空 repo 用 disk 页填充;cwd 匹配既有项目 vs 自动建项目;不重复(engineSessionId 去重)。
- hydrate disk 优先:disk 有→mergeTranscripts(disk,local);disk 空→local。
- 回归:孤儿组——真实/构造 transcript 经 disk-优先 hydrate 后末项非 turn_process_group。

## 7. YAGNI(明确不做)

- 不做"每次开屏全扫 disk 合并"(用户改选:localStorage 缺失才拉,日常零扫盘)。
- 不做跨设备同步 / 远程存储。
- 不迁移 localStorage schema(它降为缓存,清了能重建,无需迁移)。
- 不改 disk 落盘格式(engine 已写 state.json + transcript.jsonl)。

## 8. 边界/风险

- **engineSessionId↔目录名**:disk 目录名即 engine sessionId;重建的 UI 会话 id 用同值
  (与 automation import 一致,`id === engineSessionId`),使路由/去重一致。
- **841 目录性能**:分页只读首页 N 个 state.json;readdir+stat 排序是 O(n) 轻量,首屏可接受。
- **不破坏现状**:localStorage 有数据时路径不变(快);disk 仅在缺失/打开时介入。
### E. 子代理 session 过滤(关键,否则侧边栏被淹没)

**实测**:disk 841 个 session 里只 **34 个 `s-` 前缀的疑似顶层交互会话,807 个**是子代理 /
派生 session(summary 多为"你是只读分析子代理…"/"只读探索…")。**`state.json` 当前没有任何
字段区分顶层 vs 子代理**(子代理与顶层字段集完全一致)。无过滤重建 → 侧边栏被 807 条噪声淹没,
方案不可用。

**根治(用户定)**:给 `SessionState`(session-manager.ts 写 state.json)加 **`parentSessionId?: string`**。
- 落点:子代理经 `child.run()` 创建(engine.ts:873,"subagents inherit parent's scope"),
  child Engine 有 parent sessionId 上下文 → 创建子 session 时写入 parentSessionId。
- 重建列表时:`listDiskSessions` 跳过 `parentSessionId != null` 的目录。

**存量边界(用户定:不自动重建,手动处理)**:已存在的 807 个旧 session **没有 parentSessionId
字段**。决策:`listDiskSessions` 的过滤规则 = **只返回带 parentSessionId 字段、且值为 null/空
(即顶层)的会话;完全没有该字段的旧 session 一律跳过**(视为存量,不自动重建,用户手动管理)。
- 零误判:新会话靠精确字段区分顶层/子代理;旧会话不碰。
- 代价(已知):用户这次被清空的旧会话(那 34 个 s-)不会自动回来——用户接受,手动处理。
- 实现简化:无需任何 summary 关键词启发式 / id 前缀约定。

- **engineSessionId↔目录名**:disk 目录名即 engine sessionId;重建的 UI 会话 id 用同值
  (与 automation import 一致,`id === engineSessionId`),使路由/去重一致。
- **841 目录性能**:分页只读首页 N 个 state.json;readdir+stat 排序是 O(n) 轻量,首屏可接受。
- **不破坏现状**:localStorage 有数据时路径不变(快);disk 仅在缺失/打开时介入。
