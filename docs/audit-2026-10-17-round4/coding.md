# Coding LSP / 文件数据补审（第四批）

冻结源码：`4ee32f28f78b8315112cca77cfc22b2f2f80ced6`；分支：`codex/audit/context-round4-20261017`。本报告只记录结果，未修改产品源码、依赖或既有测试，未进行 Git 写操作。

本轮有 **2 项新发现（2 P2）**；两种 URI 输出表现合并为一项，重复打开与可能陈旧的诊断合并为一项。候选和历史问题均不加进此数量。证据直接导入当前 `packages/coding/src`，在真实 workspace manager 上注入内存 client；没有启动语言服务器或其他产品进程，没有网络调用。

## CODING-R4-01 [P2] Definition / References 将编码 URI 当作文件路径返回

- 源码：`packages/coding/src/tools/lsp.ts:199–210`，核心为第 208 行的 `uri.replace("file://", "")`；两个实际入口为第 96–110 行。工具注册与调用路径见 `packages/coding/src/index.capability.ts:190–202`，它是 Coding preset 的实际 LSP 实现。
- 触发：语言服务器正常返回一个 `Location`，其文件名含空格、中文、`%` 或 `#`。工具请求端第 91 行正确使用 `pathToFileURL`，结果端却只去掉 scheme，没有进行 URI 解码。
- 观察：夹具创建真实临时文件 `a b-中文-100%#file.ts`；Definition 返回的路径保留 `%20`、UTF-8 百分号编码、`%25`、`%23`。原文件存在，而该返回路径不存在。References 同样保留 `reference%20space.ts`。ASCII 文件和 1-based 行号控制通过。
- 影响：Agent 按返回的 `path:line` 定位、读取或编辑普通含空格/非 ASCII 文件时，得到与实际文件不同的路径。此处确认的是工具输出失真，不是 GUI 点击导航或真实语言服务器故障。Windows/UNC 未运行，不把平台推断当作实测。
- 修复方向：对 `file:` Location 使用平台文件 URL 转换；对其他 URI scheme 保留可识别的 URI。此次没有实施修复。
- 去重：2026-05-30 的历史 finding 是 **manager 的 spawn cwd** 使用同类 replace；当前 `lsp/root-path.ts:11–12` 已用 `fileURLToPath` 修复，该正常行为也在本轮通过控制。当前项是仍未修复的 **工具结果 consumer**，不同源码位置和用户影响；没有把旧 manager 问题重复计入。10-16、10-17、round3 及 review 系列未找到此结果 formatter finding，详见 [去重回执](evidence/coding-dedup.json)。
- 证据：[夹具](evidence/coding-lsp-data.test.ts)、[首跑原始 stdout+stderr](evidence/coding-lsp-data.first.log)、[退出码](evidence/coding-lsp-data.first.exit.txt)。

## CODING-R4-02 [P2] 重复 getDiagnostics 不同步已打开文件的编辑

- 源码：`packages/coding/src/tools/lsp.ts:135–158`，特别是第 156–157 行每次都发送 `textDocument/didOpen`，固定 `version: 1`。整个工具没有 `didChange` / `didClose`。Manager 按 cwd 复用已初始化 client，见 `packages/coding/src/lsp/manager.ts:42–43,253–258`；因此同一 workspace 的连续调用不是新协议 session。
- 触发：对一个文件调用 `getDiagnostics`，修改磁盘内容，再对同一文件调用 `getDiagnostics`。[LSP 3.17 官方 didOpen 合同](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/textDocument/didOpen.md)要求 open/close 成对、同一时刻最多打开一次；打开后内容由 client 管理。已打开文档的变更应使用同步更新或先关闭再重开，重复 `didOpen` 不构成合法的内容更新。官方源由本轮 root 独立只读核对；本 Coding 执行未访问网络。
- 观察：真实工具首次发送 `BROKEN\n`，临时文件随后改成 `export const fixed = true;\n`。第二次仍发送 `didOpen`、`version: 1`，且没有更新/关闭消息。保留首次打开文档的严格内存 adapter 再发布旧内容的诊断，真实工具返回 `Old text is broken`。这证明非法通知序列，以及在该 adapter 下磁盘已修复而诊断仍旧；未声称任何特定真实服务器已经实测。
- 影响：语言服务器可能保留首次打开的文档、拒绝重复打开、或不再发布诊断，后续检查无法可靠对应当前磁盘内容。在本轮 fake adapter 下观察到的是陈旧结果；没有执行 10 秒不发布分支，也没有将假设的等待计为第二项。
- 修复方向：记录已同步文档及版本，按服务器协商的同步方式发送变更；或对独立磁盘检查采用成对 open/close。诊断的版本/请求相关性应和此同步策略一起处理。此次没有实施修复。
- 去重：历史 2026-05-30 diagnostics finding 是固定等待 2 秒且不收集通知，当前第 138–174 行已收集与格式化诊断；本项关注重复检查时的文档内容同步。旧 N15/N16（启动失败、死 client、并发 cold start）均排除、未重跑。详见 [去重回执](evidence/coding-dedup.json)。
- 证据：[夹具](evidence/coding-lsp-data.test.ts)、[首跑原始 stdout+stderr](evidence/coding-lsp-data.first.log)、[退出码](evidence/coding-lsp-data.first.exit.txt)。

