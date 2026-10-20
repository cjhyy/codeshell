# Root：普通翻译、主题元数据及 Source 查重

冻结源码 `1b04838474bcd57212f80f791d0e268a00d347e3`。本方向新增确认 **0 项**；没有成功执行新的产品测试，也没有把缺失构建产物或导航命令失败算成产品 bug。

## 静态阅读与已有问题排除

阅读了现有 Sources 审查记录、`packages/core/src/sources/documents/parse.ts` 和 `index-store.ts`、`sources/truncate-utf8.ts`，以及 `sources/collection-url.ts` 的文件名/纯 URL validation 入口；下载器输出有截断，不算完整审查。已有 Office 内部关系路径、namespace 前缀及单文件 JSON 数据转换问题不重复报告；CJK/Latin 词法边界与 phonetic 注音仍保持旧候选状态，没有重跑旧 fixture。未启动 parser worker、PDF/Office 应用、下载器或远端请求。

完整读取 `packages/core/src/themes/manifest.ts`、`audio.ts`、`image.ts`、`paths.ts`，以及 renderer 的 `builtin-character-themes.ts`、`theme-packs.ts`。源代码明确限制 manifest HSL 字符串形状、资源字段、PCM WAV 格式和图像尺寸；这些静态 shape/字节识别函数没有足够证据晋升新 bug。没有安装主题、读取真实用户 registry、解码或播放媒体，也没有开展安全、权限或 native 实验。renderer theme 应用调用方的首个导航搜索被 zsh 未匹配 glob 终止，原命令没有重试，应用投影方向不在本批动态覆盖内：[工具响应转录](evidence/root-static-search-skip.md)。

读取了 `packages/desktop/src/renderer/i18n/translate.ts`、`I18nProvider.tsx`、现有 translate/dict 测试、`uiLanguage.ts`、`dict.ts` 的 namespace 组装入口，以及 Web 的 `i18n/translate.ts`、`lib/uiLanguage.ts` 和 mobile 的选定条目。插值使用 callback 返回字面字符串，普通 `$` 替换 token 不会在这一层被再次解释；fallback 顺序从源码可见。没有据此断言所有文案、placeholder、组件 caller 或语言切换行为正确。

## 翻译 fixture 的首次准备失败，未启动测试

保存 [root-i18n-contract.test.ts](evidence/root-i18n-contract.test.ts)，原计划扫描中英文 placeholder 并给出普通字面值/未知 placeholder 对照。Desktop dictionary 从 Web 包根导入 mobile；收据 collector 硬编码检查本 checkout 的 `packages/web/dist/index.js`，该文件不存在。在首次依赖字节收据准备阶段即抛 `FileNotFoundError`，guarded runner **没有被启动**，没有 Bun/JUnit/pass/fail/expect/completion 收据。实际 package resolver 可能使用共享依赖目标，本方向没有解析或验证；不能由这个路径假设失败推断运行时 import、共享依赖或发布产物有问题。完整工具响应转录及命令在 [root-i18n-preflight-failure.md](evidence/root-i18n-preflight-failure.md)；它不是原始 Bun log。

按照失败即跳过的约束，没有 rebuild/安装、改 import/alias、换 runner、重试或替代验证。该方向标为 SKIP，保存 fixture 的两个声明 case 和计划的两份现有基线均 **零执行**。这次准备失败不计作 Bun shard，不与 TUI 实际启动但 import 失败的分片混计，也不证明发布包缺产物。

## 去重和证据边界

[root-dedup.json](evidence/root-dedup.json) 保存冻结 HEAD 已跟踪的 prior `docs/audit-*`、`docs/review*` 和所有路径段为 `archive`/`_archive` 的 `.md/.json/.txt`：930 文件，其中 362 JSON 全部语法解析成功；主题/翻译相关词项共保存 186 个有界片段。JSON 对象和文本匹配不是 finding 数。这是候选导航语料核对，不代表全文语义穷举，没有用零命中证明不存在旧问题。

本方向仅增加文档和未执行 fixture。没有产品修改、Git 写操作之外的共享状态变更、真实用户数据、模型、付费 API、远端/native/UI/终端行为验证。没有全仓 build/typecheck/lint/test 或干净安装结论；worker 的独立结果由各报告、原始首次日志和 root 汇总索引说明。
