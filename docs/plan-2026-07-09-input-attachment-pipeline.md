# 输入附件接入总线实现方案（2026-07-09）

本文把 TODO.md 中「粘贴图片落盘 / 附件路径化」「主 agent 本地图片视觉读取」「通用输入接入总线」合并为一条可串行落地的 input-attachment pipeline 方案。

推荐 MVP 边界：先做「图片附件路径化闭环」，即桌面粘贴/OS drop/文件面板图片统一落盘到工作区 `.code-shell/attachments/`，发送给模型时同时提供可引用路径和 vision image part；`@dir`、通用二进制附件、DriveAgent 直接透传 CLI 图片参数放到后续 stage。

## 1. 现状事实

### 1.1 已确证：桌面 composer 图片附件

- `packages/desktop/src/renderer/chat/attachments.ts:1` 到 `packages/desktop/src/renderer/chat/attachments.ts:7` 明确说明当前图片附件是 renderer-only，不碰磁盘，发送时以内联 wire format 进入 engine。
- `ImageAttachment` 只有 `id/name/mime/dataUrl/size`，没有 path/hash/origin/sessionId，见 `packages/desktop/src/renderer/chat/attachments.ts:17` 到 `packages/desktop/src/renderer/chat/attachments.ts:28`。
- 普通粘贴/OS drop 图片通过 `FileReader.readAsDataURL` 读成 data URL，见 `packages/desktop/src/renderer/chat/attachments.ts:62` 到 `packages/desktop/src/renderer/chat/attachments.ts:68`；`buildAttachments` 只做 MIME、数量、大小校验后把 data URL 放入内存对象，见 `packages/desktop/src/renderer/chat/attachments.ts:77` 到 `packages/desktop/src/renderer/chat/attachments.ts:123`。
- 支持的图片 MIME 是 png/jpeg/jpg/webp/gif，单张 UI 上限 10MB、每条消息最多 6 张，见 `packages/desktop/src/renderer/chat/attachments.ts:37` 到 `packages/desktop/src/renderer/chat/attachments.ts:49`。
- 文件面板拖入的 on-disk 图片已有半个路径化流程：`buildPathAttachment` 保留绝对路径作为 `name`，并要求调用方通过 `images:readDataUrl` 读 bytes，见 `packages/desktop/src/renderer/chat/attachments.ts:150` 到 `packages/desktop/src/renderer/chat/attachments.ts:190`。这不适用于普通粘贴/OS drop，因为 browser `File` 没有稳定工作区 path。
- 当前发送 wire format 是把每张图片编码成 `<codeshell-image mime="..." name="...">dataUrl</codeshell-image>` 拼进单个 `task` 字符串，见 `packages/desktop/src/renderer/chat/attachments.ts:194` 到 `packages/desktop/src/renderer/chat/attachments.ts:213`。
- 展示侧会把 `<codeshell-image>` 从用户气泡中解回缩略图，避免显示 base64，见 `packages/desktop/src/renderer/chat/attachments.ts:263` 到 `packages/desktop/src/renderer/chat/attachments.ts:289`。
- 粘贴只提取 clipboard 中 `kind === "file"` 且 `type.startsWith("image/")` 的项，见 `packages/desktop/src/renderer/chat/attachments.ts:292` 到 `packages/desktop/src/renderer/chat/attachments.ts:307`；drop 同样只过滤图片文件，见 `packages/desktop/src/renderer/chat/attachments.ts:310` 到 `packages/desktop/src/renderer/chat/attachments.ts:324`。
- `ChatView.submit` 在发送前调用 `encodeAnchorsForWire` 再 `encodeAttachmentsForWire`，然后把单个 payload 交给 `onSend`/`onQueueInput`，见 `packages/desktop/src/renderer/ChatView.tsx:578` 到 `packages/desktop/src/renderer/ChatView.tsx:601`。
- `ChatView.acceptFiles` 先 `buildAttachments`，再 `compressBatch`，然后把附件存在 React state，见 `packages/desktop/src/renderer/ChatView.tsx:613` 到 `packages/desktop/src/renderer/ChatView.tsx:630`。粘贴入口调用它，见 `packages/desktop/src/renderer/ChatView.tsx:632` 到 `packages/desktop/src/renderer/ChatView.tsx:638`。
- OS drop 对内部 file-panel path 和普通文件分流：内部图片 path 调 `onAttachImagePath`，非图片只插入 `@path` 文本；普通 OS drop 图片则走 `imageFilesFromDrop` 和 `acceptFiles`，见 `packages/desktop/src/renderer/ChatView.tsx:846` 到 `packages/desktop/src/renderer/ChatView.tsx:865`。
- 文件面板图片路径由 `App.attachImageByPath` 通过 `window.codeshell.readImageDataUrl(absPath)` 读取，再 `buildPathAttachment` 放入 composer，见 `packages/desktop/src/renderer/App.tsx:379` 到 `packages/desktop/src/renderer/App.tsx:392`。
- 忙碌时的「引导」按钮直接 `encodeAttachmentsForWire(draft.trim(), attachments)`，没有 anchor，也没有结构化附件参数，见 `packages/desktop/src/renderer/ChatView.tsx:1366` 到 `packages/desktop/src/renderer/ChatView.tsx:1377`。

### 1.2 已确证：`@` 文件搜索和路径插入

- file-search-service 的职责就是 composer `@` mention 文件搜索，注释说明优先 `git ls-files`，fallback 递归 `fs.readdir`，见 `packages/desktop/src/main/file-search-service.ts:1` 到 `packages/desktop/src/main/file-search-service.ts:13`。
- `FileSearchHit` 只有 `path` 和 `name`，没有 `kind`、`mime`、`size`、`hash`、目录类型或 attachment 类型，见 `packages/desktop/src/main/file-search-service.ts:18` 到 `packages/desktop/src/main/file-search-service.ts:23`。
- fallback walk 只把 `entry.isFile()` 加入结果，目录只递归不返回，见 `packages/desktop/src/main/file-search-service.ts:105` 到 `packages/desktop/src/main/file-search-service.ts:109`。
- `searchFiles` 最终只返回前 30 个文件 hit，见 `packages/desktop/src/main/file-search-service.ts:169` 到 `packages/desktop/src/main/file-search-service.ts:180`。
- main 的 `files:search` IPC 只是校验 cwd 字符串后调用 `searchFiles(cwd, q)`，见 `packages/desktop/src/main/index.ts:1979` 到 `packages/desktop/src/main/index.ts:1983`。
- Mention popover 说明当前只有「插件」和「文件」两个 section，见 `packages/desktop/src/renderer/chat/MentionPopover.tsx:1` 到 `packages/desktop/src/renderer/chat/MentionPopover.tsx:7`。
- Mention popover 的 `MentionItem` 只有 `skill` 或 `file`，见 `packages/desktop/src/renderer/chat/MentionPopover.tsx:24` 到 `packages/desktop/src/renderer/chat/MentionPopover.tsx:27`。
- 文件搜索结果从 `window.codeshell.searchFiles(cwd, query)` 异步获取，见 `packages/desktop/src/renderer/chat/MentionPopover.tsx:65` 到 `packages/desktop/src/renderer/chat/MentionPopover.tsx:77`。
- 选择文件 mention 后，ChatView 只把 `@${item.file.path} ` 作为文本插入 draft，没有结构化引用，见 `packages/desktop/src/renderer/ChatView.tsx:537` 到 `packages/desktop/src/renderer/ChatView.tsx:555`。
- 内部 file-panel 非图片拖入也只是插入 `@${absPath}` 文本，见 `packages/desktop/src/renderer/ChatView.tsx:513` 到 `packages/desktop/src/renderer/ChatView.tsx:535`。

