# 输入附件与产物路径投影审查

冻结源码：`248d091202869c07274adedf4fd50403105f1b1f`。本方向确认 **1 项 P3**；首次 guarded shards 合计 **45 pass / 103 expect / 0 fail / 0 skip**，其中 5 项是本轮路径投影/元数据测试和对照，40 项为既有基线。未修改产品代码。

## ATT-R9-01 — [P3] 工作区路径含空格时，生成产物被投影成错误的附件路径

- **位置**：[tool-cards/attachments.ts:56](../../packages/desktop/src/renderer/tool-cards/attachments.ts:56) 的 `PATH_TOKEN_RE` 不包含空白；结果扫描在 `:115–119` 把每个分段交给 `push`，`:85–89` 接受带目录和已知扩展名的残余片段。
- **正常触发**：用户在 `project with spaces` 这样的普通工作区中生成图片。真实生产 formatter 在 [generate-image.ts:485](../../packages/core/src/tool-system/builtin/generate-image.ts:485) 到 `:496` 用 `join(cwd, ".code-shell", "generated_images", ...)` 得到完整路径，然后原样插入 `Generated image with …, saved to …`。`GenerateImage` 在 [tool-cards/index.tsx:132](../../packages/desktop/src/renderer/tool-cards/index.tsx:132) 的通用分支使用 `GenericToolCard`；这里没有从 args 提取生成图片输出路径的补偿（detector 的 args 分支只处理 Write 类工具）。
- **契约与实际**：附件 detector 的模块注释要求返回可点击的产物路径；对完整、不含空白的 Unicode 路径已有基线保证。自有临时工作区中的实际文件为 `<tmp>/project with spaces/.code-shell/generated_images/1782-audit.png`，生产 detector 返回 `spaces/.code-shell/generated_images/1782-audit.png`。原文件存在，把错误 card path 按同一个 cwd 解析后得到另一条不存在的路径。另一个同根因变体是 `/fixture/project/final report.png` 被完全漏掉；相邻 `final-report.png` 正常。
- **传播与影响**：[GenericToolCard.tsx:39](../../packages/desktop/src/renderer/tool-cards/GenericToolCard.tsx:39) 直接调用 detector，`:82–83` 原样创建 `AttachmentCard`；[AttachmentCard.tsx:55](../../packages/desktop/src/renderer/tool-cards/AttachmentCard.tsx:55) 把该 path 交给 `openPath`，`:119–131` 的缩略图也用它与 cwd 拼接。因而该工作区条件下的通用产物卡定位错误，或不出现。完整正确路径仍保留在原始结果文字中，原文件字节没有丢失；不宣称整条任务失败。
- **动态证据**：[首次 fixture](evidence/attachments-path-projection.test.ts) 的前三项直接运行生产 `detectAttachments`，用自有临时文件验证正确原路径存在、错误投影不存在。完整 CJK 路径、Write 结构化 args 中的完整空格路径，以及无目录的普通文件名提及构成对照。最后两项直接运行 Core `buildInputAttachmentContext`，验证普通文本文件大小来自实际文件、正文不被注入，普通目录元数据按现有规则输出并过滤 `.git`/`node_modules`。[原始日志](evidence/attachments-path-projection.first.log)：5 pass / 24 expect / Completed。
- **边界**：没有调用 `GenerateImage`、图像 provider、远端 API、图片解码器、Electron、真实 IPC 或原生打开操作。formatter、通用卡和缩略图接线均为源码证据；临时 `.png` 只存合成文本字节，测试不把它当真实图片解码。仅确认普通 POSIX 空格路径的 detector 投影，不声称 Windows 平台已运行或完整 UI 已实测。
- **去重**：[收据](evidence/attachments-dedup.json) 扫描 `docs/` 和 `bugs/` 下 1,019 个 Markdown、471 个 parsed JSON（109,734 string leaves，0 parse errors），涵盖 `archive/` 与 `_archive/`；每种模式最多保留 100 段上下文。五月 `Write success detection relies on fragile result string heuristic` 已排除。五月 Core `run/ArtifactTracker.ts` 的 shell 重定向解析空格问题是相关路径解析类别，但消费者、输入契约和源码函数不同；修复该 shell parser 不会修复此 renderer detector。本项未找到同生产函数和同空白分词根因的旧记录；这是关键词/结构化记录查重，不能视为全历史语义穷尽证明。
- **修复方向（仅建议）**：优先从结构化产物元数据或可识别的完整 formatter 字段取得路径；通用 prose fallback 应避免把残余路径片段误当完整文件路径，并保留现有长 base64 输入的线性处理特性。未实现修复。

## 其余覆盖与未计入项

- 完整读取 Core `input-attachments.ts`、`run-image-input.ts`、`parse-task.ts`、`image-policy.ts`，以及 Desktop `attachmentSession.ts`、composer 附件编解码、tool-card detector、`AttachmentCard`、`GenericToolCard` 和卡片 dispatcher。App 中附件 session 准备/路径转换、ChatView 中附件 metadata/提交构造仅选择性阅读，没有据此声明完整 App 生命周期覆盖。
- `resolveAttachmentSessionId` 的 engine/UI id 映射、普通 wire name/path 转义和空 body 处理、CJK 完整路径、结果去重与长 base64 扫描的既有测试通过。[首次基线日志](evidence/attachments-existing-baseline.first.log)：40 pass / 79 expect / 3 files / Completed。
- Windows drive/backslash 路径在当前 detector 和 `ImageThumb` 中存在静态兼容性疑点；本轮不做 Windows/native 验证，不计为额外 finding。
- 目录最大深度为 2，而 `truncated` 仅在 200 条目上限时置真。是否应把深度省略也标成截断缺少明确消费契约；保留普通源码观察，不构造 fixture，不计为 bug。
- 旧 staged attachment session/hash/TOCTOU、跨路径策略、legacy/modern history 附件显示，以及 Web mobile normalization 家族已知或在排除范围，不重跑。当前 `run-image-input.ts` 的非视觉结构化图片降级注释是显式行为，旧 vision-gate 记录不当作新 finding。

首次测试日志、退出码、冻结源码 SHA 与工作区一致性见 [validation](evidence/attachments-validation.json) 和 [source manifest](evidence/attachments-source-manifest.json)。测试只证明所列数据函数及自有临时文件行为；不代表全仓构建、typecheck、lint、完整测试套件或真实模型/平台验收。
