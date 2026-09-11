# 2026-09-11 默认跳过测试审计

来源是 `/tmp/codeshell-polish-20260911/tests-baseline.log` 最末尾的 **65 tests skipped** 清单；不把前面重复打印的 `(skip)` 再计一次。首次基线总计 11231 pass、65 skip、23 fail、1 error；失败修复与最终全量结果由主任务另行记录。

## 65 个实际跳过条目的归因

| 组别                     | 基线条目数 | 原因 / 入口                                                                                                                                | 本轮结论                                                                                             |
| ------------------------ | ---------: | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Panel App protocol       |         14 | `packages/desktop/tests/panel-app-main.test.ts` 要求 `CODESHELL_PANEL_APP_FIXTURE=1`，避免 Electron mock 污染主测试进程                    | 与 Bridge 一并独立运行，51 pass / 290 assertions / 1.89s                                             |
| PanelAppBridge           |         37 | 同上；由 `packages/desktop/src/main/panel-app-protocol.test.ts` 启动隔离子进程                                                             | 基线第 8614 行 wrapper 已 pass，51 skip 是默认发现时重复注册的隔离入口，不能误称 51 项此前完全未测   |
| 真实外部 Agent           |          3 | `packages/coding/src/cc-orchestrator/external-agent-driver.test.ts`，需 `CODESHELL_RUN_REAL_AGENT_TESTS=1`、真实 Claude/Codex 运行时及账号 | 未运行；需要真实登录与外部调用，不访问用户账号来凑通过数                                             |
| 真实 LLM send_input 记忆 |          3 | `packages/core/src/tool-system/builtin/agent.send-input.llm.test.ts`，需 `RUN_LLM_E2E=1`，会读取用户模型连接/凭据并消耗 provider tokens    | 未运行；实际是 1 个 recall 场景 + Bun 记录的 2 个 unnamed hook，并非 3 个未实现能力                  |
| 已安装 TTS providers     |          6 | `packages/desktop/src/main/media/media-tts-providers.test.ts`，需 `CODESHELL_TEST_TTS_RUNTIME` 指向准备完成的 runtime                      | 未运行；5 项依赖已有 Kokoro 环境，1 项 Edge 会真实联网；未找到可验证 Kokoro runtime，不触发安装/下载 |
| 本地中文 Whisper         |          1 | `packages/desktop/src/main/media/media-processors.test.ts`，需 `CODESHELL_MEDIA_TEST_ASR=1`                                                | 额外开启并通过，1 pass / 7 assertions / 9.15s                                                        |
| 本地 HyperFrames         |          1 | `packages/desktop/src/main/media/hyperframes-adapter.test.ts`，需 `CODESHELL_HYPERFRAMES_INTEGRATION=1`                                    | 额外开启并通过，1 pass / 15 assertions / 32.17s                                                      |
| 合计                     |     **65** | **53 项本轮单独执行通过，12 条目保留环境/外部验证门控**                                                                                    | 这不是把默认全量的 65 skip 改成 12 skip；默认安全门控保持原样                                        |

## 后续新增回归与最终门控增量

上面的 65 条和文末逐条表继续对应原始基线，不改写旧日志。后续新增 `PanelAppBridge > two bridge instances share the storage lock without blocking its async holder` 回归，也放在同一个 Electron mock 隔离 fixture 中；默认发现会多注册 **1 个 skip**，因此门控条目由 **65 增为 66**，Panel 由 **51 增为 52**（14 个 protocol + 38 个 Bridge）。这不是新增未测试功能：隔离子进程完整执行 **52 pass / 294 assertions**，日志 `/tmp/codeshell-polish-20260911/panel-storage-contention-fixture.log`；支持入口 `panel-app-protocol.test.ts` 也通过。

最新构成是 **52 个隔离 Panel 条目 + 2 个已额外开启通过的本地 ASR/HyperFrames 条目 + 12 个仍需环境或外部验证的条目 = 66**。原来未执行的外部 Agent 3、LLM 3、TTS 6 共 12 条不变；Whisper/HyperFrames 使用已有运行时的通过结果也不变。新增用例的两个桥接实例是可复现的 API 并发边界；当前 Desktop 生产入口只有一个全局 `PanelAppBridge`，不能把它描述为每个面板都创建一个存储实例。最终全量运行数字另由主任务记录。

## 本机已有运行时与副作用核查

