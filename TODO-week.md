# 本周 TODO — 2026-05-28 → 2026-06-03

> 这周要做的事。**只放本周**;长线路线图见 `TODO.md`。每条都经过代码核对(2026-05-29),已完成/已实现的项已剔除。

| #   | 任务                                                          | 备注 / 关键落点                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Electron 长会话页面卡顿                                       | 已 memo ToolCard / Markdown / ThinkingMessageView / ContextBoundaryView。待办:实测;若仍卡 → MessageStream `React.memo` + row-level key 稳定化 + 必要时 `react-window`                                                                                                                                                              |
| 2   | 生成物(图片 / HTML / md)卡片化展示                          | Electron 端给 GenerateImage 输出、写入的 .md / .html 一个统一附件卡片,点击用系统应用打开                                                                                                                                                                                                                                       |
| 3   | 权限模式整顿 + Goal 模式                                      | (a) 删"本次完全访问",改成 session / 项目级 / 全局三层;(b) 项目级 `.code-shell/settings.json` 目前不生效要查;(c) 新增 **Goal 模式**:设目标后跑到完(dangerous/destructive 仍拦)。跟 #12 设置页面重做整体规划                                                                                                                |
| 4   | plugin / skill 系统跟 Codex 对齐                              | 同时把 MCP 纳入统一"扩展能力"概念                                                                                                                                                                                                                                                                                                |
| 6   | 图片压缩补成真·基础建设(engine 层自动压缩)                 | commit `bb26e3f` 只做了 desktop canvas + engine 守门,TUI 路径只是中文 error。要补 engine 层 `compressImage()`(`jimp` 纯 JS),在 `enforceImagePolicy` 拒绝前先尝试压缩,desktop canvas 保留作快速路径                                                                                                                          |
| 7   | 右上角进度小圆点 hover 展开面板(Codex 风格)                | 参考 `截屏2026-05-25 21.54.47.png`。**圆点已有**(`StatusDot.tsx` + `TopBar.tsx:45`,busy 时 pulse),**缺**:hover 展开面板显示"当前在做的事 / 已处理几步 / elapsed"。数据源已在 `AgentMessageView.tsx` 用过(`elapsed` + `toolCount`),把它在顶栏复用                                                                              |
| 8   | **bug:模型切换后新 session 仍用旧模型**                       | IPC 已通(`onModelChange` 已发 `configure({ model })`,`handleConfigure` 调 `engine.switchModel`),**但** `agent-server-stdio.ts:77` 的 `resolvedLlmConfig` 在 bootstrap 固化,line 114 的 `engineFactory` 给新 session 都用这个 frozen 值。修法:`engineFactory` 改成 `llm: runtime.modelPool.resolveLLMConfig() ?? resolvedLlmConfig` |
| 9   | 图片处理对齐 CC/Codex 最佳实践                                | 9a token-budget-aware 压缩;9b history 旧图自动降级 low detail / 缩略图;9c MCP 返图 25k token cap;9d OpenAI 路径暴露 detail(low/high/original);9e 超限图变可删占位符不进 history。背景见 `docs/research-cc-vs-codex-image-handling.md`                                                                                       |
| 10  | **bug:Turn-process 内一级折叠没合并**                         | 参考 `截屏2026-05-28 19.00.25.png`。`streamGroups.ts` 的 `foldAdjacentTools()` 第 113-143 行:遇到任何非-tool 消息就 `flushRun(i)`,被 `assistant_text` / `thinking` 打断相邻判定。修法:定义"透明消息"集(thinking、短 assistant_text 段),flush 时把它们跨过去 / 一同纳入 tool_group                                          |
| 11  | FilesChangedCard 补撤销 / 审核按钮                            | 3/4 已做(总计 +/-、单行 path + +N/-N、"再显示 N 个文件 ⌄" 都有)。**只缺**:卡片头右侧 **撤销 ↶ / 审核** 两个按钮。要扩 `FilesChangedSummaryMessage` 类型 + UI + CSS                                                                                                                                                            |
| 12  | 设置页面重做成两栏布局(Codex/Claude 风格)                  | 参考 `截屏2026-05-29 00.19.17.png`。左侧导航(常规/外观/配置/键盘快捷键/MCP/钩子/连接/Git/环境/工作树/浏览器/电脑操控/已结束对话)+ 右侧详情。**左上角顶部留 ~72px 避让 macOS 红绿灯,只在 darwin 生效**。落点:`packages/desktop/src/renderer/settings/`,跟 #3 一起规划                                                          |
| 13a | 行内 `path:line` 渲染成可点击超链接                           | 参考 `截屏2026-05-29 00.28.40.png`。当前 `Markdown.tsx:41-67` 的 `a` 渲染器只处理 `https?://`,纯文字 `path:line` 不识别。要加 remark 插件或 text-children 后处理识别 `path:line` / `path (line N)`,转 `<a>` 调用 IPC(主进程 `shell:openExternal` / `shell:revealInFinder` 已就绪在 `main/index.ts:505-513`)+ 顺手把 FilesChangedCard path 也改成可点击 |
| 13b | 每条助手回复底部加复制按钮                                    | 代码块复制已有(`Markdown.tsx:102-104`),消息级没有。`MessageStream.tsx:116-131` 渲染助手消息只有 `<Markdown text={m.text} />`,要在外面加 action 行(复制纯文本去 markdown 标记 + 短暂 "已复制" toast)                                                                                                                                  |
| 15  | 记忆模块 UI                                                   | 后端工具层已有 `packages/core/src/tool-system/builtin/memory.ts`,前端**完全缺**:无 UI 组件、无 settings 入口、无 preload API。要加 settings 一个 `memory` 模块 + 列表视图(查看 / 编辑 / 删除 user 和 project memory 条目)                                                                                                  |

---

## 📚 相关研究 / 资料

- [CC vs Codex 图片处理对比 + "上下文不会爆吗"分析](./docs/research-cc-vs-codex-image-handling.md) — 配合 #9 阅读

---

## 🧹 本次核对(2026-05-29)已剔除的条目

- ~~#5 ESC 打断不及时~~ → 已修(`App.stop()` 乐观清 busy / `server.ts` run() catch 识别 abort / `run().then.catch` 兜底)
- ~~#14 侧边栏项目展开热区太小~~ → 已实现(`Sidebar.tsx:350-356` 整行 `.project-row` 都是 clickable,chevron 用 `stopPropagation` 独立处理)
