# 本周 TODO — 2026-05-28 → 2026-06-03

> 这周要做的事。**只放本周**;长线路线图见 `TODO.md`。已完成的项已删除,只保留未完成/进行中的。

> **剩余主线**:**#4**(plugin/skill 系统对齐 Codex —— 本周已大幅推进,见下)。**#9b 已用占位符方案落地**(无需 token 计数管线,见 #9)。另有 #10 多 session 串台修复(从日志诊断引出)。

| 状态 | #   | 任务                          | 备注 / 关键落点                                                                                                                                                                                                                                                                                                                                              |
| ---- | --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🟡 | 4   | plugin / skill 系统跟 Codex 对齐 | **本周大幅推进**:① `7396c29` 设置页「扩展能力」UI 分组;② CapabilityService 控制层收口(列举/开关单一入口);③ **插件安装器**(`plugins/installer/`)—— CC + Codex 两种格式本地安装、Codex TOML→CC 转换、MCP/skills 接入;④ 运行时加载(skill/agent/MCP 真正被发现+可调用,含 Docker `.mcp.json` 回退);⑤ list/update/uninstall 命令。**真实插件实测通过**(document-skills / cloudflare / docker mcp-toolkit 等)。**剩**:远程 git 安装(spec 已写 `2026-05-29-plugin-remote-install-design.md`,待实现)+ 跨 MCP/builtin/skill 统一注册表收尾 |
| ✅ | 9   | 图片处理对齐 CC/Codex 最佳实践   | 9c/9d/9e 已完成(`ffb87f5`)。**9b 已完成**(`035970e`):非视觉模型的 history 旧图 → **文字占位符**(`llm/strip-vision.ts`,纯函数 + 7 单测)。原计划的"先铺 token 计数管线"被绕过 —— 占位符方案不需要计数,直接在 `openai.ts buildMessages` 收口替换。修复了切到 DeepSeek 后历史旧图每轮 `image_url` 400 的真 bug(日志实测一小时 13 次) |
| 🟡 | 10  | 多 session 上下文/串台 + 慢 修复 | **从一次日志诊断引出**(session `s-mppq7m94`,"又卡又慢效果差")。已做:**辅助任务模型**(`035970e`)—— `settings.auxModelKey` + `Engine.resolveAuxClient()`,把 memory 提取/auto-dream 从每轮主模型(gpt-5.5)挪到可配的廉价快模型,桌面端 Model 设置加了选择器。**剩**:见下「遗留 / 待确认」 |

---

## 🔍 #10 前因后果(2026-05-29 日志诊断会话)

**起因**:用户给出 session `s-mppq7m94`,反馈"又卡又慢效果差",让看最近一小时引擎日志。

