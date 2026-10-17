# Desktop 内容搜索与模型选择纯数据审查 — round 13

冻结基线 `7927a7c8b80b4aec710dee1f6d831ad1982bb466`。本分审新增正式问题 **0**，保留 **1 个候选**。唯一首次 guarded shard 通过 **18 tests / 32 expect / 0 fail / 0 skip**（13 项既有测试、5 项聚焦观察）。没有产品修复或 Git 写入。

## 范围与证据边界

- 实际执行 `shell/sessionContentSearch.ts` 的查询解析与 engine→local 映射、`modelSelection.ts` 的设置读写回调；使用自有内存数据，不保存真实设置。`sessionContentSearch` 的真实源码依赖保持原样，没有替换解析器或构建共享依赖。
- `SessionSearchModal.tsx`、`useSessionContentSearch.ts`、preload `index.ts:1046–1047`、Main `index.ts:5026–5032` 仅用于确认普通调用链和校验范围；**没有挂载 UI、调用 IPC 或执行 Main/搜索磁盘服务**。
- `shell/searchFocus.ts:1–16` 及 `SearchDialog.tsx` / `SearchBar.tsx` 的焦点移交接线只静态阅读。未创建 DOM、React、Electron、浏览器、原生焦点或键盘实验，没有确认新焦点问题。
- `chat/modelPickerPresentation.ts` 及其既有测试只静态阅读。历史 round6 的 DD6-04 已因同一 fixture import 失败标为 SKIP，本批继续跳过该动态方向，**没有改用纯分组 fixture 或既有 React 测试恢复它**。
- `persistDefaultTextModel` 在 Desktop 非测试源码检索中只有定义，未找到产品调用方。通过回调控制证明的行为不能扩为当前 UI 默认模型保存结论。

## SEARCH-R13-C1：前端查询 readiness 与 Main 的 trim 后长度合同不一致（候选）

- 位置：`packages/desktop/src/renderer/shell/sessionContentSearch.ts:29–30`。Main 校验位于 `packages/desktop/src/main/index.ts:5029–5030`。
- 正常输入路径：内容搜索输入在 `SessionSearchModal.tsx:141` 形成 `> ${value}`；`:43–47` 把解析所得 `ready` 和原始 term 交给真实 hook。`useSessionContentSearch.ts:26–34` 静态显示 ready 后会请求 term，`:35–36` 将请求错误映射为失败状态。界面错误/重试分支在 `SessionSearchModal.tsx:161–176`。
- 动态观察：实际 `parseContentQuery("> a ")` 返回 `{contentMode:true, term:"a ", ready:true}`，term.trim() 只有 1 字符。实际 parser 对 128 和 129 个 `x` 都返回 ready:true，原 term 完整保留。Main 的真实源码先 trim，再只接受 2–128 字符；这些输入存在可核对的静态边界不一致。
- 对照：`> a` 为 not-ready；`> ab ` 为 ready 且 trim 后长度 2；普通 title query 不进入内容模式。此处没有把前后空白全部删除视为文本搜索语义要求，问题只关乎是否提交后端会拒绝的 term。
- 限制与评级：尚未执行真实 Main handler、debounce、UI 错误文案或 IPC；当前 parser 文档只明确最小长度，没有承诺最大长度提示，也没有“trim 后长度不合格必须由前端阻止”的明确 UI 验收。因此保留候选，不分配 severity，不主张观察到真实搜索失败、结果丢失或用户数据影响。
- 证据：聚焦 fixture 的前两项，[原始首次日志](evidence/search-pure-contracts.first.log)、[退出文件](evidence/search-pure-contracts.first.exit.txt)、[首次收据](evidence/search-pure-contracts.first.receipt.json)。这些是当前行为的 characterization assertions，并非修复后的正确性测试。

## 没有新增正式问题的检查

- 原有 11 项内容搜索测试覆盖 title/content 前缀、最小长度、engine id / 本地 id、归档排除、无项目 bucket、跨 bucket 的既定顺序、磁盘独有结果不可映射。自有 immutable 输入控制补充同样的普通映射、归档与 unknown 结果，全部符合现有合同。没有用人为 engine/local id 碰撞或重复 project id 晋升身份错误。
- 原有 2 项 `modelSelection` 测试及自有 2 项控制验证 user scope、保留其他 defaults、只覆盖 text、缺失设置写 text-only patch、原输入不变。只执行内存读写回调，没有真实设置或模型调用。
- 焦点 helper 会沿 parentNode 寻找已登记 opener，SearchDialog 开启时先 resolve 再 remember。没有足够证据将跨 realm、Shadow DOM、断开节点或真实焦点回收行为列为问题。
- `resolveContentMatch` 的磁盘独有结果和归档结果不可用是明确现有合同；不重复登记旧搜索候选 band、生命周期和不可用结果家族。

## 全历史去重

[search-dedup.py](evidence/search-dedup.py) 检索整个 `docs/` 与 `bugs/` 的 Markdown 和递归解析 JSON 字符串叶，包含所有 archive / _archive，排除本轮目录。结果见 [search-dedup.json](evidence/search-dedup.json)：**1075 Markdown + 641 JSON = 1716 文件，171493 JSON 字符串叶，0 解析错误**；所有扫描文件路径、字节数和 SHA256 均保留。四组匹配分别为 target_helpers 58、identity_fallback 6、content_search 6、picker_focus 10，每组最多保存 120 段上下文，本次没有达到上限。

- `docs/audit-2026-10-17/desktop-data.md` 已读搜索 debounce、A→B→A 身份和磁盘结果禁用，本批不重复计缺陷。
- `docs/audit-2026-10-17-round6/desktop-display.md` DD6-04 为已有失败 SKIP，保持跳过。
- `docs/review-2026-10-12/search-routing-round11.md` 已记录搜索 candidate band / 结果完整性与普通生命周期边界；不同于此处前端 ready 和请求校验范围，旧报告已提到 Main trim 2–128 的合同。本批未重跑旧搜索磁盘或 UI 实验。
- `docs/review-2026-10-12/model-switch-round18.md` / 原始保留报告已有模型偏好覆盖；本批没有恢复持久偏好、多窗口、模型运行或真实设置方向。
- 没有恢复旧 i18n、TUI Diff / Questions、JSON summary、Discord、Memory TTL、原生或权限安全失败方向。

## 首次执行收据

命令为 `node scripts/run-bun-test-shard.mjs --timeout 30000 packages/desktop/src/renderer/shell/sessionContentSearch.test.ts packages/desktop/src/renderer/modelSelection.test.ts docs/audit-2026-10-17-round13/evidence/search-pure-contracts.test.ts`。

[search-first-run.py](evidence/search-first-run.py) 在检查输出前保存 combined stdout+stderr 和退出文件，并拒绝覆盖已有 first-run 产物。原始日志显示 18 pass / 0 fail / 32 expect，guarded runner 显示 Completed、0 skipped、0 failures；exit 0。未修 fixture、未重试、未替代验证，没有新的 fixture/dependency/platform/assert 失败。机器汇总见 [search-validation.json](evidence/search-validation.json)，实际源文件冻结 Git blob、当前字节一致性和有限阅读范围见 [search-source-manifest.json](evidence/search-source-manifest.json)。

仅写本报告与 `evidence/search-*`。没有 UI/真实 DOM、Electron、native/PTY、模型、网络、账户、用户数据、真实自动化、实际设置保存、产品 Git 或文件搜索执行；没有 shared dist/dependency build、全套 lint/typecheck 或广泛套件通过声明。
