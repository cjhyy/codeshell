# CodeShell `view_image` vs Codex CLI 审查报告

> 日期：2026-07-10
> 范围：只读审查；未修改任何源码
> CodeShell 基准：当前工作树
> Codex 基准：OpenAI `openai/codex` 固定提交
> [`1f0566d3f59298d1bb88820a0d35294f1eeb07ea`](https://github.com/openai/codex/commit/1f0566d3f59298d1bb88820a0d35294f1eeb07ea)

## 结论摘要

CodeShell 的主路径已经打通：`view_image` 产出的内部 `image` block 被放进
`tool_result.content`，下一轮保留一次，OpenAI-compatible provider 再把图片提升为独立的
`user.image_url` part；模型成功消费后，工作历史中的 base64 会被编号占位符替换。
对应实现锚点为 `packages/core/src/tool-system/builtin/view-image.ts:125-137`、
`packages/core/src/engine/turn-loop.ts:183-193`、
`packages/core/src/engine/turn-loop.ts:1076-1129`、
`packages/core/src/llm/providers/openai.ts:851-940` 和
`packages/core/src/engine/turn-loop.ts:388-415`。

审查发现 **2 个明确的正确性 bug、3 个中高风险健壮性问题，以及若干 Codex 对齐缺口**：

1. **P1 bug：历史图片编号在 compaction 后会错位。** 工作消息的编号从当前切片重新计算，
   但 `viewHistoricalImage()` 去完整 transcript 中按同一数字查找；一旦 compaction 删除了所有更早
   的图片占位符，新图片会在工作历史中重新成为 `#1`，而完整 transcript 的 `#1` 仍是旧图片。
   编号算法见 `packages/core/src/context/compaction.ts:52-88`，窗口裁剪见
   `packages/core/src/context/compaction.ts:343-356`，完整 transcript 查找见
   `packages/core/src/tool-system/builtin/view-image.ts:154-170`。
2. **P2 bug：vision gate 与 OpenAI provider 的 provider-kind 回退不一致。** 工具使用
   `providerKind ?? provider`，provider 使用 `providerKind ?? "openai"`；缺 `providerKind` 的旧配置
   可以先通过工具 gate、读图并生成 base64，随后又被 provider strip。
   对应锚点为 `packages/core/src/tool-system/builtin/view-image.ts:140-144` 和
   `packages/core/src/llm/providers/openai.ts:230-244`。
3. **P1 健壮性：5 MB gate 不是有界、原子的读取。** `stat()` 与 `readFile()` 分离，未检查
   `isFile()`，也未把 `ctx.signal` 传给文件读取；文件/符号链接可在两步间被替换，FIFO/设备文件也
   会先通过 `size` 检查。对应锚点为 `packages/core/src/tool-system/builtin/view-image.ts:113-130`。
4. **P1 健壮性：没有每轮累计图片预算。** 每张图可达 5 MiB，工具又标记为并发安全；多次调用
   会把全部结果聚合到下一请求。仓库已经有 2 MiB/张、6 MiB/轮、6 张/轮的统一图片策略，但
   `view_image` 没有复用它。对应锚点为 `packages/core/src/tool-system/builtin/index.ts:241-250`、
   `packages/core/src/engine/turn-loop.ts:1076-1129` 和
   `packages/core/src/engine/image-policy.ts:43-62`。
5. **Codex 行为对齐缺口：`detail` 是 no-op，且枚举相反。** CodeShell 接受
   `low|standard|high`、拒绝 `original`，但参数不进入 content block/provider；Codex 当前实现的工具
   参数是 `high|original`，默认 high，`original` 会实际改变解码/缩放上限。
   CodeShell 锚点为 `packages/core/src/tool-system/builtin/view-image.ts:54-59`、
   `packages/core/src/tool-system/builtin/view-image.ts:76-79` 和
   `packages/core/src/llm/providers/openai.ts:868-875`；Codex 锚点为
   [`codex-rs/core/src/tools/handlers/view_image_spec.rs:15-49`][codex-spec]、
   [`codex-rs/core/src/tools/handlers/view_image.rs:118-134`][codex-detail-parse] 和
   [`codex-rs/core/src/tools/handlers/view_image.rs:179-201`][codex-detail-apply]。

未发现“正常、完整 runtime 配置下，非 vision 模型仍必然读本地图片”的问题：工具 gate 在读文件前
返回文本，provider 的 strip 是模型切换/旧历史的第二层防线。
对应锚点为 `packages/core/src/tool-system/builtin/view-image.ts:98-104` 和
`packages/core/src/llm/strip-vision.ts:13-18`。但上面的 provider-kind 回退不一致构成一个可达例外。

## 审查方法与证据边界

- Codex 参照不是凭记忆推断，而是固定到上面的公开源码提交。其工具 schema 只要求 `path`，按能力
  可增加 `detail`，多环境场景可增加 `environment_id`；没有 `imageNumber`。
  证据见 [`codex-rs/core/src/tools/handlers/view_image_spec.rs:15-49`][codex-spec]。
- Codex handler 会检查模型的 `InputModality::Image`，读取受 sandbox 约束的文件，并把结果作为
  function-call output 的 `InputImage` content item 返回。
  证据见 [`codex-rs/core/src/tools/handlers/view_image.rs:84-98`][codex-vision-gate]、
  [`codex-rs/core/src/tools/handlers/view_image.rs:136-177`][codex-read] 和
  [`codex-rs/core/src/tools/handlers/view_image.rs:207-235`][codex-output]。
- Codex 的统一 history-insertion 准备路径会解码真实字节、按 detail 限制尺寸/patch 数并重编码；
  high 上限为 2048 维/2500 patches，original 上限为 6000 维/10000 patches。
  证据见 [`codex-rs/core/src/image_preparation.rs:19-26`][codex-prep-limits] 和
  [`codex-rs/core/src/image_preparation.rs:91-135`][codex-prep-flow]。
- 本地执行了用户点名的 7 个测试文件，共 38 个 case，结果 38 pass / 0 fail。现有测试覆盖单文件、
  fail-closed、简单 resume 编号、OpenAI data URL 正常转换、一次消费后降级及 OpenAI hoist；对应
  测试锚点为 `packages/core/src/tool-system/builtin/view-image.test.ts:27-116`、
  `packages/core/src/tool-system/builtin/view-image-by-number.test.ts:117-230`、
  `packages/core/src/engine/turn-loop-image-history.test.ts:148-193` 和
  `packages/core/src/llm/providers/openai-tool-result-image.test.ts:50-91`。
- 另用当前纯函数复现了 compaction 错位：完整 transcript 为“旧图、后续新图”，
  `windowCompact(..., 1)` 后新图被工作历史编号为 `#1`，但
  `findImageByNumber(fullTranscript, 1)` 返回旧图。该结果直接来自
  `packages/core/src/context/compaction.ts:52-88` 与
  `packages/core/src/context/compaction.ts:343-356` 的现实现。

## A. 与 Codex 原生 `view_image` 的设计差异

| 维度 | Codex CLI 固定基准 | CodeShell 当前实现 | 判断 |
|---|---|---|---|
| 参数主形状 | `path` 必填；按模型能力可出现 `detail`，多环境可出现 `environment_id`；object 禁止额外字段。`codex-rs/core/src/tools/handlers/view_image_spec.rs:15-49`。[源码][codex-spec] | schema 把 `path`、`imageNumber`、`detail` 都声明为可选，运行时再强制 `path`/`imageNumber` 恰好一个。`packages/core/src/tool-system/builtin/view-image.ts:34-74` | `imageNumber` 是增强；缺少 schema 级 `oneOf`/`required` 是偏离。 |
| 本地路径 | 相对所选 environment cwd 解析，并通过 environment filesystem + sandbox 读取。`codex-rs/core/src/tools/handlers/view_image.rs:136-177`。[源码][codex-read] | 相对 `ctx.cwd` 解析；正常 ToolExecutor 先执行声明式 read path policy。`packages/core/src/tool-system/builtin/view-image.ts:92-96`、`packages/core/src/tool-system/builtin/index.ts:241-250`、`packages/core/src/tool-system/executor.ts:321-333` | CodeShell 的工作区/敏感路径审批是有价值的 harness 集成；Codex 还有 CodeShell 没有的 `environment_id`。 |
| detail | 工具只接受 `high|original`；缺省为 high。只有模型允许 original 时才在 schema 中暴露，original 会真实改变图片准备策略。`codex-rs/core/src/tools/handlers/view_image_spec.rs:20-29`、`codex-rs/core/src/tools/handlers/view_image.rs:123-134,179-186`。[schema][codex-spec] [解析][codex-detail-parse] [应用][codex-detail-apply] | 接受 `low|standard|high`，拒绝 `original`；值只被校验，后续未使用。provider 读取全局 `this.imageDetail`。`packages/core/src/tool-system/builtin/view-image.ts:54-59,76-79`、`packages/core/src/llm/providers/openai.ts:868-875,1149-1155` | 明确偏离；当前参数是兼容性 no-op，不是逐调用画质控制。 |
| 输出进入模型 | 返回 Responses-style function-call output content item `InputImage`，携带 data URL 和 detail。`codex-rs/core/src/tools/handlers/view_image.rs:207-235`。[源码][codex-output] | 返回内部 `{contentBlocks:[{type:"image",source:{base64,...}}]}`；TurnLoop 把它嵌入 `tool_result`。OpenAI Chat Completions 不接受 tool message 图片，因此 provider 再提升成单独 user `image_url` part。`packages/core/src/tool-system/builtin/view-image.ts:132-137`、`packages/core/src/engine/turn-loop.ts:183-193`、`packages/core/src/llm/providers/openai.ts:851-940` | 属于 provider 协议适配，不是功能错误；但链路更长，需保持 capability/detail/size 元数据一致。 |
| 真实格式处理 | handler 先用 octet-stream data URL 承载原字节；统一准备路径再从字节猜格式、解码、按需缩放/重编码。`codex-rs/core/src/tools/handlers/view_image.rs:188-201`、`codex-rs/utils/image/src/lib.rs:103-185`。[handler][codex-detail-apply] [解码][codex-sniff] | 仅按扩展名映射 MIME，随后原样 base64；不 sniff、不解码、不检查像素尺寸。`packages/core/src/tool-system/builtin/view-image.ts:24-32,106-137` | CodeShell 的错误扩展名/动画/损坏文件会更晚在 provider 失败；是缺失。 |
| 大小策略 | 当前 Codex 的数据 URL 准备有 1 GiB 高位 sanity cap，但 handler 在此之前已经读完整文件并 base64；正常 high 路径还会按 2048/patch budget 缩放。`codex-rs/core/src/tools/handlers/view_image.rs:156-200`、`codex-rs/utils/image/src/lib.rs:27-32,215-261`、`codex-rs/core/src/image_preparation.rs:19-26,127-134`。[读入][codex-read] [cap][codex-data-url] [上限][codex-prep-limits] [缩放][codex-prep-flow] | 在读全文件前用 `stat` 做 5 MiB 单图上限，但不缩放、不做累计预算。`packages/core/src/tool-system/builtin/view-image.ts:24,113-137` | 5 MiB pre-read cap 是 CodeShell 的额外防护；实现方式仍有竞态，且与仓库统一 2/6/6 策略不一致。 |
| 历史图引用 | 原生 `view_image` schema 没有历史编号，只接受磁盘路径；已经在对话中的图片由普通 input/history image item 承载。`codex-rs/core/src/tools/handlers/view_image_spec.rs:15-49`。[源码][codex-spec] | `imageNumber` 可从当前 session transcript 中重新取回原 base64。`packages/core/src/tool-system/builtin/view-image.ts:37-53,81-90,146-185` | CodeShell 特有增强，不是 Codex parity 要求；目前的动态序号设计不稳定。 |
| vision gate | 根据 turn 的模型 input modalities 拒绝无图片输入能力的模型。`codex-rs/core/src/tools/handlers/view_image.rs:84-98`。[源码][codex-vision-gate] | 通过 capability 表判断；缺 `llmConfig` 时 fail-closed。`packages/core/src/tool-system/builtin/view-image.ts:98-104,140-144` | 安全方向与 Codex 一致；缺配置 fail-closed 是合理增强。 |
| 注册/可见性 | handler 自身始终再次做 modality gate。`codex-rs/core/src/tools/handlers/view_image.rs:84-98`。[源码][codex-vision-gate] | builtin 条目本身无 vision visibility guard；只要 preset 选择到它就注册，标记为 read-only、concurrency-safe。`packages/core/src/tool-system/builtin/index.ts:241-250`、`packages/core/src/tool-system/registry.ts:35-57` | 不影响安全 gate，但非 vision 模型会看到一个只能返回占位文本的工具，增加 schema token 和误调用机会。 |

### A.1 CodeShell 的额外增强

1. `imageNumber` + transcript 取回是原生 Codex schema 没有的能力。
   `packages/core/src/tool-system/builtin/view-image.ts:37-53,146-185`；Codex 对照见
   [`codex-rs/core/src/tools/handlers/view_image_spec.rs:15-49`][codex-spec]。
2. 缺 `llmConfig` 时按非 vision 处理，且在读文件/读 session 历史之前返回。
   `packages/core/src/tool-system/builtin/view-image.ts:98-104,140-151`。
3. 本地路径在正常执行链经过敏感路径/工作区外审批，分类时会 best-effort realpath 符号链接。
   `packages/core/src/tool-system/builtin/index.ts:241-250`、
   `packages/core/src/tool-system/executor.ts:565-617`、
   `packages/core/src/tool-system/path-policy.ts:375-409,466-551`。
4. 5 MiB 单图门在常规文件的 `readFile()` 前发生，比 Codex 当前 1 GiB 的后续 sanity cap 更早拒绝
   大文件。`packages/core/src/tool-system/builtin/view-image.ts:113-123`；Codex 对照见
   [`codex-rs/utils/image/src/lib.rs:215-261`][codex-data-url]。
5. 图片只在下一次模型调用保留一次，成功消费后降级为带编号文本，减少重复 base64 请求。
   `packages/core/src/engine/turn-loop.ts:388-415,680-684,810-810` 和
   `packages/core/src/context/compaction.ts:90-170`。

### A.2 缺失或偏离

1. `detail` 没有逐调用语义，枚举也未对齐 Codex 的 `high|original`。
   `packages/core/src/tool-system/builtin/view-image.ts:54-59,76-79`；Codex 对照见
   [`codex-rs/core/src/tools/handlers/view_image.rs:123-134`][codex-detail-parse] 和
   [`codex-rs/core/src/tools/handlers/view_image.rs:179-186`][codex-detail-apply]。
2. 没有 Codex 的真实字节 sniff/decode/resize/re-encode 链路。
   `packages/core/src/tool-system/builtin/view-image.ts:106-137`；Codex 对照见
   [`codex-rs/utils/image/src/lib.rs:103-185`][codex-sniff]。
3. 没有 Codex 多 environment 的 `environment_id` 参数与 environment filesystem 路由。
   CodeShell schema 见 `packages/core/src/tool-system/builtin/view-image.ts:42-60`；Codex schema/解析见
   [`codex-rs/core/src/tools/handlers/view_image_spec.rs:31-39`][codex-spec] 和
   [`codex-rs/core/src/tools/handlers/view_image.rs:136-154`][codex-read]。
4. CodeShell 的 exactly-one 约束只在 handler 中，schema 没有 `oneOf`，`imageNumber` 也没有
   `integer/minimum:1`；仓库的轻量 validator 又不处理 enum/oneOf。
   `packages/core/src/tool-system/builtin/view-image.ts:42-61,68-89`、
   `packages/core/src/tool-system/validation.ts:1-9,16-58`。
5. Codex 输出保留 per-image detail，CodeShell `ContentBlock.source` 只有
   `{type,media_type,data}`，无法携带逐图片 detail。
   `packages/core/src/types.ts:9-27`；Codex 输出见
   [`codex-rs/core/src/tools/handlers/view_image.rs:221-235`][codex-output]。

## B. 三道闸门审查

### B.1 Vision gate

**判断：默认 fail-closed 合理，正常路径有效；存在 capability 来源漂移的例外。**

- 工具在任何文件 I/O 和 session resume 之前调用 `supportsVision()`；缺 `ctx.llmConfig` 直接 false。
  `packages/core/src/tool-system/builtin/view-image.ts:81-104,140-151`。
- capability 的未知模型默认 `supportsVision:false`，所以错误/新模型元数据不会默认泄露图片。
  `packages/core/src/llm/capabilities/index.ts:35-55`、
  `packages/core/src/llm/capabilities/types.ts:137-150`。
- 现有测试验证了 non-vision 和缺 `llmConfig` 均只返回文本，不回图片 block。
  `packages/core/src/tool-system/builtin/view-image.test.ts:38-54` 和
  `packages/core/src/tool-system/builtin/view-image-by-number.test.ts:177-189`。
- 例外是回退不一致：工具按 `providerKind ?? provider`，OpenAI client 按
  `providerKind ?? "openai"`。代码还明确承认 legacy config 不总有 providerKind。
  `packages/core/src/tool-system/builtin/view-image.ts:140-144`、
  `packages/core/src/llm/providers/openai.ts:230-244`。例如缺 providerKind 的
  `{provider:"openrouter", model:"anthropic/claude-sonnet-4"}` 在 OpenRouter 规则中是 vision，
  但按 OpenAI kind 无匹配会落到 non-vision default。
  `packages/core/src/llm/capabilities/rules.ts:193-219`、
  `packages/core/src/llm/capabilities/types.ts:137-150`。

### B.2 格式白名单

**判断：作为用户提示很清晰，但按扩展名而非内容判断，不足以充当安全/兼容 gate。**

- 白名单只查看 `extname(abs).toLowerCase()`，然后把扩展名直接映射成 MIME；文件内容没有 magic
  sniff 或解码验证。`packages/core/src/tool-system/builtin/view-image.ts:26-32,106-110,125-136`。
- 因而文本/损坏文件命名为 `.png` 会以 `image/png` 发送，真实 PNG 若没有扩展名或扩展名错误则
  被拒绝。这是上述扩展名映射与原样 `readFile`/base64 流程的直接结果。
  `packages/core/src/tool-system/builtin/view-image.ts:106-110,125-136`。
- `.gif` 原字节会被直接转发，未区分静态/动画 GIF。Codex 的统一图片库明确只原样保留
  PNG/JPEG/WebP，并注明公开接口只支持 non-animated GIF；GIF 会走解码/重编码路径。
  CodeShell 证据为 `packages/core/src/tool-system/builtin/view-image.ts:26-32,132-136`；Codex 对照见
  [`codex-rs/utils/image/src/lib.rs:310-317`][codex-preserve-formats]。
- 历史图路径没有复用本地文件的四格式白名单；任意 `image/*` data URL 都可能被转换并重新发送。
  `packages/core/src/tool-system/builtin/view-image.ts:173-184,216-223`。
- Codex 的参考实现从字节 `guess_format` 并实际 decode；无法处理的图片在统一准备层变成文本
  placeholder，而不是把伪 MIME 交给 provider。
  [`codex-rs/utils/image/src/lib.rs:103-132`][codex-sniff]、
  [`codex-rs/core/src/image_preparation.rs:91-101`][codex-prep-flow]。

### B.3 5 MB 大小门

**判断：阈值方向合理，但当前实现不能保证“实际最多读 5 MB”，也不能保证“下一请求图片总量可控”。**

优点：

- 对普通、稳定的常规文件，先 `stat` 后比较 5 MiB，再 `readFile`，避免明显超大文件进入 base64。
  `packages/core/src/tool-system/builtin/view-image.ts:113-130`。
- 历史 base64 也按解码后字节数做同一 5 MiB 检查。
  `packages/core/src/tool-system/builtin/view-image.ts:173-177,196-206`。

边界与漏洞：

1. **TOCTOU / 符号链接替换。** 正常 path policy 会 best-effort realpath，能挡住检查时已经指向
   工作区外/敏感目录的 symlink；路径穿越也会在 resolve/realpath 后被判定为工作区外并要求审批。
   `packages/core/src/tool-system/executor.ts:584-617`、
   `packages/core/src/tool-system/path-policy.ts:375-415,466-551`。但 policy 在 handler 前执行，
   handler 随后又对原始绝对路径分别 `stat` 和 `readFile`；两者之间没有 descriptor 绑定，故检查后
   替换文件或 symlink 的竞态仍存在。这是
   `packages/core/src/tool-system/executor.ts:321-333` 与
   `packages/core/src/tool-system/builtin/view-image.ts:113-130` 的调用顺序推论。
2. **非普通文件。** 代码只读 `stat().size`，没有 `Stats.isFile()`；FIFO/设备/目录等特殊节点可先
   通过 size 判断，再进入 `readFile`。Codex 参考 handler 显式检查 `metadata.is_file`。
   CodeShell 证据为 `packages/core/src/tool-system/builtin/view-image.ts:113-130`；Codex 对照见
   [`codex-rs/core/src/tools/handlers/view_image.rs:156-169`][codex-read]。
3. **超时不取消底层读。** registry 给工具注入 child signal 并用 `Promise.race` 做超时，但
   `viewImageTool` 没把 `ctx.signal` 传给 `readFile`；race 返回后底层读取仍无协作取消点。
   `packages/core/src/tool-system/registry.ts:121-153`、
   `packages/core/src/tool-system/builtin/view-image.ts:64-67,125-130`。
4. **base64 膨胀。** 允许的 5 MiB 原文件会生成约 6.67 MiB base64 字符串；同一时刻还保留
   `Buffer` 与 base64 string，之后 contentBlocks 又被放进工作消息和 transcript。
   `packages/core/src/tool-system/builtin/view-image.ts:120-136`、
   `packages/core/src/engine/turn-loop.ts:1076-1129`、
   `packages/core/src/session/transcript.ts:89-102`。
5. **无每轮累计门。** `view_image` 标记并发安全，多调用结果被同批聚合；没有把这些工具结果送入
   `enforceImageBytePolicy()`。两张接近上限的图就已超过仓库对普通附件规定的 6 MiB/轮预算。
   `packages/core/src/tool-system/builtin/index.ts:241-250`、
   `packages/core/src/engine/turn-loop.ts:1069-1129`、
   `packages/core/src/engine/image-policy.ts:58-62,197-251`。
6. **像素尺寸/解压炸弹不受控。** CodeShell 本地不解码，所以压缩字节不超过 5 MiB 的超大维度图片
   不会在本地形成像素 buffer，但仍会未经维度检查地交给远端 provider；本地主要 OOM 风险来自
   TOCTOU 后的大文件读取和多并发 Buffer/base64 聚合，而不是当前函数内的像素解码。
   `packages/core/src/tool-system/builtin/view-image.ts:113-136`。Codex 对照会解码并按维度/patch budget
   缩放，见 [`codex-rs/core/src/image_preparation.rs:19-26`][codex-prep-limits]、
   [`codex-rs/core/src/image_preparation.rs:116-134`][codex-prep-flow]、
   [`codex-rs/utils/image/src/lib.rs:134-185`][codex-sniff] 和
   [`codex-rs/utils/image/src/lib.rs:264-308`][codex-dimensions]。

## C. 历史图取回与编号稳定性

### C.1 当前编号语义

`collectBase64Images()` 的编号是“**当前传入 Message[] 中，按消息顺序、block 顺序、递归进入
`tool_result.content` 后的图片出现序号**”，不是持久 image identity。它从 1 开始；遇到合法占位符
会把 next number 至少推进到 `placeholder+1`。
`packages/core/src/context/compaction.ts:52-80,187-215`。

`downgradeImagePayloadsInHistory()` 先用同一个 collector 给 block 建号码队列，再以相同递归顺序把
图片替换为占位符，所以在 **同一、未裁剪的 Message[]** 内，collector、downgrade 和 find 的语义
是一致的。`packages/core/src/context/compaction.ts:99-170`。现有测试验证的也正是这个条件：完整
fixture/resume history 上 `#1/#2/#3` 一致。
`packages/core/src/tool-system/builtin/view-image-by-number.test.ts:117-135,216-230`。

### C.2 compaction 后会错位：明确 bug

TurnLoop 在每轮 model call 前先把已消费图片降级，然后调用 context manager；context manager 可做
window/snip/summary 等裁剪。`packages/core/src/engine/turn-loop.ts:680-704`。窗口策略明确可能只保留首
消息和尾部 N 条，删除中间的旧图片占位符。
`packages/core/src/context/compaction.ts:343-356`。

此后新 `view_image` 结果才被追加到工作 messages 并标为 fresh。
`packages/core/src/engine/turn-loop.ts:1076-1129`。下一轮 collector 若已看不到任何旧占位符，就会从
1 给新图编号。`packages/core/src/context/compaction.ts:52-66`。

但 `viewHistoricalImage(#N)` 不查这份 compacted working messages；它重新
`resume(sessionId).transcript.toMessages()`，在完整 transcript 中从头编号。
`packages/core/src/tool-system/builtin/view-image.ts:154-170`。图片 contentBlocks 会原样写入 transcript，
`toMessages()` 也会从事件重建它们。
`packages/core/src/engine/turn-loop.ts:1086-1092`、
`packages/core/src/session/transcript.ts:89-102,149-212`。

因此可出现：

```text
完整 transcript:  old image (#1) ... fresh image (#2)
compacted working: first text ... fresh image -> 被降级成占位符 #1
模型调用 view_image({imageNumber: 1})
实际从完整 transcript 返回 old image
```

这不是理论上的 placeholder 文案问题，而是 lookup 数据源不同造成的身份错配；相关代码锚点为
`packages/core/src/context/compaction.ts:52-88`、
`packages/core/src/context/compaction.ts:343-356` 和
`packages/core/src/tool-system/builtin/view-image.ts:160-170`。

### C.3 重取会产生新的出现序号

历史图取回成功后，原 block 被作为新的 tool result 再写入 transcript；collector 按出现次数而不是
内容 hash/identity 编号，所以同一像素会获得新的别名序号。旧号码仍然可用，但重复取回会持续增加
图片出现数和 transcript base64 体积。
`packages/core/src/tool-system/builtin/view-image.ts:173-185`、
`packages/core/src/engine/turn-loop.ts:1086-1092`、
`packages/core/src/context/compaction.ts:52-66`。这是当前 occurrence-based 设计的稳定结果，不是
上面“返回错误图片”的 bug，但会让 `imageNumber` 越来越不像图片 identity。

### C.4 `openAIDataUrlImageSource` 兼容性

对标准、非空、无额外 MIME 参数的
`data:image/jpeg;base64,<payload>`，转换是正确的：提取 MIME/data，并返回内部
`{type:"image",source:{type:"base64",...}}`。实现见
`packages/core/src/tool-system/builtin/view-image.ts:188-223`，正向测试见
`packages/core/src/tool-system/builtin/view-image-by-number.test.ts:148-162`。

但 collector 与 converter 的接受条件不一致：

- collector 只要求 URL 匹配 `^data:image/...;base64,` 前缀，逗号后可以为空；
  `packages/core/src/context/compaction.ts:207-215`。
- converter 要求 `(.+)` 非空，且 MIME 中不允许 `;` 参数；失败时
  `normalizeImageBlockForReturn()` 会把原始、类型系统不支持的 `image_url` block 原样返回。
  `packages/core/src/tool-system/builtin/view-image.ts:188-193,216-223`。
- OpenAI provider 处理 nested tool-result 时只识别内部 `inner.type === "image"`；未转换的
  `image_url` 会被忽略，tool message 却仍得到 `[image returned to user message]` 文本。
  `packages/core/src/llm/providers/openai.ts:858-881`。

所以对空 payload、带 MIME 参数、换行等 collector 接受而 converter 不接受的 data URL，
`view_image(imageNumber)` 可能返回“已取回”但下一轮没有实际图片。这是明确的兼容 bug；标准 data URL
路径本身没有问题。对应锚点为上述三组代码。

## D. 非 vision 模型的降级与 `strip-vision.ts`

### D.1 正常路径一致

1. 新调用：`viewImageTool` 在文件/session I/O 前 gate，non-vision 只返回文本，因此不会产生 image
   block。`packages/core/src/tool-system/builtin/view-image.ts:81-104,146-152`。
2. 历史/模型切换：OpenAI provider 在序列化前调用
   `stripVisionFromHistory(messages, supportsVision)`，只改 outgoing copy，不改 transcript。
   `packages/core/src/llm/providers/openai.ts:732-745`、
   `packages/core/src/llm/strip-vision.ts:13-18,36-77`。
3. `view_image` 的内部图片位于 nested `tool_result.content`；strip 实现显式递归处理这一层并换成
   `VISION_PLACEHOLDER`。`packages/core/src/llm/strip-vision.ts:45-69,79-106`。对应测试见
   `packages/core/src/llm/strip-vision.test.ts:83-109`。

因此在 `ToolContext.llmConfig` 与 provider client 使用同一 `(providerKind, model)` 时，不存在“工具明知
non-vision 仍读图，然后 provider 正常再 strip”的矛盾；provider strip 是切模/旧历史的防御层。

### D.2 可出现浪费的例外

当 `providerKind` 缺失且 `provider` 不是字面 `openai` 时，两处回退规则不同：工具可能按真实 provider
判定 vision，OpenAI client 却按 openai kind 判定 non-vision。
`packages/core/src/tool-system/builtin/view-image.ts:140-144`、
`packages/core/src/llm/providers/openai.ts:230-244`。

在该例外中，工具会读文件、base64、写 transcript；provider 随后 strip；TurnLoop 又会在模型调用
成功后把 pending image 标成“已消费”并降级。这会形成“模型没看到图，但工作历史说 already
provided”的二次语义错误。
`packages/core/src/tool-system/builtin/view-image.ts:113-137`、
`packages/core/src/llm/providers/openai.ts:739-745`、
`packages/core/src/engine/turn-loop.ts:388-415,810-810`。

另一个较低风险的不一致是：`stripVisionFromHistory()` 只识别内部 `type:"image"`，而
`collectBase64Images()` 还兼容强制 cast 的 OpenAI `type:"image_url"`。普通 `view_image` 输出始终是
内部 image，所以主路径无影响；但 legacy/外部构造的 OpenAI-style history 不享有相同 strip 语义。
`packages/core/src/llm/strip-vision.ts:54-68,81-106`、
`packages/core/src/context/compaction.ts:197-215`。

### D.3 无条件注册的影响

`view_image` builtin 没有 vision guard，注册条目只声明 allow/read-only/concurrency-safe/path read；
registry 对所选 builtins 逐个注册。
`packages/core/src/tool-system/builtin/index.ts:241-250`、
`packages/core/src/tool-system/registry.ts:35-57`。

这不会绕过 handler gate，但会让 non-vision 模型仍看到 schema、可能发起注定只返回占位文本的调用。
这是效率/工具选择质量问题，不是图片泄露 bug；真正的泄露防线仍在
`packages/core/src/tool-system/builtin/view-image.ts:98-104,140-144`。

## E. 改进建议（按严重度）

### P1

#### 1. [Bug] 把历史图片号码改为持久 identity，不要从 compacted slice 重算

**锚点：** `packages/core/src/context/compaction.ts:47-88`、
`packages/core/src/context/compaction.ts:99-170`、
`packages/core/src/tool-system/builtin/view-image.ts:154-185`、
`packages/core/src/session/transcript.ts:89-102,149-212`。

建议在 transcript 图片事件/block 上持久化稳定 `imageId` 或 session-global ordinal，并让占位符与
`viewHistoricalImage` 都按这个 identity 工作。至少也应由 transcript 生成一次“全局 ordinal -> block”
映射，再把稳定号码注入 working messages；不能让 `collectBase64Images(compactedMessages)` 自己从 1
开始决定身份。现有纯文本占位符可保留用于模型提示，但不应作为唯一身份载体。

新增测试必须覆盖：`windowCompact`/`snipCompact` 删除全部旧占位符后再加入新图、summary 后取回、
resume 后取回、重复取回同一图、以及旧图在 nested tool result 中的场景。现有测试只覆盖完整 fixture
和简单 resume，见 `packages/core/src/tool-system/builtin/view-image-by-number.test.ts:117-135,216-230`。

#### 2. [健壮性/安全] 用单一文件描述符做“普通文件 + 有界 + 可取消”读取

**锚点：** `packages/core/src/tool-system/builtin/view-image.ts:113-130`、
`packages/core/src/tool-system/registry.ts:121-153`、
`packages/core/src/tool-system/path-policy.ts:375-409`。

建议：打开一次文件、对同一 fd 做 `fstat`/普通文件检查、最多读取 `limit+1` 字节、接入
`ctx.signal`，并在 finally 关闭 fd。路径策略与实际 fd 之间还应尽量绑定 canonical target；至少要
消除 `stat(path)` 后再 `readFile(path)` 的替换窗口。特殊文件直接拒绝。仅在 read 完后再检查
`buf.length` 不能解决 OOM/阻塞问题，必须是有界读取。

#### 3. [健壮性] 复用统一图片预算，并在 tool-result batch 发送前做累计 gate

**锚点：** `packages/core/src/tool-system/builtin/view-image.ts:24,113-137`、
`packages/core/src/tool-system/builtin/index.ts:241-250`、
`packages/core/src/engine/turn-loop.ts:1076-1129`、
`packages/core/src/engine/image-policy.ts:58-62,197-251`。

至少统一单图阈值，且在即将把一批 tool-result images 交给 model 前执行 count/decoded-total gate。
更理想的是复用现有压缩链：默认 high 将长边/patch budget 压到目标范围，`original` 才允许更高上限。
这同时解决 5 MiB 原图变 6.67 MiB base64、并发多图和 provider 请求体爆炸问题。若产品决定保留
5 MiB 单图，也必须另有 per-round 总量上限。

### P2

#### 4. [Bug] 统一 capability 的唯一来源与 provider-kind 归一化

**锚点：** `packages/core/src/tool-system/builtin/view-image.ts:140-144`、
`packages/core/src/llm/providers/openai.ts:230-244`、
`packages/core/src/engine/engine.ts:1048-1050`。

在 Engine/ModelFacade 解析一次 capability，把解析后的 `supportsVision` 或规范化 providerKind 放入
ToolContext，并让工具与 provider 共用；不要各自写不同 fallback。新增缺 providerKind 的 OpenRouter
vision model 回归测试，断言工具 gate 与 provider buildMessages 结论相同。

#### 5. [Codex 对齐] 真正实现 per-call `detail`，或删除 no-op 参数

**锚点：** `packages/core/src/tool-system/builtin/view-image.ts:54-59,76-79`、
`packages/core/src/types.ts:9-27`、
`packages/core/src/llm/providers/openai.ts:868-875,1149-1155`。

若对齐 Codex，schema 应为默认 `high` + 可选 `original`，并仅在模型能力允许时暴露 original；detail
必须随图片 block 进入 provider/预处理层。Codex 参考语义见
[`codex-rs/core/src/tools/handlers/view_image_spec.rs:20-29`][codex-spec]、
[`codex-rs/core/src/tools/handlers/view_image.rs:123-134`][codex-detail-parse]、
[`codex-rs/core/src/tools/handlers/view_image.rs:179-186`][codex-detail-apply] 和
[`codex-rs/core/src/image_preparation.rs:127-134`][codex-prep-flow]。如果短期不实现，应删除参数而不是
继续接受后忽略；`standard` 可保留为 CodeShell 全局设置，但不应冒充 Codex tool-call detail。

#### 6. [健壮性/Codex 对齐] 从真实字节 sniff + decode + normalize，不信扩展名

**锚点：** `packages/core/src/tool-system/builtin/view-image.ts:26-32,106-137`。

格式 gate 应以 magic/decode 结果为准，扩展名只用于提示。拒绝损坏数据；动画 GIF 至少抽首帧并
重编码成 PNG，或明确拒绝；检查像素尺寸/patch budget；输出 MIME 必须来自实际编码结果。Codex
参考见 [`codex-rs/utils/image/src/lib.rs:103-185`][codex-sniff] 和
[`codex-rs/utils/image/src/lib.rs:264-317`][codex-dimensions]。这也应复用于
`viewHistoricalImage`，避免历史 data URL 绕过本地格式规则。

#### 7. [Bug] 合并 OpenAI data URL 的识别、解析、验证为一个函数

**锚点：** `packages/core/src/context/compaction.ts:197-215`、
`packages/core/src/tool-system/builtin/view-image.ts:188-223`、
`packages/core/src/llm/providers/openai.ts:858-881`。

collector 与 converter 必须调用同一个严格 parser：验证 data scheme、base64 标志、非空且合法的
base64、允许的真实 MIME，并统一处理/拒绝参数与空白。解析失败不得把强制 cast 的 `image_url`
当内部 ContentBlock 返回成功；应返回明确错误或占位符。新增空 payload、非法 base64、带
`charset` 参数、换行、SVG/BMP data URL 测试。

#### 8. [健壮性] 让 schema 表达 exactly-one，并让参数错误成为真正 tool error

**锚点：** `packages/core/src/tool-system/builtin/view-image.ts:42-89`、
`packages/core/src/tool-system/validation.ts:1-9,16-58`、
`packages/core/src/tool-system/registry.ts:157-179`。

schema 增加 `oneOf`（required path / required imageNumber）、`imageNumber:{type:"integer",minimum:1}`、
`additionalProperties:false`。轻量 validator 仍可保留 handler 校验，但 handler 的非法参数、格式、
过大等失败应返回结构化 error/抛出受控错误，使 `ToolResult.isError` 与 provider 的错误标志一致；当前
纯字符串 `Error: ...` 会被 registry 当成功 result。

### P3

#### 9. [健壮性] 明确历史图片是 identity 还是 occurrence，并避免重复持久化 base64

**锚点：** `packages/core/src/context/compaction.ts:47-80`、
`packages/core/src/tool-system/builtin/view-image.ts:173-185`、
`packages/core/src/engine/turn-loop.ts:1086-1092`。

推荐采用 identity：历史取回应持久化 `{imageRef:<id>}`，发送前解引用一次，而不是把同一 base64
作为新的图片出现再次写入 transcript。若坚持 occurrence 语义，tool description 和占位符需明确
“编号指历史出现位置”，并对 transcript 体积设上限。

#### 10. [效率] 非 vision 模型不暴露 `view_image`，handler gate 继续保留

**锚点：** `packages/core/src/tool-system/builtin/index.ts:241-250`、
`packages/core/src/tool-system/registry.ts:35-57`、
`packages/core/src/tool-system/builtin/view-image.ts:98-104`。

在 tool visibility/definition 构建阶段按已解析 capability 隐藏，减少 schema token 与误调用；handler
仍保留 fail-closed，防止模型热切换或上下文漂移。

#### 11. [测试] 补足当前测试矩阵之外的端到端边界

**锚点：** 当前覆盖见 `packages/core/src/tool-system/builtin/view-image.test.ts:27-116`、
`packages/core/src/tool-system/builtin/view-image-by-number.test.ts:117-230`、
`packages/core/src/engine/turn-loop-image-history.test.ts:148-193`、
`packages/core/src/llm/providers/openai-tool-result-image.test.ts:50-91`。

建议新增：

- compaction 后编号不变并取回同一像素；
- 多个并发 `view_image` 的 count/total-byte gate；
- symlink/文件替换、FIFO、目录、取消中的读取；
- 扩展名与 magic 不符、损坏图、超大维度小压缩图、动画 GIF；
- detail 在 OpenAI wire/预处理输出中真实生效；
- 缺 providerKind 时 tool gate 与 provider strip 一致；
- malformed OpenAI data URL 不得返回假成功。

## 最终判断

CodeShell 的 `view_image(path)` 在普通 PNG/JPEG、小文件、vision 模型、完整 runtime config 下是可用
的，且工具结果到 OpenAI-compatible provider 的图片链路已有测试保证。
`packages/core/src/tool-system/builtin/view-image.test.ts:27-73`、
`packages/core/src/engine/turn-loop-image-history.test.ts:171-193`、
`packages/core/src/llm/providers/openai-tool-result-image.test.ts:50-91`。

但 `imageNumber` 当前不能承诺跨 compaction 稳定，因而不应被视为可靠的持久历史引用；在修复前，
它只在“完整、未裁剪、编号占位符仍保留”的消息序列中可靠。
`packages/core/src/context/compaction.ts:52-88,343-356`、
`packages/core/src/tool-system/builtin/view-image.ts:154-170`。

三道 gate 中，vision fail-closed 的方向正确；扩展名格式 gate 只能算 UX gate；5 MiB gate 对常规文件
有效，但必须补普通文件检查、有界原子读取、取消与 per-round 累计预算，才能称为可靠的资源边界。
`packages/core/src/tool-system/builtin/view-image.ts:98-137`、
`packages/core/src/engine/image-policy.ts:58-62,197-251`。

[codex-spec]: https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/core/src/tools/handlers/view_image_spec.rs#L15-L49
[codex-vision-gate]: https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/core/src/tools/handlers/view_image.rs#L84-L98
[codex-read]: https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/core/src/tools/handlers/view_image.rs#L136-L177
[codex-detail-parse]: https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/core/src/tools/handlers/view_image.rs#L118-L134
[codex-detail-apply]: https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/core/src/tools/handlers/view_image.rs#L179-L201
[codex-output]: https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/core/src/tools/handlers/view_image.rs#L207-L235
[codex-prep-limits]: https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/core/src/image_preparation.rs#L19-L26
[codex-prep-flow]: https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/core/src/image_preparation.rs#L91-L135
[codex-sniff]: https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/utils/image/src/lib.rs#L103-L185
[codex-data-url]: https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/utils/image/src/lib.rs#L215-L261
[codex-dimensions]: https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/utils/image/src/lib.rs#L264-L317
[codex-preserve-formats]: https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/utils/image/src/lib.rs#L310-L317
