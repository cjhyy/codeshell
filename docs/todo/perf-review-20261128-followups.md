# 2026-11-28 性能/结构审查：未处理项

分支 `codex/core/perf-review-20261128` 已落 31 个提交（见 PR 描述）。以下是审查确认存在、但这次刻意没改的项，按价值/风险排序。行号以 dd53cd830 为基线。

## 需要产品/安全决定

1. **流式下载逐块重新授权**（server）
   - `panels/resources/http.ts:65`（每 1 MiB 块跑一次完整面板快照授权）、`process-files.ts:329`、`hub/files.ts:303`（每 64 KB 块同步读 auth store + sha256）。
   - 已有 250 ms 定时器会在撤权时销毁流。去掉逐块检查 = 撤权后最多多发 ~250 ms 数据。这是安全边界取舍，需要拍板。
2. **面板授权每次重建完整快照**（server `panels/runtime.ts:1247`、`management.ts:418-490`）
   - 工具任务的 200 ms reconcile + 1 s authorize 每秒约 7 次快照，每次 ~5 个新 `SettingsManager` + 三次包目录遍历。
   - 与记忆里"面板复制原片慢"同根因，修复在未合并分支 `resource-clone-handoff`；先确认那条分支是否覆盖这条路径，再决定。
3. **chat 投递队列每条消息整文件重写两次**（`chat/src/delivery-queue.ts:267,388`）
   - 完成写入合批会在崩溃时丢失去重键 → 可能重复回复。需要决定可接受的语义（或改追加日志）。

## 工程量较大、需要单独设计

4. **每条用户消息重读并解析整份 transcript**（core `engine/run-session-open.ts:101` → `Transcript.loadFromFile`）
   - 需要跨进程的 transcript 缓存失效协议（stamp + 自身追加后更新），改动面大。
5. **CC room transcript 跟随每次变化全量重读+3 次 sha256**（desktop `cc-room/transcript-subscriptions.ts`）
   - 全量哈希是检测"前缀被改写"的完整性设计；改成增量会削弱这一保证。需要先定是否接受。
6. **外部运行时 recorder 每次提交读 state.json + 双 fsync 在 Electron 主线程**（`external-runtime-state.ts`）
   - 本次只把合批窗口从 8 ms 放宽到 32 ms；根治是把 recorder/journal 移到 Host/utility 进程。
7. **Hub 会话列表每次请求同步扫目录**（server `hub/session-management.ts:167-216`）
   - 可复用 Desktop 的 SQLite 会话索引；需保留索引不可用时的文件回退。
8. **Codex rollout 查找全树遍历 + 整文件同步读**（coding `codex-session-history.ts:198`、`external-agent-changes.ts:63-178`）
   - thread id → path 缓存 + 流式扫描。
9. **TUI App 仍订阅整个 chat store**：子组件已 memo，App 本体每 50 ms 仍重跑；把订阅下沉到列表组件是下一步。
10. **IM gateway status() 每条消息解密全部凭据**、**浏览器截图主线程同步 resize/JPEG**：影响小（毫秒级/人类速率），暂不值得引入缓存失效风险。

## 结构清理（低风险，未做）

- 原子写 tmp→rename 在 desktop/server 有 ~45 份实现；core `writeFileAtomic` 未从 `/internal` 导出，desktop 的 `writeOwnerJsonAtomic` 放在 `pet/` 下却被非 pet 模块使用。建议导出带 `{mode, exclusive}` 的版本并迁移。
- core 有界常规文件读取（lstat + O_NOFOLLOW + fstat + 限长）约 10 份内联副本，`utils/file-mutex.ts:221 readBoundedJsonFile` 名不副实，可改名后复用。
- output-journal 系列 7 处相同的 `dev:ino:size:mtimeNs:ctimeNs` stamp 函数；部分测试按模块 stub fs，合并前要确认。
- TUI 约 18 个无引用文件（~1.4k 行），desktop main 若干无调用函数（`git-services.ts` 4 个、`panel-app-install-service.ts` 4 个 `*ForUi`、`browser-driver/active-guest.ts` 5 个）。
- `core/src/tool-system/builtin/index.ts:1235` 硬编码 `panel-app:job-hunt-hq` 工具名白名单，违背"面板业务归面板包"；应由面板 manifest 声明、宿主校验。
- `core/src/cli/agent-server-tcp.ts` 是无鉴权 TCP 入口且无人引用：确认要发布还是删除。

## 已知的本地测试噪声（与本分支无关）

- `web/src/hooks/mobileOutputClient.test.ts` "ten-second timeout"：20 ms 实时等待，高负载下 main 上也会挂（8 次 3 挂）。
- `browser inspector integration` close browser 超时、`cc-room/transcript-recovery` 62 MiB 写入者、`detectCodexImageInput`（调真实 codex）：均为负载/环境相关。
- 跑全量测试会改写 `docs/review-2026-10-12/**` 下的观测文件，提交前 `git checkout -- docs`。
- `tests/profile-mcp-runtime.test.ts`：内部 fixture 每个测试 5 s 预算，"Session Profile wins…" 在负载 ~10 时耗时 5.1–5.5 s，回退本分支相关提交后同样超时；pid 清理断言的 unnamed 失败在 main 上同样存在。