### 1.3 已确证：desktop image IPC

- `images:readDataUrl` 的注释说明 renderer 不能直接依赖 `file://`，缩略图通过 IPC 返回 data URL，见 `packages/desktop/src/main/index.ts:2003` 到 `packages/desktop/src/main/index.ts:2007`。
- 该 IPC 只接受绝对路径、图片扩展名，使用 `lstat` 拒绝 symlink，25MB 以上返回 null，见 `packages/desktop/src/main/index.ts:2012` 到 `packages/desktop/src/main/index.ts:2035`。
- preload 只暴露 `readImageDataUrl(absPath)`，见 `packages/desktop/src/preload/index.ts:620` 到 `packages/desktop/src/preload/index.ts:621`；类型注释也说明它是 absolute path data URL reader，见 `packages/desktop/src/preload/types.d.ts:785` 到 `packages/desktop/src/preload/types.d.ts:789`。
- 这个 IPC 没有 cwd/session/path-policy 参数；它适合 UI 展示，不应直接当作主 agent 权限模型。

### 1.4 已确证：desktop 到 core 的 run 输入

- desktop renderer 的 `send()` 只接收 `text` 和 `{ bucket, clientMessageId }`，见 `packages/desktop/src/renderer/App.tsx:2008` 到 `packages/desktop/src/renderer/App.tsx:2011`。
- `send()` 构造的 core opts 只有 `cwd/sessionId/permissionMode/goal/clientMessageId`，没有 attachments 字段，见 `packages/desktop/src/renderer/App.tsx:2101` 到 `packages/desktop/src/renderer/App.tsx:2107`。
- no-repo 聊天也会显式传 `cwd`，真实 repo 用 repo path，否则用 no-repo sandbox cwd，见 `packages/desktop/src/renderer/App.tsx:2111` 到 `packages/desktop/src/renderer/App.tsx:2117`。
- preload 的 `run(task, opts)` 把 `{ task, ...opts }` 直接发到 `agent/run`，`opts` 类型目前列出 cwd/sessionId/permissionMode/planMode/clientMessageId，见 `packages/desktop/src/preload/index.ts:303` 到 `packages/desktop/src/preload/index.ts:315`。
- preload 类型文件中的 `run(prompt, opts)` 也没有 attachments 字段，见 `packages/desktop/src/preload/types.d.ts:432` 到 `packages/desktop/src/preload/types.d.ts:450`。
- main `agent-bridge` 对 `agent/run` 只注入 `projectTrusted`，其它字段透传 worker，见 `packages/desktop/src/main/agent-bridge.ts:296` 到 `packages/desktop/src/main/agent-bridge.ts:334`。

### 1.5 已确证：core protocol 与多模态装配

- `RunParams` 目前只有 `task: string` 作为用户输入主体，没有结构化 `content[]` 或 `attachments[]`，见 `packages/core/src/protocol/types.ts:72` 到 `packages/core/src/protocol/types.ts:125`。
- `AgentClient.run` 最终把 `RunParams` 作为 `agent/run` 参数发送，见 `packages/core/src/protocol/client.ts:117` 到 `packages/core/src/protocol/client.ts:149`。
- `AgentServer.handleRunMulti` 校验 `sessionId` 和 `task`，创建 session 后把 `params.task` 传给 `session.enqueueTurn`，见 `packages/core/src/protocol/server.ts:394` 到 `packages/core/src/protocol/server.ts:509`。
- `ChatSession.pump` 最终调用 `engine.run(next.task, opts)`，没有附件参数，见 `packages/core/src/protocol/chat-session.ts:203` 到 `packages/core/src/protocol/chat-session.ts:220`。
- `parse-task.ts` 明确说明 desktop 因 RPC schema 只有 `task: string`，所以图片先编码成 `<codeshell-image>` 再由 engine 解析，见 `packages/core/src/engine/parse-task.ts:1` 到 `packages/core/src/engine/parse-task.ts:21`。
- `ParsedImage` 当前只有 `mime/name/dataUrl/base64`，没有 path/hash/size/origin，见 `packages/core/src/engine/parse-task.ts:24` 到 `packages/core/src/engine/parse-task.ts:33`。
- parser 只识别 `mime` 和 `name` attrs，并要求 body 是 base64 data URL，见 `packages/core/src/engine/parse-task.ts:89` 到 `packages/core/src/engine/parse-task.ts:107`、`packages/core/src/engine/parse-task.ts:141` 到 `packages/core/src/engine/parse-task.ts:157`。
- `Engine.run` 在其它 gate 前解析 `<codeshell-image>`，防止 base64 被噪音检测误判，并在非 vision 模型上拒绝，见 `packages/core/src/engine/engine.ts:1020` 到 `packages/core/src/engine/engine.ts:1064`。
- engine 侧有统一图片 policy：每张 2MB、每轮 6MB、最多 6 张，见 `packages/core/src/engine/image-policy.ts:42` 到 `packages/core/src/engine/image-policy.ts:62`。
- engine 会尝试压缩或丢弃过大的图片，见 `packages/core/src/engine/engine.ts:1065` 到 `packages/core/src/engine/engine.ts:1126`。
- 当前用户消息装配逻辑：有图片时生成一个 text block 加多个 image block，provider 后续转成 OpenAI `image_url` 或 Anthropic base64 image，见 `packages/core/src/engine/engine.ts:1335` 到 `packages/core/src/engine/engine.ts:1374`。
- engine 已有 `<attached-image-paths>` 回显：如果 `ParsedImage.name` 能解析为存在的文件路径，就把路径作为文本提示给模型，见 `packages/core/src/engine/engine.ts:1340` 到 `packages/core/src/engine/engine.ts:1358`。
- `collectAttachedImagePaths` 只看 `ParsedImage.name` 并要求解析后的文件存在，粘贴截图的裸文件名不会进入 path hint，见 `packages/core/src/engine/image-policy.ts:255` 到 `packages/core/src/engine/image-policy.ts:280`。