## 候选与排除（不计新发现）

| 方向 | 处置与原因 |
| --- | --- |
| `getSymbols` 只映射顶层、没有展开 `children` | 不计。`client.ts:77` 未广告 `hierarchicalDocumentSymbolSupport`；没有确证当前协商合同下合规服务器会返回层级树。实际 flat `SymbolInformation[]` 与空数组控制通过。 |
| `LocationLink.targetSelectionRange` | 不计。`client.ts:74` 未广告 definition `linkSupport`；当前确认的 URI finding 只使用普通 `Location`。没有把可能不在当前合同内的 response 形状当作新发现。 |
| `.js/.jsx/.scss/.less` 的 `languageId` 使用配置所属语言 | 静态候选，未确认。`servers.ts:16–21,56–61` 与 `tools/lsp.ts:157` 可见映射；未运行具体服务器证明语言 mode / 诊断影响，本轮不扩展到真实服务器。 |
| `rootUriToPath` | 已修复/正常控制，不计新发现。 |
| LSP startup、退出、readiness、旧 failed fixtures、N12 | 按本轮范围排除，未执行、未重试，也未用其他方法绕过。 |
| 原生平台、语言服务器安装/可用性、真实 LSP、网络、安全边界 | 明确未覆盖。 |

## 验证与覆盖边界

唯一测试命令：

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round4/evidence/coding-lsp-data.test.ts
```

首跑 **1 文件 / 8 pass / 0 fail / 0 skip / 32 expect() / Completed / exit 0**；没有重跑、修夹具、切换 runner 或执行替代方法。guarded runner 为此次执行提供隔离 HOME 与凭据环境。首跑合并 stdout+stderr 原样保存在 `.first.log`，退出码单独保存。

8 个测试包括：编码 root URI 正常转换、ASCII Definition 与相对请求路径、编码 Definition 缺陷、References 同根因缺陷、flat/empty Symbols、诊断 severity/source/1-based position 与 clean response、101 项诊断的显示上限、重复检查的文档同步。它们是 proof/controls，不是整包基线。`beforeExit` 观察输出未由 Bun test 触发，首跑日志保留的是 assertion 结果；本轮未为追加输出而重跑。

静态读取范围为 `lsp/{client,manager,root-path,servers}.ts`、`tools/lsp.ts`、Coding 注册/exports/prompt 与对应测试，以及 `git/utils.ts` 的 project root 实现与既有测试。Git root 路径只静态阅读，没有新证据或新发现；没有执行 Git fixture。验证不覆盖真实服务器、磁盘 watcher、GUI/TUI 交互、跨平台行为、服务器进程生命周期或全 package 测试。

历史去重扫描 252 个正文/结构化资料（排除历史大体积 validation/evidence 运行材料）；旧 findings 使用 JSON 记录级解析，避免 minified 行漏看。其输入文件哈希、命中记录与边界在 [去重回执](evidence/coding-dedup.json)；源码与执行文件哈希、测试计数在 [验证回执](evidence/coding-receipts.json)。
