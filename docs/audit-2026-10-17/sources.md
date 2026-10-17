# Sources / Documents 独立审计（2026-10-17）

冻结基线：`ab8b03f86ad38835939d4125b56bf4513cae7f15`。仅修改本报告和 `evidence/sources-*`，未修改产品代码，未执行 Git 操作。

## 轮次一：Office parser、collection read、document cache

已逐段读 `sources/documents/{parse,index-store,worker,runtime}.ts`、`sources/{collection,collection-local}.ts`、`sources/adapters/{collection,local-files}.ts` 和 `tool-system/builtin/sources.ts` 文档查询调用链。

### S01 — [P2] Office 关系 Target 没有按包路径解析，混合路径时静默丢失整张工作表/幻灯片

- **精确位置**：`packages/core/src/sources/documents/parse.ts:291-292`（直接拼接 `root/Target`），`:301-305`（只要任意关系匹配就返回部分结果）。建议审阅锚点 `:291`。
- **调用链**：`ReadSource → readUploadedDocument / readCollectionDocument → loadUploadedDocumentIndex → parseDocumentIsolated → parseDocument → orderedParts`；后续 `buildIndex` 只索引已返回的 parts，普通读取和单文件/跨文件 query 都无法找回被漏掉的内容。
- **正常触发**：XLSX/PPTX 包的内部联系目标使用以包根起始的 `/xl/worksheets/sheet2.xml`、`/ppt/slides/slide2.xml` 或可规范化的 `./worksheets/sheet2.xml`，另一条关系使用既有测试覆盖的普通相对形式。目标 XML 实际存在，原件未变化，无截断预算压力。
- **预期/实际**：workbook/presentation 已明确选择两项，应按声明顺序提取两项；实际仅返回普通相对路径的那项，`truncated: false`，无错误。PPTX 漏掉原始第一张后，还将原始第二张错误标为 `slide 1`。
- **影响**：整张表/页的数据没有进入索引，搜索得到假阴性；结果同时宣称提取未截断，使用者无法区分内容不存在和 parser 静默丢失。
- **证据**：`evidence/sources-parse.test.ts` 前三个 observation，`evidence/sources-parse.log` 有实际 parts JSON。guarded shard 完整成功（5 tests / 10 expectations / 0 failures）；这些断言刻意核对**当前错误行为**，不代表期望行为正确。
- **边界**：实测纯内存 ZIP → 生产 `parseDocument`，未跑外部服务、模型、UI、worker 或完整 ReadSource；调用链和后续索引丢失为源码静态确认。未测试全部 OPC 相对路径形式、非标准部件名和 real Office 应用保存流程。
- **格式合法性**：已读 [Microsoft `Package.CreateRelationship` 的 Remarks](https://learn.microsoft.com/en-us/dotnet/api/system.io.packaging.package.createrelationship?view=net-11.0-pp)，其明确将 `/` 起始的包内绝对路径与普通相对路径都纳入 Internal 关系可用的 URI 引用，并采用 RFC 3986 解析；已读 [RFC 3986 §5.4.1](https://www.rfc-editor.org/rfc/rfc3986.html#section-5.4.1)，其给出 `g` 和 `./g` 等价、`/g` 从根解析的正常例子。这支持 fixture 的 URI 形式，不能仅从本 parser 接受 fixture 推断合法。边界：Microsoft 本页讲 package-level 关系；尝试读取更直接的 PackagePart API 页面失败，已跳过而未重试，目前未用完整 OOXML schema validator 验证 ZIP 包。
- **项目约定**：`docs/todo/workspace-upload-document-index-delivery.md:7` 明确 Office 提取保留页/工作表标签及工作簿/演示文稿关系顺序；S01/S02 的预期也直接来自这条已有交付约定。
- **已知与否**：旧 `docs/audit-2026-10-16/findings.json` 无 sources 条目；对旧 review/audit 以 `orderedParts`、absolute relationship、关系/绝对/丢失等关键词有限查重，无命中（`sources-dedup.log` 空，rg 1 表示无匹配）。暂标为有限查重未发现既有条目。

### S02 — [P3] 将关系命名空间前缀写死为 r，合法别名前缀导致工作表名称和顺序错误

- **精确位置**：`packages/core/src/sources/documents/parse.ts:68` 保留 `attr.name`，`:301` 仅找 `attrs["r:id"]`，`:305-311` 转入按 ZIP 文件名排序的 fallback。建议审阅锚点 `:301`。
- **调用链**：同 S01；错误 `part.label` 随后由 `buildIndex` 放入每个 chunk 的 `part`，并出现在读取/搜索引用中。
- **正常触发**：workbook 使用 `xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships"` 及 `rel:id`，关系 Id 和 Target 与普通相对路径完全一致，显示顺序为 sheet2、sheet1。XML 的 namespace URI 没变，只变更前缀。
- **预期/实际**：应仍提取 `Second visible sheet` 后 `First visible sheet`；实测按 sheet1、sheet2 排序，标签改为内部 ZIP 路径 `xl/worksheets/sheet1.xml`、`xl/worksheets/sheet2.xml`，`truncated: false`。
- **影响**：工作表/幻灯片的语义名称和展示顺序失真，检索引用与原文定位不一致。相较 S01，此 fixture 没有丢正文，因此按 P3 记录。
- **证据和边界**：`sources-parse.test.ts` 第四项及同名 log；纯 parser 动态确认，生产 ReadSource 传播为静态确认。只实测 XLSX，PPTX 共用 `attrs["r:id"]` 路径但未单独动态断言。
- **格式合法性**：已读 [W3C Namespaces in XML 1.0 §4、§6.1](https://www.w3.org/TR/xml-names/#ns-qualnames)，前缀是 namespace name 的占位符，展开名由 namespace URI 与 local name 确定；fixture 的 `r:id` 和 `rel:id` 展开名相同。已读 [Microsoft Open XML Sheet.Id 属性](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.sheet.id?view=openxml-3.0.1)，其将该字段定义为 Relationship Id。此处有原始规范和生产 SDK 文档依据，不依赖 parser 接受来证明合法。
- **已知与否**：有限旧 review 查重未命中，与 S01 相同边界。

### 尚未升级的候选

- `sharedStrings()` / `sheetText()` 不区分普通文本与 `<rPh><t>` 注音文本；第五个纯 parser observation 实测单元格“東京”被提取为“東京トウキョウ”。暂保留候选：尚未核对本项目是否有意把注音算作可搜索内容，不计正式缺陷。

## 轮次二：检索、chunk、跨文件结果和其余 adapter

已静态读取 `searchDocumentIndex/Indexes` 的 corpus 统一权重、chunk overlap 去重重建、UTF-8 byte cap 和 typed receipt 调用链、`local-files` 列举/读取、`mcp-resource` 与 `link` adapter 输出转换、catalog/binding 存储。未据此宣称这些路径无 bug。

- 既有纯 local baseline：`truncate-utf8.test.ts`、`adapters/mcp-resource.test.ts`、`types.test.ts`，guarded 收据 `evidence/sources-pure-baseline.log`：15 tests / 44 expectations / 0 failures。
- 待核语义候选：`index-store.ts:157-164` 将连续 Han+Latin+digit 合成一个 `word`，额外只切 CJK bigram；因此常见“使用Redis保存会话”“2026年预算”“OAuth2登录流程”用 `Redis` / `2026` / `OAuth2` 查询得到假阴性，带空格的同文可命中。已以纯 `searchDocumentIndex` 和 `searchDocumentIndexes` 动态确认对照（`evidence/sources-search.test.ts` 与 `.log`，3 tests / 10 expectations / 0 failures，含一个正常 overlap reconstruction 对照）；是否属预期词法边界还未取得产品约定，暂不计正式发现。
- `MAX_DOCUMENT_*` 明确限制/截断标志、LRU cache 的冻结次序、parser 排队取消/释放、跨文件输出逐项弹出以维持完整 JSON，当前未发现足以正式报告的新问题；这些是有限静态结论，未覆盖竞态穷举。
- 辅助静态跟进了 Desktop `source-collections-service.ts` 的 create/pick/refresh/view 保存及 revision 流程，确认显式 refresh 保留 entry ID、local relativePath，并由新 revision 替换；没有执行 Desktop 产品行为或 external URL 验证。

### S03 — [P2] 单文件查询在序列化后做自由文本脱敏，返回无效 JSON

- **精确位置**：`packages/core/src/tool-system/builtin/sources.ts:686` 对已序列化正文调用 `scrubSecrets`；上游 `sources/adapters/local-files.ts:275` / `adapters/collection.ts:78` 已将 query result `JSON.stringify`。底层消费边界 `utils/secret-scrubber.ts:179-185` 不知道正位于 JSON string，按下一个逗号作为值结束。建议审阅锚点 `sources.ts:686`。
- **调用链**：正常 `ReadSource({source:"project-uploads", scope:"uploads", resource:"notes.txt", query:"Header"}) → readUploadedDocument → JSON.stringify(searchDocumentIndex(...)) → readSourceTool → scrubSecrets(serializedQuery) → wrapUntrustedInput`。collection 的单文件 query 共用同一边界；chunk result 亦先 JSON.stringify 后到该边界。
- **触发**：自造普通占位正文 `Header, password: fixture-value`，输入、query 和输出均远低于所有大小限制。没有真实秘密、认证操作、外部 IO 或构造权限绕过。
- **预期/实际**：占位值应被脱敏，同时 query metadata / matches / chunk id 保持有效 JSON。实测脱敏后的片段变成 `"text":"Header, password: [REDACTED],"score":...`，text 的闭引号被吞掉，`JSON.parse` 抛错；工具仍按正常内容成功返回，`truncated` 无法解释这次损坏。
- **影响**：单文件查询结构无法解析，稳定 chunk 引用/分数/偏移等结果失去机器可读性。跨文件路径已经使用 `scrubSecretValue` 后再序列化，同一正文保持合法 JSON，说明此问题可局限修复于单文件结果的数据变换次序。
- **证据**：`evidence/sources-redaction.test.ts` 动态重现生产函数的相同序列（真实 `searchDocumentIndex → JSON.stringify → scrubSecrets`），并给出 `searchDocumentIndexes → scrubSecretValue → JSON.stringify` 正常对照。`sources-redaction.log` 完整 guarded 收据：2 tests / 5 expectations / 0 failures，原始 before/after JSON 均落盘。
- **生产 handler 追加证据**：`sources-handler.test.ts` 在自有临时 workspace 的 `.code-shell/uploads` 放入普通占位文本，调用真实 `readSourceTool`（包含真实本地 parser worker/index 路径）；带 `ordinary:` 的正常对照可解析，带 `password:` 的结果正常返回但 `JSON.parse` 失败。`sources-handler.log` 完整 guarded 收据：1 test / 6 expectations / 0 failures。
- **边界**：纯函数组合与实际 ReadSource handler/worker 路径均动态确认；未以 UI 或完整 tool executor 审批流程验证，未测试所有正文模式。只报告数据格式损坏，不开展秘密泄漏或攻防分析。
- **已知与否**：旧 audit/review 对“单文件 JSON / ReadSource JSON / scrubSecrets query / 脱敏 JSON”等关键词有限查重，仅命中 Chrome JSON-lines 和损坏磁盘 JSON 等不相关项（`sources-redaction-dedup.log`）；未找到同根因既有条目。

## 最后一小轮与收束

- `evidence/sources-local-document.test.ts` 以自有临时 workspace 实跑正常 `readUploadedDocument → parseDocumentIsolated → index`：12,415 字节 Unicode 原文生成 3 chunks，全文/overlap 重建逐字符一致，查询后的 chunk 与 sourceHash 对应；改写为新版本后旧 chunk 明确拒绝，新 query 返回新 hash/id。`sources-local-document.log`：1 test / 10 expectations / 0 failures。该轮未新增正式发现。
- 只读扫到 `engine/query.ts` 的 async generator 没有 consumer `return/break` 的取消/finally 处理，可能后台 TurnLoop 继续执行。已把线索移交父代理；不属于本次 source 数据读取验证，未运行、未计发现，不从本报告宣称已证实。
- 最终正式发现：S01 P2、S02 P3、S03 P2。保留 2 个 source 语义候选：XLSX phonetic guide 混入正文、Han/Latin/数字邻接词法假阴性。候选没有计入发现总数。
- 完整 guarded 收据合计 **27 tests / 85 expectations / 0 failures / 0 skipped tests**（6 个首次执行 shard）；“0 skipped tests”只指已执行 shard 的 JUnit，不含下方明确跳过的只读搜索/文档请求。所有 stdout/stderr 在首次执行即重定向留存，未失败重试或更换执行方式。
- 覆盖是选定 parser/index/read 例子和有限静态审阅，不是全仓/全格式/全竞态覆盖。Office fixtures 没有通过完整包 schema validator，PDF 和真实远程 URL、UI/executor 审批、系统异常/进程崩溃注入均未执行。

## 验证边界和跳过

- 不执行真实外部服务、模型、权限绕过或安全攻防验证。Office 新 fixture 直接调用纯本地 `parseDocument`，不调用 parser worker，不创建真实应用状态。
- 一条辅助查重/依赖搜索因 zsh 未匹配 `node_modules/@artifact*` 终止，输出为 `zsh:1: no matches found: node_modules/@artifact*`；该搜索跳过，未改道重试，不作为任何发现的证据。
- 已执行：`node scripts/run-bun-test-shard.mjs --timeout 30000 ./docs/audit-2026-10-17/evidence/sources-parse.test.ts > docs/audit-2026-10-17/evidence/sources-parse.log 2>&1`；原始 stdout/stderr 首次执行即重定向留存。
- 只读官方文档请求 `https://learn.microsoft.com/en-us/dotnet/api/system.io.packaging.packagepart.createrelationship?view=net-10.0` 返回 web tool Internal Error / inaccessible；该页面跳过，未重试同页或变换版本 URL。
- 一次辅助关键词搜索同时传入了不存在的 `docs/shared-document-collection-query-delivery.md`，rg 返回该路径不存在 / exit 2；该输入跳过，不重试或改路径读取。已有命中文件仅作为源码导航，不作为新发现证据。
- 既有 baseline 原始 stdout/stderr 首次执行即重定向到 `evidence/sources-pure-baseline.log`，未重跑。
- 一次上传入口辅助搜索含未匹配的 `packages/desktop/src/main/upload*`，zsh 返回 no matches / exit 1；该搜索跳过，未改道重试，对正式发现没有影响。