### 1.6 已确证：内置工具 Read / Glob / view_image

- `Read` 工具描述是读本地文件并返回带行号文本，schema 只有 `file_path/offset/limit`，见 `packages/core/src/tool-system/builtin/read.ts:13` 到 `packages/core/src/tool-system/builtin/read.ts:34`。
- `Read` 只在文件超过 5MB 时拒绝；否则直接 `readFile(filePath, "utf-8")`，没有图片 MIME 检测或二进制降级，见 `packages/core/src/tool-system/builtin/read.ts:49` 到 `packages/core/src/tool-system/builtin/read.ts:64`。
- `Glob` 只返回文件，`nodir: true`，且默认 `dot: false`，见 `packages/core/src/tool-system/builtin/glob.ts:44` 到 `packages/core/src/tool-system/builtin/glob.ts:51`。
- `view_image` 已存在，描述为把本地图片文件或历史图片作为 base64 image ContentBlock 回传给 vision 模型，见 `packages/core/src/tool-system/builtin/view-image.ts:1` 到 `packages/core/src/tool-system/builtin/view-image.ts:13`。
- `view_image` 支持 `path` 或 `imageNumber` 二选一，支持 PNG/JPEG/GIF/WebP，见 `packages/core/src/tool-system/builtin/view-image.ts:34` 到 `packages/core/src/tool-system/builtin/view-image.ts:56`。
- `view_image(path)` 会按 ctx.cwd 解析相对路径，非 vision 模型时不读文件，见 `packages/core/src/tool-system/builtin/view-image.ts:82` 到 `packages/core/src/tool-system/builtin/view-image.ts:94`。
- `view_image` 对格式和大小有 gate：不支持 SVG/PDF，超过 5MB 返回文字提示，不读进 base64，见 `packages/core/src/tool-system/builtin/view-image.ts:96` 到 `packages/core/src/tool-system/builtin/view-image.ts:113`。
- 成功时 `view_image` 返回 `{ contentBlocks: [{ type: "image", source: ... }], result }`，见 `packages/core/src/tool-system/builtin/view-image.ts:115` 到 `packages/core/src/tool-system/builtin/view-image.ts:127`。
- builtin registry 支持工具返回 `contentBlocks`，见 `packages/core/src/tool-system/builtin/index.ts:136` 到 `packages/core/src/tool-system/builtin/index.ts:145`；ToolRegistry 会把它归一化进 `ToolResult.contentBlocks`，见 `packages/core/src/tool-system/registry.ts:148` 到 `packages/core/src/tool-system/registry.ts:165`。
- TurnLoop 会把带 `contentBlocks` 的 tool result 原样放进 `tool_result.content`，见 `packages/core/src/engine/turn-loop.ts:172` 到 `packages/core/src/engine/turn-loop.ts:187`。
- transcript 也会持久化 tool result 的 `contentBlocks` 并在 replay 时还原进 message，见 `packages/core/src/session/transcript.ts:89` 到 `packages/core/src/session/transcript.ts:102`、`packages/core/src/session/transcript.ts:171` 到 `packages/core/src/session/transcript.ts:188`。
- OpenAI provider 会把 `view_image` 返回的 nested image 从 tool result 中 hoist 成 user image part，见 `packages/core/src/llm/providers/openai.ts:858` 到 `packages/core/src/llm/providers/openai.ts:881`。
- Anthropic provider 直接把 nested image blocks 映射到 tool_result content，见 `packages/core/src/llm/providers/anthropic.ts:384` 到 `packages/core/src/llm/providers/anthropic.ts:417`。

### 1.7 已确证：路径权限

- builtin `Read` 声明了 `pathPolicy: [{ arg: "file_path", operation: "read" }]`，见 `packages/core/src/tool-system/builtin/index.ts:159` 到 `packages/core/src/tool-system/builtin/index.ts:170`。
- builtin `view_image` 声明了 `pathPolicy: [{ arg: "path", operation: "read" }]`，见 `packages/core/src/tool-system/builtin/index.ts:230` 到 `packages/core/src/tool-system/builtin/index.ts:240`。
- builtin `Glob` 声明了 `pathPolicy`，且 `defaultToCwd: true`，见 `packages/core/src/tool-system/builtin/index.ts:263` 到 `packages/core/src/tool-system/builtin/index.ts:273`。
- executor 会在工具 handler 触盘前统一执行声明式 pathPolicy，见 `packages/core/src/tool-system/executor.ts:302` 到 `packages/core/src/tool-system/executor.ts:314`。
- 相对 pathPolicy 参数会先按 `ctx.cwd` 解析，数组参数会逐项处理，见 `packages/core/src/tool-system/executor.ts:586` 到 `packages/core/src/tool-system/executor.ts:614`。
- path classifier 的决策矩阵是工作区内 allow、敏感读 ask、敏感写 deny、工作区外 ask，见 `packages/core/src/tool-system/path-policy.ts:460` 到 `packages/core/src/tool-system/path-policy.ts:539`。
- `enforcePathPolicyWithApproval` 在有 ctx.cwd 时启用；`bypassPermissions` 会跳过 path approval，见 `packages/core/src/tool-system/path-policy.ts:582` 到 `packages/core/src/tool-system/path-policy.ts:610`。
- `~/.code-shell` 被列为敏感目录，见 `packages/core/src/tool-system/path-policy.ts:77` 到 `packages/core/src/tool-system/path-policy.ts:86`。这会影响 no-repo cwd 下的附件读取，见开放问题。

### 1.8 已确证：DriveAgent / 外部 CLI 转交

