# Pre-beta Final Followup 复审（commit 14a9c425）

> codex 独立只读复审，主编排代为落盘。范围严格限定 commit 14a9c425（发 0.7.0-beta.1 前的发版加固）。

## 结论：SHIP-with-nits

Blocker 0 · Major 0 · Minor 1 · Nit 1。两处关键行为变更确认安全。

## 重点结论（两处行为变更）
- **verify-version 不会误拦正常发布**：正则限定 `@cjhyy/code-shell...@<semver>`，第三方 scoped 包（如 `@babel/core@7.29.7`）不误报；tag 去 `v` 前缀正确；断言失败 exit 1。前提是按 checklist 先跑 release helper 把 5 package + core VERSION + bun.lock 全 bump 到目标版本。若在当前 rc.18 直接打 v0.7.0-beta.1 会被正确拦下（版本不符）。
- **release needs [package, npm-publish] 不会让正常首发失败**：job 图 `verify-version → {package, npm-publish} → release` 无环；npm-publish 只在 tag 跑；workflow_dispatch 仍只产 artifacts 不发 Release。

## Findings
### Minor: 同 tag rerun 幂等性变差（不阻塞本次）
- 证据：`release.yml:354` release 依赖 npm-publish；`:203` 直接连续 `bun publish`。首次正常 tag OK，但 npm 已发布后 rerun 同 tag，registry 不允许覆盖同版本 → 可能挡住 release。
- 建议：发布步骤先 `npm view <pkg>@<version>`，存在则跳过。

### Nit: checklist 顶部 Current State 仍写 0.6.0-rc.17（实际 rc.18）
- 证据：`docs/release-checklist-beta.md:9/15/19`。建议后续顺手更新。

## 逐项验证
- verify-version：5 package mismatch `:55-58` exit 1；node 内联脚本错误 `:147-150` process.exit(1)；core VERSION 检查 `:67-76`；bun.lock workspace block `:79-82`；stale spec 正则 `:136-145` 限 `@cjhyy/code-shell...@semver`。
- release 依赖：npm-publish tag-only 依赖 verify（`:153`）；package 允许 dispatch 时 verify skip（`:212`）；release tag-only 依赖 package+npm（`:349`）。静态图无环。
- ad-hoc signing：非 macOS no-op（`:39`）；catch 中 `CI||GITHUB_ACTIONS` throw、本地 warn（`:66`）。VM mock：空 env 不 throw、CI=true throw、CI="" 不 throw。
- 3 条安全回归测试：symlink escape（`input-attachments.test.ts:206`，实现先 path policy 后 readFile）；非视觉+文件附件调 LLM 无 image block（`engine-structured-image-vision-gate.test.ts:127`）；non-streaming recorder redaction（`model-facade-recorder-redaction.test.ts:151`，实现 `model-facade.ts:156` sanitize）。
- engine.ts 附件元数据：附件文本合并进 `parsedTask.text`（`:1067`），`taskText`→`parsedTask.text`（`:1160`）；非视觉图片 gate 仍保留（结构化图片置 hasImages=true `:1071`，`:1077` 返回 image_error）。

## 验证命令
- ruby yaml 解析：jobs 齐全，release_needs=["package","npm-publish"]。
- node 复现 verify-version：当前 0.6.0-rc.18 通过；内存替换 0.7.0-beta.1 → stale 空、第三方不误报；注入 stale @cjhyy/code-shell-core@0.6.0-rc.18 被捕获。
- typecheck 通过；3 测试文件因只读沙箱 mkdtemp/recorder 写入 EPERM 未跑完（非断言失败，实现会话已 15 pass）。
