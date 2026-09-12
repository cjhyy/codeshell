# 面板插件边界与 CodeShell 通用能力审计

> Historical audit baseline, 2026-09-12. API 14 implementation and current acceptance are tracked in [the runtime implementation checklist](panel-plugin-runtime-implementation.md); current interface documentation is [Native Panel tools](../panel-native-tools.md). Statements below describe the audited pre-migration state.

日期：2026-09-12。范围：当前共享工作区源码中的 Desktop/Server Panel 接口，以及 Video Studio、Video Download、Quant Lab、Design Studio、Job Hunt HQ 五个面板。包含未提交代码，不表示当前运行中的应用已升级。

本次是边界和能力盘点；下文新增接口均为建议，尚未实现。此前完成的是 Video Studio 0.4.7 的 Audio8/Qwen 面板自管，以及通用媒体分块读取。没有在本次审计中新增业务功能或改变运行行为。

## 原则与判定

面板功能归独立插件：模型与版本、依赖安装、行情来源、页面与文档结构、剪辑算法、参考音频要求、字幕和场景模板，都由面板发布。CodeShell 的职责是权限、文件/资源、进程/任务生命周期、凭据及系统能力适配。

新增 Host 接口前依次确认：

1. 现有接口是否已能满足；仅有重复代码时，先抽 Panel SDK/helper。
2. 缺口是否必须在 Host 一侧处理，例如授权文件句柄、安装包版本绑定或脱离界面的任务生命周期。
3. 是否有多个实际消费者，或明确的系统边界理由；接口不出现某个模型、网站、编辑器工程类型或专用时间限制。
4. 是否保留撤权、解绑、更新/卸载、任务取消和错误结果的边界；这些由 Host 通用管理，插件不能通过接口自授权限。

“面板是插件功能”是架构归属原则，不要求合并现有 Panel App 与 Agent Plugin 两种包格式、注册表和安装流程。

## 已有能力，不应重复建设

这里的“已有”只说明可复用的实现和兼容入口，不表示整项服务应永久留在主程序。复用前仍需按下面的职责表拆开；纯库复用不要求升级 CodeShell。

| 已有能力                      | 现状与边界                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 本地程序与进程事件            | `process.find/info/spawn/cancel` 已存在，支持执行授权、退出/输出事件和进程组取消。无需为每个 CLI 新增 Host 方法。             |
| 插件私有数据与已授权目录      | 已有 `app-data`、`user-bin`、用户选定目录的不透明句柄；模型版本选择与安装步骤可在插件工具中实现。                             |
| 轻量数据与工作区文本          | `storage.*`、`workspace.*` 已有隔离、大小限制和并发写入校验。不是所有面板都需要数据库接口。                                   |
| AI 子任务、模型选择、定时任务 | `agent.task.*`、`agent.task.models`、Desktop 的 `automations.*` 已有。无需为“AI 初始化配音”或“定时行情更新”新增业务方法。     |
| 文件选择、录制与受管媒体      | Desktop 已有导入、流式预览、录制分块入库及 `media.assets.read`。后者只解决受管媒体读取，尚不是通用文件与工具直连。            |
| Cookie 与模型连接             | 已有 Cookie 授权和宿主管理的模型连接；本次没有发现必须另建一套通用账号/密钥系统的前置需求。外部连接扩展复用现有 Link 路线。   |
| 安装包与构建                  | 安装已经有内容审阅、版本更新和失败回滚；面板仓库已支持 `nativeEntries` 自包含工具打包。缺的是运行时入口句柄，而非再造打包器。 |