- `DriveAgent` schema 只有 `prompt/cli/resumeSessionId/cwd/permissionMode/background`，没有 attachments 或 image paths 参数，见 `packages/core/src/tool-system/builtin/drive-claude-code.ts:27` 到 `packages/core/src/tool-system/builtin/drive-claude-code.ts:65`。
- `makeDriveAgentTool` 读取 prompt、cwd、cli、resumeSessionId、permissionMode，构造 `runOpts` 时也没有附件字段，见 `packages/core/src/tool-system/builtin/drive-claude-code.ts:223` 到 `packages/core/src/tool-system/builtin/drive-claude-code.ts:270`。
- 默认 runner 只把 `{ command, prompt, resumeSessionId, cwd, permissionMode }` 交给 `runAgentOnce`，见 `packages/core/src/tool-system/builtin/drive-claude-code.ts:79` 到 `packages/core/src/tool-system/builtin/drive-claude-code.ts:85`。
- external `AgentAdapter.BuildArgsOpts` 只有 `prompt/resumeSessionId/permissionMode/cwd`，没有 images，见 `packages/core/src/cc-orchestrator/agent-adapter.ts:3` 到 `packages/core/src/cc-orchestrator/agent-adapter.ts:8`。
- Claude adapter 用 `claude -p <prompt> ...`，没有 image/path 参数，见 `packages/core/src/cc-orchestrator/agent-adapter.ts:44` 到 `packages/core/src/cc-orchestrator/agent-adapter.ts:62`。
- Codex adapter 用 `codex exec --json --color never --skip-git-repo-check ... -`，prompt 通过 stdin，当前没有 `-i/--image`，见 `packages/core/src/cc-orchestrator/agent-adapter.ts:83` 到 `packages/core/src/cc-orchestrator/agent-adapter.ts:112`。
- driver 用 adapter.buildArgs 生成 argv，codex 时把 prompt 写入 stdin，见 `packages/core/src/cc-orchestrator/external-agent-driver.ts:32` 到 `packages/core/src/cc-orchestrator/external-agent-driver.ts:56`。

### 1.9 已确证：落盘位置与隐私现状

- `GenerateImage` 已有写入 `<cwd>/.code-shell/generated_images/<timestamp>.png` 并返回绝对路径的先例，见 `packages/core/src/tool-system/builtin/generate-image.ts:10` 到 `packages/core/src/tool-system/builtin/generate-image.ts:14`。
- 根 `.gitignore` 忽略 `.code-shell/`，见 `.gitignore:24` 到 `.gitignore:30`。
- 当前仓库实际已有 `.code-shell/agents`、`.code-shell/generated_images`、`.code-shell/tmp`，由本次只读核查命令确认。
- `codeShellHome()` 默认是 `~/.code-shell`，可由 `CODE_SHELL_HOME` 覆盖，见 `packages/core/src/session/session-manager.ts:86` 到 `packages/core/src/session/session-manager.ts:95`。
- desktop no-repo cwd 是 `~/.code-shell/no-repo`，用于避免 agent worker 在 `$HOME` 下运行，见 `packages/desktop/src/main/agent-bridge.ts:52` 到 `packages/desktop/src/main/agent-bridge.ts:66`。
- settings 默认 scope 是 project，只读 `${cwd}/.code-shell`，不读 host user `~/.code-shell`，见 `packages/core/src/settings/manager.ts:184` 到 `packages/core/src/settings/manager.ts:250`。

### 1.10 推测 / 未确证

- 推测：普通 OS drop 的 browser `File` 在当前 renderer 中没有可用、可靠、跨平台的真实文件 path。代码没有读取 `file.path`，只读 data URL，见 `packages/desktop/src/renderer/chat/attachments.ts:77` 到 `packages/desktop/src/renderer/chat/attachments.ts:123`。方案按「OS drop/paste 必须复制落盘」设计。
- 推测：Claude Code CLI 当前是否有等价于 Codex `-i/--image` 的 headless 参数未在仓库代码中体现；本方案只确证 CodeShell 现有 adapter 未传图片参数。
- 推测：Codex CLI 的 `-i/--image` 能力来自 TODO 背景，本次没有运行外部 CLI help 做版本核查。实现前若要自动传 `-i`，应在用户环境中做 feature detection。

## 2. 目标、非目标与 MVP

### 2.1 目标

1. 桌面粘贴、OS drop、文件面板拖入、未来 picker 选择的输入对象，都先规范化成统一附件元数据：path、mime、size、hash、origin、sessionId、createdAt。
2. 粘贴/OS drop 图片自动复制到受工作区权限约束的附件目录，消息中有稳定相对路径，可被 `Read`、`view_image`、Markdown `![](path)`、文档写作和 DriveAgent prompt 引用。
3. 图片对模型同时呈现两层信息：文本 path hint 和真正 vision image part。path 用于工具/子代理，image part 用于视觉理解。
4. 已存在于工作区的图片继续走 `view_image(path)`；`Read` 对图片/二进制不再吐乱码，而是返回 path、mime、size、hash 和「请用 view_image」提示。
5. 扩展 composer `@` 和 picker，使其能区分 `@file`、`@dir`、最近附件，最终不只是插入文本，而是写入结构化 attachment/reference。
6. 大文件、二进制、未知类型默认只给 path + metadata，不内联内容。
7. 统一清理、去重、隐私与默认 git-ignore 策略。

### 2.2 非目标

- MVP 不做任意二进制内容解析、OCR、PDF 渲染、Office 文档预览或云端上传。
- MVP 不做目录全文摘要。目录引用先给受限 tree/metadata，细读仍由 agent 用 `Glob`/`Read`。
- MVP 不要求修改外部 Claude Code CLI 行为；Claude Code 先通过 prompt path handoff。
- MVP 不把附件目录设计成公开 URL 或长期 artifact registry。
- MVP 不自动把所有 `@path` 文本 retroactively 解析成附件。只处理 picker/mention/drop 产生的结构化引用。

### 2.3 推荐 MVP 边界

推荐第一版只覆盖图片：

- 粘贴/OS drop 图片落盘到 `<cwd>/.code-shell/attachments/<sessionId>/...`。
- ImageAttachment 增加 `path/relPath/sha256/origin/sessionId`。
- 发送时仍保持 `<codeshell-image>` 兼容格式，但新增 path/hash/size/origin attrs，避免一次性改穿所有协议层。
- core parser 读取新增 attrs，`<attached-image-paths>` 优先使用 path attr。
- `Read` 对图片/二进制降级为 metadata + `view_image` 提示。
- DriveAgent MVP 只保证 prompt 中有真实 path；Codex `-i` 直传放到后续。

这样能先解决「主 agent、文档、Markdown、DriveAgent 都拿不到路径」的核心痛点，同时保留现有 vision 行为和回退路径。

## 3. 统一数据模型

