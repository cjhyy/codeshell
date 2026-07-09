# Pre-beta 全 repo 体检 · 04 tui + cdp + 配置 + 文档

> 范围：packages/tui/src、packages/cdp/src、根配置、面向用户文档（README 中英/CHANGELOG/LICENSE/各 package README）。
> codex 独立只读会话，主编排 agent 代为落盘。基线 HEAD `ccef4283`。

## 结论：HOLD

Blocker 1 · Major 3 · Minor 4 · Nit 1。CLI 入口设计本身正确（根 bin→dist/cli.js，build-meta 生成，Node>=20.10 双重检查），但法律合规 + 文档误导建议卡住 public beta。

## Blocker

### B1 ApplyPatch 的 Apache-2.0 归属文件不会进入已发布 npm 包（法律，确证）
- 证据：`apply-patch/NOTICE.md:3` 声明改编自 OpenAI Codex Apache-2.0；但 `packages/core/package.json:19` 只发布 `dist`，build（`:24`）只跑 tsc + 复制 prompts/data，tsconfig 只含 TS 源。→ `NOTICE.md`/`LICENSE-codex` 很可能不进 npm tarball。
- 建议：把 Codex Apache license/notice 复制进发布产物，或加包级 `THIRD_PARTY_NOTICES.md` 并纳入 `files`。
- 阻塞 beta：是（法律合规）。

## Major

### M1 runs 子命令用默认 SettingsManager scope + 非执行动作也强制解析 LLM（确证）
- 证据：`runs.ts:27` 用 `new SettingsManager(cwd)`，而 run/repl 用 full scope（`run.ts:74`/`repl.ts:69`）；`runs.ts:31` 在 list/get/cancel/events 也强制解析 LLM。
- 影响：`code-shell runs ...` 可能读不到全局模型配置；非执行动作因无模型连接失败。
- 建议：runs 用 full settings scope，只在 submit/resume/recover 懒加载 LLM。
- 阻塞 beta：建议阻塞（README 已公开宣传 runs）。

### M2 cdp README 宣传 npm 安装但包 private 不发布（确证）
- 证据：`packages/cdp/package.json:4` `private:true`，workflow 只发 core/tui/meta；但 `packages/cdp/README.md:7` 写 `npm install @cjhyy/code-shell-cdp`。
- 建议：不发布就改 README 为 internal 说明；要公开则移除 private 并加入发布流程。
- 阻塞 beta：是（公开文档误导安装不存在的包）。

### M3 第三方来源归属缺随包 notice（法律，确证）
- 证据：Yoga TS port（`tui/src/native-ts/yoga-layout/index.ts:1`、`enums.ts:1` 来自 Facebook Yoga）；CDP keymap（`cdp/src/keymap.ts:1` 翻译自 browser-use）；Claude Code restored-src 引用（`MessageContent.tsx:352`、`setup.ts:1`、`query.ts:1`）。均未见随包 license/notice。
- 建议：逐项确认来源许可证，补 copyright/license/notice 并确保进发布包；来源不明的重写。
- 阻塞 beta：建议阻塞到 provenance 明确。

## Minor
- m1 README（`:130` 中英）写 general preset 47 个 built-ins 且漏 `AddMarketplace`；实际 `preset/index.ts:34` GENERAL_BUILTINS 有 48 个，AddMarketplace 在 `:89`。
- m2 `tui/README.md:34` 子命令表漏 `runs`（`main.ts:159` 已注册）。
- m3 `CHANGELOG.md:34` 写 sample roles 在 `examples/agents/`（不存在，实际 `packages/desktop/resources/agents/`）；`:45` 写 `apiKeyRef`，实际 schema 用 `credentialId`（`schema.ts:170`）。
- m4 clean checkout 未 build 时 source-dev 命令因找不到 `@cjhyy/code-shell-core` 失败（贡献者体验，npm 发布路径不受影响，workflow 会 build）。

## Nit
- `tui/README.md:15` 写 Node 17+、`cdp/README.md:15` 写 Node 15+，与根包 Node>=20.10 不一致，应统一。

## 法律合规小结
根 LICENSE 是 MIT ✓。ApplyPatch 源目录有 Codex NOTICE + Apache license + attribution，但发布包不带（B1）。Yoga/browser-use/Claude Code restored-src 有来源标注但缺随包归属（M3）。发 public 前必须统一审计。

## 验证命令
- `bun test cdp/keymap+driver`：39 pass。
- tui CLI 测试：11 pass 2 fail（未 build 导致解析 core 失败）。
- `rg`/`ls` 核验 README 相对链接/图片存在；badge/npm URL 无网络仅结构核验。
- core 未 import tui，ESLint 边界规则存在 ✓。
