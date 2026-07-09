# 24 · Input Attachment Pipeline 审查报告

> 审查对象：统一输入接入总线特性的未提交工作树改动（基线 HEAD `c93bea6a`）。
> 审查方式：codex 独立只读会话（sandbox），本文件由主编排 agent 代为落盘（审查 agent 因只读沙箱无法写盘）。
> 落地记录见 `docs/plan-2026-07-09-input-attachment-pipeline-IMPL-NOTES.md`，权威方案见 `docs/plan-2026-07-09-input-attachment-pipeline.md`。

## 总体结论：REQUEST-CHANGES

计数：Blocker 1 · Major 4 · 非计划内改动 1。

---

## Blocker

### B-1 附件 root / session dir 缺最终 realpath containment 回校验，symlink 可逃逸

- 锚点：`packages/desktop/src/main/attachment-service.ts:342`（`ensureAttachmentsRoot`）、`attachment-service.ts:351`（`resolveAttachmentsRoot`）、`attachment-service.ts:362`（`ensureSessionDir`）、`safeJoin` at `attachment-service.ts:368`。
- 问题：`safeJoin` 只对 `root`/`containmentRoot` 做 `realpath`，对最终 `target`（child 拼接后）不做 realpath 回校验；也没有用 `lstat` 拒绝 symlink。若 `<cwd>/.code-shell/attachments` 或 `<attachments>/<sessionId>` 在 staging 前已是指向 root 外的 symlink，则落盘可能写到 attachment root 之外；cleanup 也可能把 symlink 指向的目标当成 attachment root，误删 manifest 记录的文件。
- 建议：①对 root / session / 既有文件先 `lstat`，是 symlink 直接拒绝（或解析后再校验）；②`mkdir` 后对最终路径逐层 `realpath`，确认仍在预期 root 内；③补 symlink root / symlink session / symlink existing-file 三个测试用例。

---

## Major

### M-1 `RunParams.attachments` 是新读盘入口，未复用 path-policy 敏感规则，且先读字节再过 gate

- 锚点：`packages/core/src/engine/input-attachments.ts:47`、`input-attachments.ts:104`、`packages/core/src/engine/engine.ts:1048`。
- 问题：新入口只检查「inside cwd」，没有复用 `path-policy` 的敏感路径规则（如 `.code-shell` 内其它敏感文件）；图片在 vision gate 与 image-policy size gate 之前就直接 `readFile()` + base64。
- 建议：先 `stat` → path-policy/sensitive 判定 → size cap，再决定是否读字节；非 vision 模型根本不要读 bytes。

### M-2 busy queue / steer 只存字符串，结构化 attachments 被静默丢弃

- 锚点：`packages/desktop/src/renderer/ChatView.tsx:724`、`ChatView.tsx:728`、`packages/desktop/src/renderer/App.tsx:2397`、`App.tsx:2389`。
- 问题：忙时排队 / steer 只保存输入字符串，`@file/@dir/recent` 的 structured attachments 会被清掉。图片靠 legacy `<codeshell-image>` XML 还能兜底，但**目录树和文件 metadata 会静默丢失**。
- 建议：queued input state 携带 `attachments` + `displayText`；steer 通道不支持结构化时，要么编码成 legacy context，要么阻止排队并明确提示用户。

### M-3 main IPC 没有 decoded byte size cap，不能只依赖 renderer 校验

- 锚点：`packages/desktop/src/main/attachment-service.ts:118`、`attachment-service.ts:302`、`attachment-service.ts:142`。
- 问题：main 进程 IPC 入口没有对解码后的字节大小设上限，只依赖 renderer 侧的 10MB 校验；renderer 不可信，绕过校验可写超大文件。
- 建议：main 侧对 decoded byte size 独立设 cap，超限拒绝。

### M-4 （并入 M-1）非 vision 模型仍读图片字节

- 见 M-1 建议第二点：非 vision 模型不应读 bytes，避免无谓 token/内存成本。

---

## 非计划内改动

### `packages/core/src/index.ts:7` VERSION rc.15 → rc.17

- 判断：**不属于** input-attachment pipeline 特性。IMPL-NOTES 说是为让一个无关的版本测试通过而顺手同步。
- 建议：剥离为独立的 `chore(core): sync VERSION to rc.17` commit；若保留在本批，PR 描述里必须明确标注「无关测试基线同步」。

---

## 验证记录（审查会话，只读沙箱）

- `bun run typecheck`：通过，`tsc --noEmit` exit 0。
- `bun test tests/parse-task.test.ts`：14 pass / 0 fail。
- 含 attachment/input/DriveAgent 的综合测试命令：exit 1，但失败根因是**只读沙箱禁止 `mkdtemp()` 写临时目录**，非源码断言失败（实现会话在可写环境跑过 `bun test` 全绿 5127 pass）。
- import 约束 `rg` 核查：core 未命中 `@cjhyy/code-shell-tui`；renderer 命中的 codeshell 包导入均为 `import type` 或注释。✅

---

## 处理建议顺序

1. B-1（安全，必修）→ attachment-service symlink 硬化 + 测试。
2. M-1（安全 + 成本）→ input-attachments 走 path-policy + gate 前不读字节。
3. M-3（安全）→ main IPC size cap。
4. M-2（数据丢失）→ queue/steer 携带结构化 attachments。
5. 版本改动剥离为独立 commit。