### 3.1 附件元数据结构

建议定义协议层类型，core 使用 `packages/core/src/protocol/types.ts`，desktop renderer/preload 复制或 type-only 引用对应 shape：

```ts
export type InputAttachmentKind = "image" | "file" | "directory";

export type InputAttachmentOrigin =
  | "paste"
  | "os-drop"
  | "file-panel"
  | "picker"
  | "mention"
  | "generated"
  | "tool";

export interface InputAttachmentMeta {
  id: string;              // att_<sha256:16>_<counter>，UI 和 manifest 用
  sessionId: string;
  kind: InputAttachmentKind;
  origin: InputAttachmentOrigin;

  path: string;            // 推荐给模型看的路径，优先 cwd-relative
  absPath: string;         // main/core 内部可用，永不展示给不需要的 UI
  relPath?: string;        // 相对 cwd，例如 .code-shell/attachments/sid/x.png

  mime?: string;
  size: number;
  sha256: string;
  originalName?: string;
  createdAt: number;

  sourcePath?: string;     // 仅 file-panel/picker 且安全时记录；paste 不填
  width?: number;
  height?: number;

  vision?: {
    include: boolean;      // image 默认 true；大图/非 vision 模型可降级 false
    mediaPath?: string;    // 可指向缩略派生图，保留原始 path 给工具
    detail?: "low" | "standard" | "high";
  };

  directory?: {
    treePath?: string;     // 后续 stage 可缓存受限 tree 摘要
    truncated?: boolean;
    entryCount?: number;
  };
}
```

### 3.2 落盘目录选型

推荐默认使用工作区内目录：

```text
<cwd>/.code-shell/attachments/
  .gitignore
  <sessionId>/
    manifest.jsonl
    <sha256-16>-<safe-original-name>.<ext>
    derived/
      <sha256-16>-vision.jpg
```

理由：

- 工作区内路径会被现有 pathPolicy 判定为 inside workspace，`Read`/`view_image` 可直接消费。
- 生成图片已有 `<cwd>/.code-shell/generated_images` 先例。
- 模型写 Markdown 时可引用 `.code-shell/attachments/<sessionId>/...` 这种 cwd-relative path。
- 项目 `.gitignore` 已经忽略 `.code-shell/` 的仓库能默认不入 git。

不推荐默认放到 `~/.code-shell/sessions/<sessionId>/attachments/`：

- 对 active workspace 来说它是工作区外路径，`Read`/`view_image` 会走审批或无交互拒绝。
- Markdown/文档引用绝对 path 可移植性差。
- `~/.code-shell` 是敏感目录，pathPolicy 会更保守。

### 3.3 命名、去重、manifest

- 写入前计算 sha256，文件名为 `<sha256前16位>-<safeSlug>.<ext>`。
- MIME 到扩展名映射以 main 侧白名单为准；扩展名不可信时用 MIME 推导。
- 同一 session 内同 hash 复用已有文件，只追加 manifest 事件，不重复写 bytes。
- 同一 workspace 可选建立 `.code-shell/attachments/blob/<sha256>.<ext>` content-addressed store，再从 session 目录写 manifest 引用。MVP 先不做硬链接，降低跨平台复杂度。
- `manifest.jsonl` 每行记录一次 stage/send/remove/cleanup 事件，便于清理和审计；不要记录 base64。
- `sourcePath` 只在用户明确从工作区/文件面板选择时记录；paste/clipboard 不记录来源。

### 3.4 清理策略

- draft 中移除附件时只从 UI 移除，不立即删文件，避免竞态；manifest 记 `removedFromDraft`。
- app 启动或 session 删除时执行 best-effort cleanup：
  - 未发送 draft 附件 TTL：24 小时。
  - 已发送附件默认保留 30 天或跟随 session 删除。
  - 可配置项后续放 settings，MVP 写常量。
- 清理只删除 `.code-shell/attachments` 下由 manifest 记录且 realpath 仍在 attachments root 内的文件。

### 3.5 gitignore / 隐私

- 创建 attachments root 时写入 `<cwd>/.code-shell/.gitignore`：

```gitignore
*
!.gitignore
```

- 不自动修改用户根 `.gitignore`，避免污染仓库；但 `.code-shell/.gitignore` 能让未忽略 `.code-shell` 的项目默认不提交附件内容。
- UI 可在发送前显示「附件将保存到工作区 .code-shell/attachments，不默认提交 git」。
- 日志只记录 id、mime、size、hash 前缀、relPath，不记录 data URL 或图片内容。

## 4. 分阶段串行实现计划

以下 stage 必须串行做。多个 stage 会触碰同一批文件，禁止并行改同文件。

### Stage 1：desktop main 附件落盘服务

改动文件：

- 新增 `packages/desktop/src/main/attachment-service.ts`
- 新增 `packages/desktop/src/main/attachment-service.test.ts`
- 修改 `packages/desktop/src/main/index.ts`
- 修改 `packages/desktop/src/preload/index.ts`
- 修改 `packages/desktop/src/preload/types.d.ts`

改什么：

- 实现 `stageImageDataUrl({ cwd, sessionId, name, mime, dataUrl, origin })`。
- main 侧校验 cwd/sessionId，创建 `<cwd>/.code-shell/attachments/<sessionId>/`。
- 解 data URL、计算 sha256、按 MIME/扩展名命名、原子写文件、写 manifest。
- 暴露 IPC `attachments:stageImageDataUrl`、`attachments:cleanup`。
- preload 暴露 `stageAttachmentImageDataUrl`，返回 `InputAttachmentMeta`。

对外契约变化：

- 新增 desktop preload API，不改 core `RunParams`。
- 无 StreamEvent 变化。
- 无工具 schema 变化。

TDD 测试点：

- `packages/desktop/src/main/attachment-service.test.ts`
  - png data URL 写到 `<cwd>/.code-shell/attachments/<sessionId>/...`。
  - 返回 relPath、absPath、mime、size、sha256、origin、sessionId。
  - 同 hash 同 session 复用文件。
  - sessionId 含 `/`、`..`、控制字符时拒绝。
  - data URL MIME 不在白名单时拒绝。
  - 写入 `.code-shell/.gitignore`，内容只忽略 `.code-shell` 内本地状态。

回归风险面：

- main IPC 不能阻塞 UI 太久，大图 hash/write 要异步。
- 不能把 data URL 打到日志。
- Windows 路径和中文文件名 safeSlug。

### Stage 2：composer 图片状态路径化，保持 legacy wire 兼容

改动文件：