证据：[Panel 接口](../panel-apps.md)、[通用进程](https://github.com/cjhyy/codeshell/blob/538b29b516899378476ab32bac1556413f9eb47d/packages/server/src/panels/process-service.ts)、[通用存储与工作区](https://github.com/cjhyy/codeshell/blob/538b29b516899378476ab32bac1556413f9eb47d/packages/server/src/panels/runtime-services.ts)、[Web 当前支持范围](../web-panels.md)。Desktop 和 Web 的能力集合不同，不能把安装成功当成全部方法可用。

## 素材管理、进度、取消与重试的归属

“复用已有的素材管理、生成进度、取消和失败重试”不能理解为继续把整套媒体服务放在 Host。应拆为插件业务、共享 SDK 与必须由 Host 执行的机制：

| 功能     | 插件或共享 SDK 负责                                                                                       | CodeShell 保留的通用机制                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 素材管理 | 素材库界面、分类、时间线引用、配音配方、波形/缩略图生成、媒体格式解释与预处理。通用索引辅助逻辑可抽 SDK。 | 已授权文件/资源的保存与读取、不透明句柄、范围隔离、配额、原子提交；预览传输及安全呈现规则由 Host 统一约束。                     |
| 生成进度 | 模型输出解析、阶段划分、百分比计算、文案及界面；普通事件组装可抽 SDK。                                    | 事件传递、大小与频率限制、状态/退出回执；需要持久任务时才增加对应的通用存储和查询。                                             |
| 取消     | 取消按钮、停止业务步骤、临时文件清理、向具体工具传递停止指令；共用的取消等待可抽 SDK。                    | 撤权与进程组终止、退出确认。不能把停止本地进程的责任只交给可能已经关闭的面板。                                                  |
| 失败重试 | 是否可重试、参数/缓存复用、退避、断点续跑，以及是否会重复收费或写入；由插件声明策略，SDK 可执行通用编排。 | 重新执行时检查授权、包版本和上一进程已退出；如提供持久任务，仅保存 attempt/状态并执行明确策略，不默认把任何失败视为可安全重试。 |

当前 [MediaLibrary](https://github.com/cjhyy/codeshell/blob/538b29b516899378476ab32bac1556413f9eb47d/packages/desktop/src/main/media/media-library.ts) 的文件身份检查、摘要、原子提交与范围读取可作为通用资源实现的基础；其媒体类型及上层素材准备流程不能整体视为通用资产平台。[MediaJobService](https://github.com/cjhyy/codeshell/blob/538b29b516899378476ab32bac1556413f9eb47d/packages/desktop/src/main/media/media-jobs.ts) 的状态和取消机制有复用价值，但目前接收 Host 内存中的 `processor.run` 回调；迁移插件时需要独立进程入口，不能只改名为通用 JobService，再把插件回调加载回主程序。

[PanelMediaService](https://github.com/cjhyy/codeshell/blob/538b29b516899378476ab32bac1556413f9eb47d/packages/desktop/src/main/media/panel-media-service.ts) 仍在主程序注册具体 TTS、场景生成、素材准备等处理器，并决定它们的恢复策略。这些注册、编排和策略也属于迁出范围。新的 Audio8/Qwen 面板桥已自行处理生成进度、取消和手动重试；接口沿用 `media.jobs.*` 命名不表示对应模型任务仍交给 Host 执行。

拆分顺序是先抽可复用的纯逻辑与插件适配器，再用通用文件/进程接口承接，保留旧素材 ID、任务记录和项目兼容路径，最后删除旧业务注册。无需为了迁出普通进度和重试编排先建设完整后台任务平台。

## 值得更新 CodeShell 的四类能力

### 1. 通用文件与工具直连：优先解决实际数据绕行

现有受管素材只能按 32 KiB 取回面板，再通过多次 Node 进程写入 app-data；生成结果又分块送回媒体入库。真实 Audio8 迁移测试使用 37 次进程启动，8.3 秒参考生成 8.15 秒音频，包含数据搬运的生成阶段约 41 秒。这是整条链路测量，不能把全部时间归因于文件传输或视为优化后的速度承诺。

Design Studio 使用 Base64 文本分片表达图片/字体资源；Job Hunt HQ 把附件拆成 `.txt` 和 `manifest.json`，再让 Agent 重组。它们也需要通用二进制资源能力，而非媒体专用上传。

建议复用现成的目录、资源和 sealed file-argument 机制，增加“已授权资源 → 指定工具的只读输入”“工具授权输出 → 校验/原子入库”的通用句柄。文档、图片、CSV、大型音视频采用同一条数据路径；Guest 不需要获知 Host 绝对路径。现有分块接口保留作兼容路径。

Host 只处理范围授权、顺序/完整性、配额及结果登记；FFmpeg 参数、文件解释、模型输入标准仍由插件决定。首先做当前工作区和插件私有目录，不开放任意路径或隐式覆盖原文件。句柄限制的是接口授权范围，不等于为已批准的本地程序建立操作系统沙箱。

证据：

- [真实迁移记录](../../artifacts/video-studio/audio8-panel-native-validation/evidence.json)。
- [现有 sealed file-argument 与进程](https://github.com/cjhyy/codeshell/blob/538b29b516899378476ab32bac1556413f9eb47d/packages/server/src/panels/process-service.ts)，当前从 Cookie 专用入口授予。
- [媒体分块入口](https://github.com/cjhyy/codeshell/blob/538b29b516899378476ab32bac1556413f9eb47d/packages/desktop/src/main/media/panel-media-service.ts)、[录制上传的格式约束](https://github.com/cjhyy/codeshell/blob/538b29b516899378476ab32bac1556413f9eb47d/packages/desktop/src/main/media/media-recording-ingest.ts)。
- 面板仓库 `apps/design-studio/app/app.js` 的 `put_design_resource`，`apps/job-hunt-hq/app/app.js` 的 `encoding: "base64-chunks"` 和附件重组提示。

### 2. 进程状态回执；后台任务按实际需要扩展

现有进程退出后从内存表删除，只发送一次退出事件；取消返回值表示已请求终止，不等于进程已经退出。首先补一个更小的通用能力：有期限、有容量上限、受原 owner 授权约束的进程状态/退出回执查询，以及事件序号。面板便能确认取消完成、处理遗漏事件；不必先建设持久后台运行平台。排队、NDJSON 解析、进度及手动重试继续抽为 Panel SDK。

当前普通进程属于面板 Guest，关闭面板会终止。视频配音已保存任务日志，但重开只能将旧运行状态标记为中断；下载面板和行情历史同步同样存在长任务。另一方面，Host 内部媒体任务已经能持久保存、恢复和重试，但处理器由主程序注册，插件不能复用这个生命周期去执行自身工具。

确有关闭面板后继续运行的产品需求时，再参考既有队列和任务记录机制提供通用插件任务入口，支持列表、取消、事件游标、结果和重连。任务运行面板包中的独立工具；CodeShell 不认识 Audio8、股票代码或渲染模板。

后台运行必须是明确的任务模式：普通进程仍可随面板结束；持久任务绑定 app、workspace、安装 revision 与入口快照。更新/卸载和撤权时如何停止或继续需要固定语义；恢复只能重启插件声明可安全重做的操作，不能将任意任务默认为断点续跑。

证据：[现有媒体任务服务](https://github.com/cjhyy/codeshell/blob/538b29b516899378476ab32bac1556413f9eb47d/packages/desktop/src/main/media/media-jobs.ts)、[Guest 撤销进程](https://github.com/cjhyy/codeshell/blob/538b29b516899378476ab32bac1556413f9eb47d/packages/server/src/panels/process-service.ts)、面板仓库 `apps/video-studio/src/local-voice-bridge.ts` 的 `PANEL_CLOSED`、Video Download 的内存任务和 Quant Lab 历史数据初始化进程。

### 3. 能力、限制与错误发现：最适合先做的小步

Web 已提供按当前权限过滤的 `availableMethods`；Desktop 的上下文主要提供 `apiVersion: 13`。下载和求职面板仍有大量版本号判断，无法可靠地区分 Web 不支持、权限未授予和本地依赖未安装。普通调用 30 次/10 秒、媒体分块 512 次/10 秒、进程参数总 64 KiB 等限制也只能由各面板硬编码。

建议沿用 Web 的方法发现字段并在 Desktop 补齐，统一返回方法可用性、资源/速率限额，以及稳定错误码和限流后的可重试时间。支持范围、当前授权和插件依赖状态应分别表达；CodeShell 无需枚举模型是否已下载，后者由插件工具报告。

客户端自动排队、缓存查询、重试和进程事件重组应抽进面板 SDK。Quant Lab 已有调用调度器，Video Studio 另有进程节流，属于可共享实现；不应在主程序里新增“行情刷新排队”或“配音限流”分支。

证据：[Web 上下文](https://github.com/cjhyy/codeshell/blob/538b29b516899378476ab32bac1556413f9eb47d/packages/server/src/panels/runtime.ts)、[Desktop 上下文类型](https://github.com/cjhyy/codeshell/blob/538b29b516899378476ab32bac1556413f9eb47d/packages/desktop/src/shared/panel-apps.ts)、[Desktop 请求边界](https://github.com/cjhyy/codeshell/blob/538b29b516899378476ab32bac1556413f9eb47d/packages/desktop/src/main/panel-app-bridge.ts)，面板仓库 `apps/quant-lab/app/modules/panel-host-call-scheduler.mjs` 和 `apps/video-studio/src/local-voice-process.ts`。

### 4. 稳定的随包工具入口：统一启动方法

`process.find` 目前只查 PATH 中的简单可执行名。Quant Lab 因此在 launcher 中拼接 `~/.code-shell/panel-apps/...`；Video Studio 则把经构建校验的工具源码搬到 app-data，再通过 Node 启动。构建层已支持 native 工具，但运行接口还不直接识别已审阅的包内入口。

建议用 manifest 声明的工具 ID 或包内入口句柄定位已安装文件，并绑定当前 app/revision，复用现有执行授权和进程事件。现有 sealed file-argument 只支持长选项与文件配对，还不能直接表达 Node 的位置参数脚本，不能把它当成已经完成的包入口接口。具体运行时版本、依赖与模型清单仍由插件维护，不能直接 import 插件模块进入 Desktop 主进程。

若需要连续交互，再给进程补有大小限制、背压与关闭语义的 stdin 通道；当前 stdin 为 ignore。它是辅助选项，不应代替上面的文件句柄来传大型音视频，也不必先做完整常驻服务平台。

证据：[进程查找与 stdio](https://github.com/cjhyy/codeshell/blob/538b29b516899378476ab32bac1556413f9eb47d/packages/server/src/panels/process-service.ts)、面板仓库 `apps/quant-lab/app/modules/history-data-ui.mjs` 的 launcher、`apps/video-studio/src/local-voice-process.ts` 的工具准备协议，以及 `scripts/build-panels.mjs` 的 `nativeEntries`。

## 仍需迁出的业务耦合

上轮移出 Audio8/Qwen 不等于全部媒体代码已通用化。按本次用户确认的边界，还应继续检查：

| 当前 Host 内容                                                              | 应归属                                                                |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Edge/Kokoro 的具体包版本、下载地址、声音目录、安装/生成适配器               | 面板工具或独立可选提供者；保留既有调用的迁移兼容。                    |
| HyperFrames chapter/explainer 模板、配色/文案结构、固定渲染选择             | 视频插件；Host 只提供通用进程、文件和任务。                           |
| Whisper `base.pt` 固定选择                                                  | 插件的转写适配器；系统音频权限与授权输入保留为 Host 能力。            |
| 音频提取固定 30 fps、3–30 秒、本人参考文案                                  | 声音克隆面板校验。提取若保留 Host API，应使用通用时间范围与资源预算。 |
| `media.render` 直接校验 Video Studio schemaVersion=1、30 fps 工程及字幕结构 | 视频插件的工程解释和渲染工具；不能因接口叫 media 就视作平台中立。     |

证据：[具体语音提供者](https://github.com/cjhyy/codeshell/blob/538b29b516899378476ab32bac1556413f9eb47d/packages/desktop/src/main/media/media-tts-providers.ts)、[场景模板适配器](https://github.com/cjhyy/codeshell/blob/538b29b516899378476ab32bac1556413f9eb47d/packages/desktop/src/main/media/hyperframes-adapter.ts)、[媒体服务组合](https://github.com/cjhyy/codeshell/blob/538b29b516899378476ab32bac1556413f9eb47d/packages/desktop/src/main/media/panel-media-service.ts)、[工程与转写实现](https://github.com/cjhyy/codeshell/blob/538b29b516899378476ab32bac1556413f9eb47d/packages/desktop/src/main/media/media-processors.ts)。

以上历史源码链接固定到基线 `538b29b5`。审计中的固定提取约束来自当时未提交的 `media-audio-extract.ts` 实现，未收录于该基线，不能作为该提交的源码证据。

系统已有的语音连接与密钥管理可能服务于 CodeShell 自身功能，应按调用方核查后保留通用部分；本次不主张整包删除 speech 能力。

## 建议实施顺序与验收

1. **能力发现与进程回执（分别为 M）**：Desktop 与 Web 返回实际方法和限制；已有面板正确显示不支持、未授权、依赖未就绪。退出回执解决事件遗漏和取消完成确认，初版保持关闭面板终止进程。配套 SDK 复用另行在面板仓库完成。
2. **文件句柄与随包工具（L，分步）**：至少用视频声音工具和设计/求职附件验证通用数据链路，不再靠固定安装路径或 Base64 文本分片搬运。记录实际调用数、传输量和耗时，不预设性能数字。
3. **通用后台任务（L，按需求）**：明确需要关闭后继续运行时，用下载与声音/数据同步两个消费者验证关闭重连、重启、取消、撤权、包更新及重试；无需改变它们的业务算法。
4. **逐项迁移遗留媒体适配器**：保留现有素材、任务和项目兼容；每迁出一项验证对应插件真实结果。只有通用入口完成后再删除原实现，不为清理代码破坏已工作的功能。

还有一项条件性需求：Quant Lab 工具支持读取付费数据源的环境凭证，但 Host 的进程环境白名单不传这些密钥，当前 UI 因而只提供免凭证来源。将来启用这类来源时，优先复用已有 Cookie 密封传递和 Link 连接机制，扩展“选定凭证引用 → 指定工具”的授权方式；无需另建秘密存储，也不能开放继承全部环境变量。当前免费行情和现有 Cookie 登录不依赖该扩展。

网络代理、另一套秘密存储、插件专用数据库、统一模型商店和任意常驻服务平台本次没有作为必做项。先用当前接口/已有 Link 路线和插件库解决，等出现明确缺口再扩 Host。