- Panel 测试使用临时目录和隔离 Electron mock 子进程；涉及 Cookie、凭证、通知、进程参数的内容均为测试 fixture，不使用用户真实账户。独立日志：`/tmp/codeshell-polish-20260911/panel-isolated.log`。
- Whisper 已有 `/opt/homebrew/bin/whisper`、ffmpeg/ffprobe 8.1.1 与 `~/.cache/whisper/base.pt`（145262807 bytes）；系统已有 Tingting 音色。测试用 `say` 合成固定中文短句，再做 CPU 转写，检查段落与词时间。实现先核查本地模型文件，并将绝对路径交给 Whisper；没有模型安装、麦克风采集或真实用户媒体。日志：`/tmp/codeshell-polish-20260911/whisper-local.log`。
- HyperFrames runtime 检测找到已有 0.8.30 CLI、Node v25.8.1 和缓存 Chrome Headless Shell 147.0.7727.57。Adapter 直接执行本地 CLI，关闭 telemetry；测试组成是本地 HTML/JSON，无远程素材。验证真实 check、H.264 输出、导入、hash 缓存、loopback 预览关闭与进程取消；未安装 npm 包或浏览器。日志：`/tmp/codeshell-polish-20260911/hyperframes-local.log`。
- Kokoro 宿主路径为 `userData/panel-app-media/media-runtimes/tts/kokoro/runtime.json`。核查当前 code-shell app data、`.code-shell` 和仓库 artifacts 的已知 runtime 位置，未找到已安装清单；“未找到”限定于这些已知位置，并非断言整台机器绝无其他手工环境。未运行 `setup`、下载模型或联网 Edge TTS。
- TTS 中名为 “fixed model download” 的测试会 mock fetch，但仍依赖既有 Kokoro Python venv；“same-size corrupted weights” 会复制模型到临时目录后破坏副本。二者都不能在缺失 runtime 时无条件开启。

## 静态 skip / todo 门控补查

在 `tests/`、`packages/` 和 `scripts/` 测试文件中检索 `test.todo`、`it.todo`、`describe.todo`，没有发现占位测试。静态 skip 数不能直接等于 65：条件 alias、循环生成用例和 skipped hook 都会影响运行时条目数。

| 门控类型          | 源码位置                                                                                                                                                                                 | 判定                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 平台 / POSIX 行为 | `external-agent-driver.test.ts`、`external-runtime-launch.test.ts`、`external-runtime-availability.test.ts` 在 Windows 跳过；`session-titles-store.test.ts` 在 Windows/root 跳过权限断言 | 平台适用性，不能当未实现功能；本次 macOS 65 条目里未因这些条件跳过                                                           |
| macOS Seatbelt    | `tests/sandbox.test.ts`、`core/src/tool-system/sandbox/sandbox.test.ts` 与 `multi-root.seatbelt.e2e.test.ts`                                                                             | 需 macOS/sandbox-exec；非 macOS 的占位 skip 是平台提示，本机未因此新增 skip                                                  |
| 浏览器可执行文件  | Puppeteer、browser-inspector、Playwright、scroll/CDP integration 用本地 Chrome/启动候选门控                                                                                              | 环境依赖；本次 65 条目里没有缺浏览器而跳过的用例                                                                             |
| 媒体本地工具      | media-webm/inspection/caption-style/audio-enhance/recording-ingest/processors、panel-media-service/capabilities/speech、media-tts                                                        | 按 ffmpeg/ffprobe、macOS say 或现有浏览器能力门控；本次一般媒体用例已运行，只有上表显式 ASR/TTS/HyperFrames integration 跳过 |
| 构建产物          | `packages/server/src/serve/headless-backpressure.test.ts` 检查 `serverEntry` 是否存在                                                                                                    | 应先构建再验收；本次没有因此产生 skip                                                                                        |
| 工具测试覆盖      | `packages/core/src/tool-system/builtin/tool-coverage.test.ts` 动态对未找到测试的注册工具执行 skip                                                                                        | 是有意义的覆盖缺口检测入口；本次 65 条目没有这一来源，不应臆造缺测工具清单                                                   |

## 逐条对齐基线

下面保留运行器原测试标题，ID 顺序对应基线最终 skip 列表。`独立通过（已含 wrapper）` 特指 Panel；`额外开启通过` 特指本轮新开的真实本地媒体集成。