- `packages/desktop/src/renderer/chat/attachments.ts`
- `packages/desktop/src/renderer/chat/attachments.test.ts`
- `packages/desktop/src/renderer/chat/compress.ts`（只在需要保留 staged metadata 时改）
- `packages/desktop/src/renderer/ChatView.tsx`
- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/preload/types.d.ts`

改什么：

- `ImageAttachment` 扩展 `path/relPath/absPath/sha256/origin/sessionId`。
- `acceptFiles` 在 `compressBatch` 后调用 Stage 1 preload API，把 paste/os-drop 图片先落盘，再 setAttachments。
- `buildPathAttachment` 对 file-panel 图片保留原文件 path，同时补 sha/size/path metadata；MVP 可选择不复制已有工作区图片。
- `encodeAttachmentsForWire` 在 `<codeshell-image>` 上增加 `path/hash/size/origin/sessionId` attrs，同时保留 data URL body，兼容旧 core。
- `decodeWireForDisplay` 忽略未知 attrs，继续显示缩略图。
- ChatView submit/guide/onQueueInput 继续发送字符串 payload。

对外契约变化：

- `<codeshell-image>` wire 增加可选 attrs：
  - `path=".code-shell/attachments/<sid>/..."`
  - `hash="sha256:..."`
  - `size="12345"`
  - `origin="paste|os-drop|file-panel"`
- core 旧 parser 会忽略这些 attrs，所以可先发版 desktop service + renderer。
- 无 `RunParams` 变化。

TDD 测试点：

- `packages/desktop/src/renderer/chat/attachments.test.ts`
  - encode 后包含 path/hash/size/origin，老 decode 仍能取出 image。
  - path attr 做 HTML attr escape，不能破坏 XML block。
  - no-path 老附件仍能 encode/decode。
- 建议补 `ChatView` 级测试或轻量 harness：
  - paste 接受图片后先 staging，再附件 chip 拥有 relPath。
  - staging 失败时回退到现有内存 data URL，并显示错误或阻止发送，由产品拍板。

回归风险面：

- 现有 title/history 依赖 `titleFromWire`，新增 attrs 不应让 base64 或 XML 泄漏到标题。
- 发送前 staging 失败时不能静默丢图。
- 忙碌时 guide 按钮也要携带同一批 path attrs。

### Stage 3：core 解析 path attrs，完善 `<attached-image-paths>`

改动文件：

- `packages/core/src/engine/parse-task.ts`
- `tests/parse-task.test.ts`
- `packages/core/src/engine/image-policy.ts`
- `packages/core/src/engine/image-policy.test.ts`
- `packages/core/src/engine/engine.ts`

改什么：

- `ParsedImage` 增加可选 `path/hash/size/origin/sessionId`。
- parser 读取 `<codeshell-image>` 可选 attrs，继续兼容只有 `mime/name` 的旧 block。
- `collectAttachedImagePaths` 优先用 `img.path`，其次兼容 `img.name`。
- path attr 必须按 cwd resolve 后仍存在；不存在时不进 `<attached-image-paths>`，但可在 text hint 中标注附件路径不可达。
- `Engine.run` 的 user text block 中把 relPath 作为主路径，必要时追加 absPath。

对外契约变化：

- legacy string task 支持新增 attrs。
- StreamEvent 无变化。
- 工具 schema 无变化。

TDD 测试点：

- `tests/parse-task.test.ts`
  - 解析 path/hash/size/origin。
  - 缺 attrs 的旧 `<codeshell-image>` 不变。
  - attr escape/unescape 正确。
- `packages/core/src/engine/image-policy.test.ts`
  - path attr 存在且文件存在时返回该 path。
  - path attr 不存在时回退 name。
  - 不存在的 path 被跳过。

回归风险面：

- parser 仍不能吞掉 malformed image block；失败应保持 `image_error`。
- path hint 不应引入不可控绝对路径泄漏，优先 cwd-relative。

### Stage 4：Read / view_image 对图片和二进制的工具体验收口

改动文件：

- `packages/core/src/tool-system/builtin/read.ts`
- `packages/core/src/tool-system/builtin/read.test.ts`
- `packages/core/src/tool-system/builtin/view-image.ts`
- `packages/core/src/tool-system/builtin/view-image.test.ts`
- `packages/core/src/tool-system/builtin/index.ts`（仅当 schema/description 变化）

改什么：

- `Read` 在读全文件前先 `stat` + 根据扩展名/MIME magic 检测图片和常见二进制。
- 对图片返回：
  - abs path / cwd-relative path
  - mime
  - size
  - sha256
  - 提示：`Use view_image({ path: "..." }) to inspect pixels.`
- 对未知二进制返回 path + size + hash，不按 UTF-8 输出乱码。
- `view_image` 复用 image policy 的大小策略。超过 5MB 时可生成 vision 缩略派生图，或继续提示用户压缩。推荐用同一套 `IMAGE_TARGETS`，派生图写到 `.code-shell/attachments/<sessionId>/derived/`。
- `view_image` 可增加可选参数 `detail?: "low" | "standard" | "high"`，默认沿用 ctx/runtime imageDetail。

对外契约变化：

- `Read` 返回文本格式变化：图片/二进制从乱码变成 metadata。
- `view_image` schema 可选增加 `detail`。
- StreamEvent 无变化。

TDD 测试点：

- `packages/core/src/tool-system/builtin/read.test.ts`
  - PNG 文件不返回二进制乱码，返回 mime/size/hash/view_image 提示。
  - UTF-8 文本行为不变，offset/limit 行为不变。
  - 大二进制只返回 metadata。
- `packages/core/src/tool-system/builtin/view-image.test.ts`
  - pathPolicy 仍由 executor 负责，直接工具测试聚焦格式/大小。
  - 非 vision ctx 仍不读文件。
  - 可选 thumbnail 策略不会超过 image policy 上限。

回归风险面：

- `Read` 计算 hash 会增加 IO 成本；只对图片/二进制做，文本不默认 hash。
- 不要让 `Read` 自动把图片塞进 vision 上下文，避免工具语义从 read text 变成昂贵 vision。

### Stage 5：结构化 `RunParams.attachments`，移除 base64-in-task 作为主路径

改动文件：

- `packages/core/src/protocol/types.ts`
- `packages/core/src/protocol/client.ts`
- `packages/core/src/protocol/server.ts`
- `packages/core/src/protocol/chat-session.ts`
- `packages/core/src/engine/engine.ts`
- 新增 `packages/core/src/engine/input-attachments.ts`
- `packages/desktop/src/preload/index.ts`
- `packages/desktop/src/preload/types.d.ts`
- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/renderer/ChatView.tsx`
- `packages/desktop/src/renderer/chat/attachments.ts`

