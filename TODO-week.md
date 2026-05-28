# 本周 TODO — 2026-05-28 → 2026-06-03

> 这周要做的事。**只放本周**；长线路线图见 `TODO.md`。
> 用法：写一行 `- [ ]`，做完打 `- [x]`，做不完就推到下周或回流到 `TODO.md`。

---

## 🎯 本周目标

<!-- 1–2 句话，描述这周想推进到什么状态 -->

---

## ⏳ Doing — 正在做的

<!-- 当下手上的事，应该 1–2 件为宜 -->

- [ ]

---

## 📋 To Do — 本周要做

<!-- 按你打算开工的顺序排 -->

- [ ] **1. Electron 长会话页面卡顿** — 排查重渲染、虚拟列表、消息列表 DOM 体量；定位再决定优化方案
  - 进展：session `s-mppal9el-430db385` 实证诊断（84s 1546 个 text_delta）→ 已 memo ToolCard / Markdown / ThinkingMessageView / ContextBoundaryView。本轮单点见效（不再每个 delta 都重跑 ReactMarkdown 等）
  - 待办：实测确认；若还卡，下一步考虑 MessageStream 整体 React.memo + items.map row-level key 稳定化 + 必要时引入虚拟列表（react-window）
- [ ] **2. 生成物（图片 / HTML / md）卡片化展示** — Electron 端给 GenerateImage 输出、写入的 .md / .html 一个统一的"附件卡片"，点击用系统应用打开
- [ ] **3. 权限模式整顿 + Goal 模式**
  - [ ] "本次完全访问"不要——改成更明确的当前 session / 项目级 / 全局三层
  - [ ] 项目级 `.code-shell/settings.json` 配置目前不生效，要查
  - [ ] 新增 **Goal 模式**：设定目标后一直跑直到完成，中途不再问人（要安全护栏：dangerous/destructive 仍要拦）
- [ ] **4. plugin / skill 系统跟 Codex 对齐** —— 同时把 MCP 等内容也纳入统一"扩展能力"概念
- [x] **5. ESC 打断不及时** — 当前 ESC 要等很久才真停，最后还冒个 abort 报错；要做到立即中断 + 干净退出，不抛 error 给用户
  - 修复：(a) `App.stop()` 乐观清 busy + runningBucketRef，UI 立即响应；(b) `server.ts` run() 的 catch 识别 abort，回 `RunResult{reason:"aborted_streaming"}` 而非 InternalError，不再弹错；(c) `run().then` 加 `.catch` 兜底防 busy 永久卡死

---

## 🧊 Backlog — 想做但本周不一定上

<!-- 灵感、好像值得做但还没排进来的 -->

- [ ]

---

## ✅ Done — 本周已完成

<!-- 完成的挪进来，周末回看；下周一清空 -->

- [x]

---

## 📌 Notes / Blockers

<!-- 卡住的、需要别人配合的、想记下的临时观察 -->

-