|  ID | 原测试标题                                                                                                                                                                  | 本轮结果                    |
| --: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
|   1 | Panel App protocol > registers Panel and theme schemes together as secure before app readiness                                                                              | 独立通过（已含 wrapper）    |
|   2 | Panel App protocol > serves declared static assets with strict security headers                                                                                             | 独立通过（已含 wrapper）    |
|   3 | Panel App protocol > serves installed MP3 and WAV files with audio MIME types and strict headers                                                                            | 独立通过（已含 wrapper）    |
|   4 | Panel App protocol > streams managed media with Range only from its bound app and project                                                                                   | 独立通过（已含 wrapper）    |
|   5 | Panel App protocol > managed media rejects a missing permission and a cross-app partition                                                                                   | 独立通过（已含 wrapper）    |
|   6 | Panel App protocol > managed media refuses active or non-media MIME types and closes rejected streams                                                                       | 独立通过（已含 wrapper）    |
|   7 | Panel App protocol > caption cancellation destroys a window while its page is still loading                                                                                 | 独立通过（已含 wrapper）    |
|   8 | Panel App protocol > caption execution timeout destroys its Chromium window and permits the next attempt                                                                    | 独立通过（已含 wrapper）    |
|   9 | Panel App protocol > rejects traversal, query strings, dotfiles, and assets outside the panel tree                                                                          | 独立通过（已含 wrapper）    |
|  10 | Panel App protocol > permits local blob media previews while keeping execution and network isolated                                                                         | 独立通过（已含 wrapper）    |
|  11 | Panel App protocol > rejects a symlink escape even when the extension is allowed                                                                                            | 独立通过（已含 wrapper）    |
|  12 | Panel App protocol > uses separate WebView partitions for separate projects                                                                                                 | 独立通过（已含 wrapper）    |
|  13 | Panel App protocol > capture permission is scoped, revocable and requires explicit screen selection                                                                         | 独立通过（已含 wrapper）    |
|  14 | Panel App protocol > grants microphone-only media access only to a reviewed audio Panel App                                                                                 | 独立通过（已含 wrapper）    |
|  15 | PanelAppBridge > gates process primitives and scopes user-selected directory handles                                                                                        | 独立通过（已含 wrapper）    |
|  16 | PanelAppBridge > fails closed before prepare and after a project binding is revoked                                                                                         | 独立通过（已含 wrapper）    |
|  17 | PanelAppBridge > invokes only declared Agent tools and accepts a response from the bound guest                                                                              | 独立通过（已含 wrapper）    |
|  18 | PanelAppBridge > clears an Agent tool request when the guest send fails synchronously                                                                                       | 独立通过（已含 wrapper）    |
|  19 | PanelAppBridge > ignores an Agent tool response from a different guest                                                                                                      | 独立通过（已含 wrapper）    |
|  20 | PanelAppBridge > rejects an in-flight Agent tool immediately when its app is revoked                                                                                        | 独立通过（已含 wrapper）    |
|  21 | PanelAppBridge > binds scope from the trusted host and exposes only permitted context                                                                                       | 独立通过（已含 wrapper）    |
|  22 | PanelAppBridge > holds startup context and capability calls until the project scope is bound                                                                                | 独立通过（已含 wrapper）    |
|  23 | PanelAppBridge > defaults to zero call permissions and rejects an unbound sender                                                                                            | 独立通过（已含 wrapper）    |
|  24 | PanelAppBridge > denies workspace.info when the panel has not declared the permission                                                                                       | 独立通过（已含 wrapper）    |
|  25 | PanelAppBridge > denies notifications.send when the panel has not declared the permission                                                                                   | 独立通过（已含 wrapper）    |
|  26 | PanelAppBridge > keeps Panel Cookie login host-owned and returns only matching masked accounts                                                                              | 独立通过（已含 wrapper）    |
|  27 | PanelAppBridge > authorizes a Cookie as an opaque executable-bound process argument                                                                                         | 独立通过（已含 wrapper）    |
|  28 | PanelAppBridge > never resolves a Cookie account from a shorter or bare-suffix host                                                                                         | 独立通过（已含 wrapper）    |
|  29 | PanelAppBridge > requires a trusted workspace before reaching saved Cookie credentials                                                                                      | 独立通过（已含 wrapper）    |
|  30 | PanelAppBridge > scopes Panel automations to the bound workspace and task                                                                                                   | 独立通过（已含 wrapper）    |
|  31 | PanelAppBridge > transcribes bounded microphone audio only with explicit permission                                                                                         | 独立通过（已含 wrapper）    |
|  32 | PanelAppBridge > does not expose transcription settings in an untrusted workspace                                                                                           | 独立通过（已含 wrapper）    |
|  33 | PanelAppBridge > enforces payload limits and revokes a destroyed guest                                                                                                      | 独立通过（已含 wrapper）    |
|  34 | PanelAppBridge > rejects prompt submission while the trusted session scope is busy                                                                                          | 独立通过（已含 wrapper）    |
|  35 | PanelAppBridge > serializes storage mutations, persists atomically, and enforces quota                                                                                      | 独立通过（已含 wrapper）    |
|  36 | PanelAppBridge > accepts a recovery snapshot larger than the generic call limit within storage quota                                                                        | 独立通过（已含 wrapper）    |
|  37 | PanelAppBridge > confirms external URLs and rejects unsafe schemes                                                                                                          | 独立通过（已含 wrapper）    |
|  38 | PanelAppBridge > enforces call rate, timeout, and result size independently                                                                                                 | 独立通过（已含 wrapper）    |
|  39 | PanelAppBridge > agent.submitPrompt accepts immediately instead of awaiting the agent                                                                                       | 独立通过（已含 wrapper）    |
|  40 | PanelAppBridge > agent.submitPrompt routes a Codex session to the external runtime only                                                                                     | 独立通过（已含 wrapper）    |
|  41 | PanelAppBridge > a Codex startup failure is surfaced without falling back to the native worker                                                                              | 独立通过（已含 wrapper）    |
|  42 | PanelAppBridge > a Panel turn reuses a compatible live Codex runtime without rebuilding handoff                                                                             | 独立通过（已含 wrapper）    |
|  43 | PanelAppBridge > agent.submitPrompt rejects a second submit while the first is in flight                                                                                    | 独立通过（已含 wrapper）    |
|  44 | PanelAppBridge > agent.submitPrompt frees its in-flight slot after the worker fails                                                                                         | 独立通过（已含 wrapper）    |
|  45 | PanelAppBridge > agent.submitPrompt reports a background worker failure into the session                                                                                    | 独立通过（已含 wrapper）    |
|  46 | PanelAppBridge > returns read-only workspace metadata with a best-effort git branch                                                                                         | 独立通过（已含 wrapper）    |
|  47 | PanelAppBridge > reads, lists, and atomically writes allowlisted files in a trusted workspace                                                                               | 独立通过（已含 wrapper）    |
|  48 | PanelAppBridge > media workspace import checks trust for its actual worktree cwd                                                                                            | 独立通过（已含 wrapper）    |
|  49 | PanelAppBridge > keeps workspace read and write permissions independent                                                                                                     | 独立通过（已含 wrapper）    |
|  50 | PanelAppBridge > rejects traversing, hidden, binary, symlink, and untrusted workspace paths                                                                                 | 独立通过（已含 wrapper）    |
|  51 | PanelAppBridge > sends title-prefixed system notifications under a dedicated per-window cap                                                                                 | 独立通过（已含 wrapper）    |
|  52 | external agent driver > runAgentOnce（真机集成,需 CODESHELL_RUN_REAL_AGENT_TESTS=1） > spawns claude and returns a sessionId + final text                                   | 保留：需真实账号 / 外部模型 |
|  53 | external agent driver > runAgentOnce（真机集成,需 CODESHELL_RUN_REAL_AGENT_TESTS=1） > resume continues the SAME session with prior context (CC remembers)                  | 保留：需真实账号 / 外部模型 |
|  54 | external agent driver > runAgentOnce codex（真机集成,需 CODESHELL_RUN_REAL_AGENT_TESTS=1） > spawns codex exec, feeds the prompt over stdin, returns thread_id + final text | 保留：需真实账号 / 外部模型 |
|  55 | send_input continuation — REAL LLM memory recall > (unnamed)                                                                                                                | 保留：需真实账号 / 外部模型 |
|  56 | send_input continuation — REAL LLM memory recall > recalls a number told in the first turn via AgentSendInput (≥90s)                                                        | 保留：需真实账号 / 外部模型 |
|  57 | send_input continuation — REAL LLM memory recall > (unnamed)                                                                                                                | 保留：需真实账号 / 外部模型 |
|  58 | verified installed providers produce real media > same-size corrupted local weights become unavailable without mutating the source runtime                                  | 保留：需 runtime / 外部网络 |
|  59 | verified installed providers produce real media > fixed model download rejects incorrect lengths and cleans a cancelled transfer                                            | 保留：需 runtime / 外部网络 |
|  60 | verified installed providers produce real media > edge-tts: actual Chinese speech, rate, cache corruption and PCM                                                           | 保留：需 runtime / 外部网络 |
|  61 | verified installed providers produce real media > kokoro: actual Chinese speech, rate, cache corruption and PCM                                                             | 保留：需 runtime / 外部网络 |
|  62 | verified installed providers produce real media > active local inference cancellation removes raw text and partial media                                                    | 保留：需 runtime / 外部网络 |
|  63 | verified installed providers produce real media > literal command-like narration is only data and cannot create files                                                       | 保留：需 runtime / 外部网络 |
|  64 | real local media processors > runs real local Chinese Whisper transcription with segment and word times                                                                     | 额外开启通过                |
|  65 | real HyperFrames check, H.264 render, source import, verified cache, preview and process cancellation                                                                       | 额外开启通过                |