改什么：

- `RunParams` 增加 `attachments?: InputAttachmentMeta[]`。
- `Engine.run` options 增加 attachments，并在 user message 装配前读取 image attachments 的 file bytes 生成 image ContentBlock。
- 图片 path hint 由 structured attachments 生成，不再依赖 `<codeshell-image>`。
- desktop `onSend` signature 从 `(text, opts)` 扩展为 `(text, optsWithAttachments)`，App.send 把 attachments 放进 `window.codeshell.run` opts。
- 保留 `<codeshell-image>` parser 作为 legacy fallback，直到 TUI/老版本桌面兼容窗口结束。

对外契约变化：

- `agent/run` params 新增可选 `attachments`。
- 无必需 StreamEvent 变化；可选新增 `input_attachment_received` 仅用于调试/UI，不建议 MVP 做。
- core API 兼容旧 task string。

TDD 测试点：

- `packages/core/src/protocol/server.*.test.ts`
  - `attachments` 被转发到 ChatSession/Engine。
  - 不传 attachments 的老测试不变。
- `packages/core/src/engine/input-attachments.test.ts`
  - image attachment path 读取为 image ContentBlock。
  - 非 image attachment 只生成 text metadata。
  - path 不存在或越权时返回清晰 error，不读文件。
- desktop renderer 测试：
  - send 调用 `window.codeshell.run(text, { attachments })`。
  - user bubble 不显示 base64。

回归风险面：

- 这是协议半径最大的一步，必须在 Stage 1 到 4 稳定后做。
- 需要保证 worker/main JSON serialization 不携带 base64 大字符串，减少 IPC 压力。

### Stage 6：`@file` / `@dir` / 最近附件 picker

改动文件：

- `packages/desktop/src/main/file-search-service.ts`
- 新增或修改 `packages/desktop/src/main/file-search-service.test.ts`
- `packages/desktop/src/main/index.ts`
- `packages/desktop/src/preload/index.ts`
- `packages/desktop/src/preload/types.d.ts`
- `packages/desktop/src/renderer/chat/MentionPopover.tsx`
- `packages/desktop/src/renderer/ChatView.tsx`
- `packages/desktop/src/renderer/chat/mention.ts`

改什么：

- `FileSearchHit` 改为 `{ path, name, kind: "file" | "dir", size?, mime? }`。
- file search 支持目录 hit，但限制数量和深度；仍尊重 `.gitignore`/ignore list。
- 新增 `attachments:listRecent(cwd, sessionId?)`，从 manifest 读最近附件。
- MentionPopover 增加 Files、Folders、Recent attachments 分组。
- 选择 `@file`/`@dir` 时不只是插入文本，也把 structured reference 加入 pending attachments/references。
- 目录引用生成受限 tree：默认最多 2 层、200 entries、显示截断标记。

对外契约变化：

- `files:search` 返回 shape 增加 `kind`。
- `RunParams.attachments` 开始承载 `kind:"directory"` 或 `kind:"file"` 的非图片引用。
- StreamEvent 无必需变化。

TDD 测试点：

- `packages/desktop/src/main/file-search-service.test.ts`
  - 返回文件和目录，目录 kind 正确。
  - `node_modules/.git/dist` 仍被忽略。
  - 最近附件按时间倒序，已清理文件不返回。
- renderer 级测试：
  - picking dir 生成 structured reference。
  - mention 插入的显示文本和 attachment meta 一致。

回归风险面：

- 文件搜索可能变慢；目录 hit 要有限额和 cache。
- UI 上不能把插件、文件、目录、附件混成不可分辨的列表。

### Stage 7：DriveAgent 附件转交

改动文件：

- `packages/core/src/tool-system/builtin/drive-claude-code.ts`
- `packages/core/src/tool-system/builtin/drive-claude-code.test.ts`
- `packages/core/src/cc-orchestrator/agent-adapter.ts`
- `packages/core/src/cc-orchestrator/agent-adapter.test.ts`
- `packages/core/src/cc-orchestrator/external-agent-driver.ts`
- `packages/core/src/cc-orchestrator/external-agent-driver.test.ts`

改什么：

- `DriveAgent` schema 增加 `attachmentPaths?: string[]` 或 `attachments?: InputAttachmentMeta[]`。
- 工具执行前 pathPolicy 对每个本地 path 做 read 校验。
- prompt 自动追加附件清单：

```text
Attached files:
- .code-shell/attachments/<sid>/x.png (image/png, 123KB, sha256:...)
```

- Codex adapter 可选支持 `imagePaths`，在 feature detection 通过时添加 `-i <path>`。不通过时只用 prompt path handoff。
- Claude adapter 先只用 prompt path handoff，除非后续确认 headless image 参数。

对外契约变化：

- `DriveAgent` 工具 schema 增加附件参数。
- Codex adapter `BuildArgsOpts` 增加 `imagePaths?: string[]`。
- StreamEvent 无变化。

TDD 测试点：

- `drive-claude-code.test.ts`
  - attachmentPaths 被加入 prompt。
  - 越权 path 被 pathPolicy 拦截。
  - background job 通知中不泄漏 base64。
- `agent-adapter.test.ts`
  - codex feature enabled 时 argv 包含 `-i path`。
  - feature disabled 时 argv 不包含 `-i`，prompt 仍含 path。
  - claude adapter 不传未知 image flag。

回归风险面：

- CLI 版本差异大，Codex `-i` 必须 feature detect 或配置开关。
- 背景任务默认 `bypassPermissions`，附件 path 校验要在 DriveAgent 工具自身完成，不能只依赖外部 CLI sandbox。

### Stage 8：清理、session 删除、文档与迁移

改动文件：

- `packages/desktop/src/main/attachment-service.ts`
- `packages/desktop/src/main/index.ts`
- session 删除相关服务文件（实现前用 `rg "sessions:delete"` 定位）
- docs/user-facing release note 或 help 文案

改什么：

- session delete 时清理对应 attachments session dir。
- app startup 清理过期 draft/sent 附件。
- 添加 `attachments:inspect` 调试 IPC，只返回 metadata，不返回内容。
- 文档说明 `.code-shell/attachments` 隐私和清理策略。

对外契约变化：

- 新增 best-effort cleanup 行为。
- 无 core protocol 必需变化。

TDD 测试点：