**诊断结论**(`~/.code-shell/logs/engine-2026-05-29.log`,UTC 08:43–09:43):
1. 🔴 **history 旧图 400** —— `messages[74]: unknown variant 'image_url'`,一小时 13 次。切到 DeepSeek(非视觉)后,历史里 vision 模型时期的旧图每轮重发 → 400 → 退流式。→ 已修(#9b)。
2. 🟡 **每轮多打一次 gpt-5.5 辅助调用** —— memory 提取每轮 1 次(`msgs:2`),一小时 37 次,占用最贵主模型。→ 已修(#10 辅助模型)。
3. ⚪ **主请求慢 40–84s** —— 实发 ~148k tokens 给直连 gpt-5.5,p90=53s。**非 bug**:窗口 922k(settings 里有配),占用仅 16%,压缩正确未触发(Tier-0 持久化已在跑)。纯粹是 gpt-5.5 直连在大上下文上慢。**无可改**,辅助模型已减少每轮总调用数。

**纠错记录**:中途一度误判 gpt-5.5 fallback 到 200k 窗口、建议"注册真实窗口" —— 错的,settings 明确配了 `maxContextTokens:922000`,该建议作废。

**追加诊断(2026-05-29 第二次「读两天日志找 bug」会话)** —— 在前一次基础上扩到两天(05-28/05-29),又确认两个真 bug,均已在 `a73f1a5` 修复 + 测试:
- **Bug 1 — 4xx 不重试守卫对 OpenAI 路径失效**。`client-base.ts isClientError` 只读顶层 `err.status`,但 `openai.ts handleApiError` 把 SDK 错误重包成 `LLMError(msg, provider, {status})`,status 落进 `details` → 守卫读到 `undefined` → 所有确定性 400/401/abort 被白白重试 3 次(~9s)再 fallback 又重试。佐证:两天 `llm.client_error_no_retry` 出现 **0 次**。**这正是上面遗留里「abort 后还 retry 3 次空烧 40s」的根因**。修复:`isClientError` 同时读 `details.status`(A5)。
- **Bug 2 — max_tokens 跨模型串值未钳制**。`model-pool.ts:264` 把目录 `maxOutputTokens`(deepseek/openrouter=384000)直灌 `LLMConfig.maxTokens`,`buildRequestBody` 不钳制就发 → gpt-5.5(128k 上限)400 `max_tokens is too large: 384000`。`model-pool.ts:239-241` 早点名隐患却没写钳制。修复:`clampMaxTokens` 接入 `openai.ts:210`,用 `cap.maxOutputTokens`。
- 验证:`bun test src/llm/` 27 pass / 0 fail;`tsc --noEmit` exit 0。
- 另两个高频日志项(`notification_queue.invalid_session_id` 285×、`permission.ask.fail "Run not found"` 7×)经查 **非 bug**:都是测试夹具产生(agentId=`abc12345/empty/undef`;sid 是测试随机串而非真实 `s-`)。**教训:先按 sid 格式区分「真实会话 `s-` vs 测试随机串」再判定是不是 bug。**

**提交过程的坑**:工作区当时混入了**另一个并行 session** 的大量未提交改动(correctness batch,后成为 `a73f1a5`)。该 session 在我提交期间切分支并提交,且其提交 **import 了我的 `strip-vision.ts` 却没带上该文件 → HEAD 一度 build 坏**。我的 `035970e` 补上文件修复了 build。最终 `a73f1a5` + `035970e` 一起 fast-forward 进 main(用户确认两个一起合)。

## 📋 遗留 / 待确认(#10 + 杂项)

- [x] **第二个 side-call 已查清并修复**(`d1bc93a`)—— 那个每轮 `msgs:2` 烧 gpt-5.5 的调用是 `engine.ts` 的两处 summarize:`contextManager.setSummarizeFn`(压缩摘要)+ `modelFacade.summarize`(工具结果摘要)。原本都用主 `llmClient`。已改为走 `resolveAuxClient(llmClient)`(装配阶段解析一次,避开压缩热路径的 settings 磁盘重读),无 aux 配置时回退主模型。验证:根 typecheck exit 0;`bun test src/llm src/engine` 53 pass / 0 fail。
- [x] **`Request was aborted` 后还 retry 3 次空烧 ~40s** —— 根因已查清:就是 Bug 1(`isClientError` 读不到 `LLMError.details.status`,4xx/abort 全被当可重试)。已在 `a73f1a5` 修复。**(并行 session 进一步在 `client-base.ts` 加了专门的 `isAbortError`/`llm.abort_no_retry` 守卫,直接拦截 `APIUserAbortError`/`AbortError`,更彻底 —— 该改动在工作区未提交,归该 session。)**
- [ ] **memory extraction 耗时波动** —— `elapsedMs` 3083→5939→8689 递增后又掉回 1772,原因未查。
- [ ] **Anthropic provider 图片过滤未做** —— `stripVisionFromHistory` 只接进 OpenAI-compat 路径(当前 claude 全支持视觉,YAGNI);接非视觉 anthropic-style 模型时会漏。
- [ ] **main 领先 origin/main 58 提交,未 push** —— 含本次 2 个提交。
- [ ] **并行 session 撞车风险** —— 同仓库有另一 session 在写+提交;继续在 main 上干活前需确认。
- [x] **`/` 根目录游离的 `src/` 已删除** —— 经逐文件内容比对:**混合体**(85 个 Claude Code 源码 + 15 个 codeshell 拆 monorepo 前的旧版散落副本,`packages/*/src` 已有更新版),0 个是缺失的有价值逻辑。100 文件 mtime 全 `22:05`、一次性生成、未进 git。删前确认无活引用(根 `tsup.config.ts` 是指向不存在 `src/run`/`src/product` 的死配置,真实构建走 workspaces `--filter`)。`packages/*/src` 未受影响。**顺带**:根 `tsup.config.ts` 是死配置,可顺手删/更新(低优先)。

---

## 📚 相关研究 / 资料

- 日志诊断现状:`docs/research/session-isolation-state.md`(多 session 隔离/上下文装配调研)

- [CC vs Codex 图片处理对比 + "上下文不会爆吗"分析](./docs/research-cc-vs-codex-image-handling.md) — 配合 #9 阅读
- 插件系统设计:`docs/superpowers/specs/2026-05-29-plugin-cc-codex-compat-design.md`、`2026-05-29-plugin-remote-install-design.md`
