# 本周 TODO — 2026-05-28 → 2026-06-03

> 这周要做的事。**只放本周**;长线路线图见 `TODO.md`。每条都经过代码核对(2026-05-29),已完成/已实现的项已剔除。

> **进度 (2026-05-29 夜间自动修复)**:#1/2/6/7/8/9(部分)/10/11/12/13a/13b/15 + #3(b)(c) + #4(IA) 全部完成并 commit + typecheck + 测试验证。
> 剩余只有显式延后的两块:**#9b**(history 旧图降级——要先铺 token 计数管线)和 **#4 的后端统一**(一个跨 MCP/builtin/skill 的能力注册表,属大改 core)。详见每行末尾标注。

| 状态 | #   | 任务                                                          | 备注 / 关键落点                                                                                                                                                                                                                                                                                                                  |
| ---- | --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ✅ | 1   | Electron 长会话页面卡顿                                       | `09b0baa` — 把剩余行组件(AssistantMessageView / TaskListMessageView / FilesChangedCard / ToolGroupCard / TurnProcessGroupCard / AskUserMessageView)都 `memo` 了,并修了 MessageStream 里每次重渲染都新建的 `onAnswer` fallback。row-key 已是稳定的 `m.id`。`react-window` 暂不需要 |
| ✅ | 2   | 生成物(图片 / HTML / md)卡片化展示                          | `fb89799` — `tool-cards/attachments.ts` 识别工具输出里的图片/md/html 路径,`AttachmentCard.tsx` 渲染缩略图/图标 + 点击 `openPath`;GenericToolCard + FileToolCard(write)都接了                                                                                                                                                  |
| 🟡 | 3   | 权限模式整顿 + Goal 模式                                      | (a)(c) `58e6114` — 删掉"完全访问权限",换成 **Goal 模式**(映射 engine `auto` backend:安全自动放行 / 危险自动拦 / 模糊问用户);(b) `f8dec9c` — 项目级 settings 不生效已修(settings 改动后 `configure({reloadModels})` 通知 worker 重读)。**三层**:session=composer pill,项目/全局=设置页 scope chip。**不做**:无限制 bypass 已被有意去掉 |
| 🟡 | 4   | plugin / skill 系统跟 Codex 对齐                              | `7396c29` — 设置页左导航按"扩展能力"分组(MCP + 插件&Skills + 子代理 + 钩子 同一标题下),概念层统一完成。**延后**:跨 MCP/builtin/skill 的统一能力注册表(core 大改)                                                                                                                                                            |
| ✅ | 6   | 图片压缩补成真·基础建设(engine 层自动压缩)                 | `535e0ec` — `engine/image-compression.ts` 加了 `tryCompressImages()` + jimp 动态 import(没装就 no-op,不进 core 依赖);engine.run 在 `enforceImagePolicy` 拒前先压再复检。`setEngineImageCompressor()` 可注入自定义压缩器。desktop canvas 仍是快路径                                                                          |
| ✅ | 7   | 右上角进度小圆点 hover 展开面板(Codex 风格)                | `b85791b` — `topbar/liveActivity.ts` 汇总当前轮(工具数 / 最早 startedAt / 最新工具名 / 是否 in-flight);`StatusPopover.tsx` 自带 1s ticker 显示 当前/已处理/用时;TopBar 包了 hover 容器(120ms 关闭延迟防闪)                                                                                                                  |
| ✅ | 8   | **bug:模型切换后新 session 仍用旧模型**                       | `2574695` — `agent-server-stdio.ts` 的 `engineFactory` 改成 `llm: runtime.modelPool.resolveLLMConfig() ?? resolvedLlmConfig`,新 session 实时从 pool 取活跃模型。加了回归测试(`pool.switch()` → `resolveLLMConfig()` 跟随)                                                                                                     |
| 🟡 | 9   | 图片处理对齐 CC/Codex 最佳实践                                | `ffb87f5` — **9c** MCP 返图溢写到 `~/.code-shell/mcp_images/`(不进 message tree,>8MB SKIP);**9d** `settings.images.detail` (low/high/original) 接到 OpenAI `image_url.detail`;**9e** 超限图 `dropOversizedImages()` 变占位符不进 history。**9a** token-budget 压缩部分靠 #6 的 compressor;**9b** history 旧图降级=延后(要 token 计数管线) |
| ✅ | 10  | **bug:Turn-process 内一级折叠没合并**                         | `37bbc02` — `foldAdjacentTools()` 把 thinking / assistant 当"透明消息":run 中遇到时向前看,若 hard break 前还有 tool 就一同纳入 group(`ToolGroup.tools` → `ToolGroup.items` 异构)。重写了过时的 stream-groups 测试 + 4 个吸收回归                                                                                              |
| ✅ | 11  | FilesChangedCard 补撤销 / 审核按钮                            | `f3522da` — `files:undo` IPC(tracked→`git restore`,untracked→删文件,拒绝越界路径,逐文件回报);卡片头 **审核**(开 UnifiedDiffViewer 弹窗)+ **撤销**(确认弹窗后调 IPC)。undoFiles 有 temp-repo 测试                                                                                                                          |
| ✅ | 12  | 设置页面重做成两栏布局(Codex/Claude 风格)                  | 两栏布局本就有;`f8dec9c` 把 72px 红绿灯避让从无条件改成只在 `.platform-darwin`(并把该 class 挂到 settings-app-shell)。`7396c29` 给左导航加了分组标题                                                                                                                                                                          |
| ✅ | 13a | 行内 `path:line` 渲染成可点击超链接                           | `1586f73` — `markdown/remarkPathLinks.ts` remark 插件识别 text 节点里的 `path:line`,转 `codeshell-path:` 链接;Markdown 的 `a` 渲染器识别该 scheme 调 `shell:openPath`(新 IPC,相对路径按 cwd 解析,容忍 `:line` 后缀)。FilesChangedCard path 也可点了                                                                          |
| ✅ | 13b | 每条助手回复底部加复制按钮                                    | `fdecba9` — `AssistantMessageView.tsx` 从 MessageStream 抽出,done 回复底部加 hover 显形的复制行;`stripMarkdownToPlain()` 去 markdown 标记后写剪贴板,1.5s "已复制"                                                                                                                                                            |
| ✅ | 15  | 记忆模块 UI                                                   | `5216c38` — `main/memory-service.ts` 包 core MemoryManager(level=user/project × scope=user/dream);`memory:*` IPC + preload;设置页"记忆"模块两栏(列表 / 查看-编辑)。memory-service 有测试                                                                                                                                       |

---

## 📚 相关研究 / 资料

- [CC vs Codex 图片处理对比 + "上下文不会爆吗"分析](./docs/research-cc-vs-codex-image-handling.md) — 配合 #9 阅读

---

## 🧹 本次核对(2026-05-29)已剔除的条目

- ~~#5 ESC 打断不及时~~ → 已修(`App.stop()` 乐观清 busy / `server.ts` run() catch 识别 abort / `run().then.catch` 兜底)
- ~~#14 侧边栏项目展开热区太小~~ → 已实现(`Sidebar.tsx:350-356` 整行 `.project-row` 都是 clickable,chevron 用 `stopPropagation` 独立处理)