- cleanup 不会删除 attachments root 外文件，即使 manifest 被篡改。
- TTL 未到不删，TTL 到且 manifest 记录存在才删。
- session delete 只删目标 sessionId。

回归风险面：

- 清理代码必须 realpath 校验，避免 manifest path traversal。
- 删除 session 与正在发送中的 staging 有竞态，失败应 best-effort，不影响主流程。

## 5. 权限与路径安全

- 附件落盘必须由 desktop main 完成，renderer 只传 bytes/data URL 和 metadata。main 侧校验 cwd 是绝对路径且存在。
- stage 目标路径必须 realpath/safe-join 到 `<cwd>/.code-shell/attachments/<sessionId>/` 下。
- sessionId 使用与 core `assertSafeSessionId` 等价的 allowlist：字母、数字、`-_.`，拒绝 `/`、`\`、`..` 和过长 id。core 已有 sessionId 防路径逃逸实现，见 `packages/core/src/session/session-manager.ts:48` 到 `packages/core/src/session/session-manager.ts:84`。
- 对 paste/os-drop bytes，不使用用户提供的文件名决定最终路径，只作为 safeSlug；真实扩展由 MIME 白名单决定。
- 对 file-panel/picker 的已有文件，默认不复制时必须保留原 path，并让后续工具 pathPolicy 决定是否可读。
- 对复制到 `<cwd>/.code-shell/attachments` 的图片，项目 workspace 内读取应走现有 pathPolicy allow。
- no-repo 例外：desktop no-repo cwd 在 `~/.code-shell/no-repo`，而 pathPolicy 把 `~/.code-shell` 视为敏感目录。若附件落在 `~/.code-shell/no-repo/.code-shell/attachments`，`Read/view_image` 会被敏感读 ask 拦截。推荐 MVP 同时给 pathPolicy 增加一个很窄的 allow：当 `resolved` 位于 `noRepoDir()/.code-shell/attachments` 且 operation 为 read 时允许；写入仍由 desktop main staging 服务处理，不授予通用工具写权限。
- `.code-shell/.gitignore` 要自动写入，但不自动改根 `.gitignore`。
- DriveAgent 的附件 path 要在 CodeShell 内先过 pathPolicy，再交给外部 CLI。不要依赖 Codex/Claude 自己的 sandbox 来判断能不能读。

## 6. Token 成本与大图策略

现有基础：

- desktop renderer 已有 browser-native 压缩，目标是避免超过 engine 2MB 单图上限，见 `packages/desktop/src/renderer/chat/compress.ts:1` 到 `packages/desktop/src/renderer/chat/compress.ts:30`。
- renderer `TARGET_BYTES` 是 2MB，`MAX_DIMENSION` 是 2048，并且 low/standard/high 会调整最长边，见 `packages/desktop/src/renderer/chat/compress.ts:41` 到 `packages/desktop/src/renderer/chat/compress.ts:86`。
- engine hard limit 是单图 2MB、每轮 6MB、最多 6 张，见 `packages/core/src/engine/image-policy.ts:42` 到 `packages/core/src/engine/image-policy.ts:62`。
- engine compression fallback 会尝试 longest edge downscale + JPEG re-encode，见 `packages/core/src/engine/image-compression.ts:1` 到 `packages/core/src/engine/image-compression.ts:30`、`packages/core/src/engine/image-compression.ts:146` 到 `packages/core/src/engine/image-compression.ts:190`。

推荐策略：

- 原图永远保存一份，用于文件引用、文档、DriveAgent path handoff。
- vision 输入默认使用发送时已压缩后的 bytes；如果原始落盘文件大于 image policy，则生成 `derived/<sha>-vision.jpg` 并让 `vision.mediaPath` 指向派生图。
- low/standard/high 复用现有 `compress.ts` cap：low 1024、standard 1568、high 2576。
- `RunParams.attachments` 进入 core 后，core 不信任 metadata size，必须 stat 实际文件。
- 每轮 image part 仍执行 `IMAGE_LIMITS`，超过 count/total 时返回明确 `image_error` 或降级为 path-only，由 MVP 拍板。
- `Read` 不自动 vision，避免一次普通文件读取触发昂贵图片 token。
- 对 `@dir`，默认只给 tree，不内联文件内容；对大文件、二进制、未知类型只给 path/size/hash。

## 7. 需卡密sama拍板的决策点

1. MVP 是否严格限定图片：推荐是。通用 `@file/@dir` 和二进制附件放 Stage 6。
2. 粘贴/OS drop 图片 staging 失败时怎么办：推荐阻止发送并显示错误；备选是回退到旧 data URL 内联，但会继续没有 path。
3. 落盘目录是否采用 `<cwd>/.code-shell/attachments/<sessionId>/`：推荐是。备选 `~/.code-shell/sessions/<id>/attachments` 会触发 pathPolicy 和可移植性问题。
4. no-repo cwd 附件读取是否给 pathPolicy 加窄 allow：推荐给 `~/.code-shell/no-repo/.code-shell/attachments` read-only allow，否则 no-repo 图片 path 对主 agent 不好用。
5. 是否自动写 `<cwd>/.code-shell/.gitignore`：推荐写，且不改根 `.gitignore`。
6. Stage 2 是否先保留 legacy `<codeshell-image>`，Stage 5 再上结构化 `RunParams.attachments`：推荐这样分两步，降低协议半径。
7. DriveAgent 对 Codex 是否自动传 `-i/--image`：推荐先 path-only，后续 feature detection 通过再启用 `-i`。Claude Code 暂不传未知 image flag。
8. 清理 TTL：推荐 draft 24 小时，sent 30 天，session delete 立即清理；需要确认是否有长期保留需求。
9. `Read` 对 SVG 怎么处理：推荐视为文本/XML，提示可转 PNG 后 `view_image`；不要把 SVG 当 raster image 直接 vision。
10. 目录引用 MVP 是否给 tree：推荐 Stage 6 给受限 tree；图片 MVP 不做。

## 8. 自检

- 现状锚点均来自本次 `nl -ba`/`rg` 只读核查，文中 file:line 均指向现有文件。
- 本方案当前只写本文档，不修改 `packages/` 源码、测试或配置。
- Stage 1 到 Stage 8 是串行顺序；涉及同一文件的后续 stage 必须等待前一 stage 完成并测试通过后再改，不能并行拆给多个 agent。
- MVP 边界清晰：图片落盘路径化 + path hint + vision image part + Read/view_image 收口；`@dir`、通用二进制、Codex `-i` 直传属于后续。
