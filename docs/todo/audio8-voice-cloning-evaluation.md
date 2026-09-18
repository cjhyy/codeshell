# Audio8 与视频面板声音克隆：调研及接入建议

查阅日期：2026-09-12。状态：视频面板 0.4.7 自管 Audio8/Qwen，已完成迁移后的真实端到端验证；CodeShell 主程序仅提供通用媒体、进程与 app-data 能力。尚未使用用户本人录音做相似度和听感对比。

Audio8 核查版本：仓库 `07e40f5d0b03fc473635ef378654bfb581027ac3`；0.6B ONNX 模型 revision `818569c6b832118ad68d61bbd873abe250fcd68a`。本次集成已核实固定版本文件清单并加入逐文件 SHA-256 校验。

## 结论

建议将 **Audio8 0.6B ONNX INT4** 列为轻量本地克隆候选，以已有 **Qwen3-TTS Base 0.6B MLX** 为基线，再对照 **VoxCPM2**。这个顺序依据运行环境和接入成本，不是音质排名。默认引擎应由同一参考录音、同一中文文案的试听决定。

| 候选             | 已核实的能力与取舍                                                                                                                                      | 官方资料                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Audio8 0.6B ONNX | 支持中文、参考录音加逐字稿；有纯 CPU 运行器与可复用音色。作者报告在 macOS arm64 上验证过。当前仍是 Preview。                                            | [项目](https://github.com/Edge0-AI/Audio8_TTS)、[ONNX 指南](https://github.com/Edge0-AI/Audio8_TTS/blob/master/onnx_runtime/README_zh.md)    |
| Qwen3-TTS Base   | Base 提供声音克隆，0.6B 与 1.7B 可选；不要把 CustomVoice 的预设声音/指令能力当成 Base 克隆能力。现有面板源码采用 0.6B Base 的 MLX 版本。                | [项目与模型类型](https://github.com/QwenLM/Qwen3-TTS)                                                                                        |
| VoxCPM2          | 可用参考音频克隆并提供风格指令，也有参考音频加逐字稿的续写模式。官方支持 MPS；MLX-Audio 另有社区移植。适合作为中文表现和情绪控制的试听候选。            | [项目](https://github.com/OpenBMB/VoxCPM)、[MLX 实现](https://github.com/Blaizzy/mlx-audio/blob/main/mlx_audio/tts/models/voxcpm2/README.md) |
| IndexTTS2.5      | 当前仓库已有 2.5；支持声音参考、情绪参考和语速比例控制，代码有 MPS/CPU 路径。辅助依赖较多，不能直接套用 CUDA 的速度报告，也不能把语速比例说成精确控时。 | [项目](https://github.com/index-tts/index-tts)、[运行器](https://github.com/index-tts/index-tts/blob/main/indextts/infer_v2_5.py)            |

Audio8 旧组织地址会重定向到 `Edge0-AI`。不要混用 0.6B 与 0.1B 的说明：当前 0.1B 基础模型卡标注自定义 Community License，不能仅凭旧 README 将所有 Audio8 权重都称为 Apache-2.0。[0.1B 模型卡](https://huggingface.co/Edge0/Audio8-TTS-Preview-0.1b)

## 声音克隆如何工作

Audio8 ONNX 将参考音频编码后，与准确逐字稿组成可复用 profile；这一步不需要给本人训练一套新模型。官方 HTTP 流程是先向 `/api/voices/register` 提交 `audio/text/name`，再向 `/api/tts` 传 `text/voice_name`；已有音色也能经 `/v1/audio/speech` 调用。普通 TTS 兼容接口不负责首次录音注册。[注册与生成接口](https://github.com/Edge0-AI/Audio8_TTS/blob/master/onnx_runtime/README.md)

产品建议使用 10–20 秒干净本人录音，自动转写后允许逐字校正。Audio8 官方建议单次文本不超过 150 字，因此长文应分句生成，逐段检查并合并，避免截断句尾。[输入说明](https://github.com/Edge0-AI/Audio8_TTS/blob/master/README_zh.md)

## 当前架构与接入边界

- Audio8 与 Qwen 的具体实现、模型清单、依赖安装、参考注册、缓存和分段生成属于 `codeshell-panel-apps/apps/video-studio/native/`，由面板自身版本维护。CodeShell 的 `panel-media-service.ts` 不导入或实例化这两种 provider，也不接受模型专用 setup/clone 参数。
- 面板通过通用、受权限约束的进程接口运行打包的本地工具，在自己的 app-data 目录中保存固定依赖与模型。新模型不需要重新添加 Desktop 分支；原有 system、Edge、Kokoro 和配置式在线 TTS 保持现有契约。
- 浏览器 `cspanel` 不开放任意 fetch。通用 `media.assets.read {assetId,offset,length}` 仅允许读取当前 app/workspace 的受管素材，每次最多 32768 字节，返回无文件路径的 base64 数据和 EOF；以 `media.status.assetRead` 检测能力。面板按块将参考写入自己的工作目录，生成音频通过既有 `media.recording.*` 分块上传回受管素材库。
- `media.audio.extract` 保留为通用素材区间提取，实际生成独立 WAV，保留源文件和成片。当前限 3–30 秒、30 fps 整数源区间。粗剪 `roughCuts` 只标记范围，必须完成提取后才得到短参考文件。
- 面板初始化负责所选引擎的准备、参考与实际逐字稿、最多 120 字短试听及命名配方。试听只保存素材；安装完成、音频生成成功、用户确认像本人分别记录。缺录音不撤销已经完成的安装，也不以系统样例冒充本人。
- 注册缓存包含作用域、引擎/模型版本、参考内容和逐字稿；长稿分句生成并检查每段 EOS 与有效音频，再统一采样率和实际时长。取消应终止本次受管子进程，不能调用会误取消其他任务的全局服务接口。

上游源码还需补两项校验：音色读取不会重新核对注册时的模型 fingerprint；达到生成 token 上限可能返回截短 WAV。适配器应验证参考缓存版本，并把耗尽预算当作未完成，避免发布一段漏了结尾的“成功配音”。普通 HTTP 合成也不能依赖仅针对流式请求的取消端点。[音色读取](https://github.com/Edge0-AI/Audio8_TTS/blob/07e40f5d0b03fc473635ef378654bfb581027ac3/onnx_runtime/arktts_runtime/voices.py)、[推理](https://github.com/Edge0-AI/Audio8_TTS/blob/07e40f5d0b03fc473635ef378654bfb581027ac3/onnx_runtime/arktts_runtime/runtime.py)、[服务](https://github.com/Edge0-AI/Audio8_TTS/blob/07e40f5d0b03fc473635ef378654bfb581027ac3/onnx_runtime/arktts_runtime/service.py)

## 决定默认引擎前的对照

使用同一段本人普通话参考，分别生成正常口播、数字/日期/英文缩写、较长段落，以及带明确情绪的短句。分开记录“像本人”“中文韵律”“漏字/重复/句尾完整”“等待时间与失败率”。每个引擎保留实际 WAV 和完整参数；作者榜单、采样率、模型体积与一次成功发声都不能代替这组试听。

本次首版跑通了真实生成，不据此声称 Audio8 比现有 Qwen 更自然。

## 本次实现与实测进展

- 首版实验曾把 Audio8/Qwen 作为 Desktop provider 接入；已按用户要求移出主程序并迁入面板 native 工具。此前版本号和 Host 实测记录仅用于追溯，不代表当前迁移包已经完成安装验证。
- 初始化可按用户选定的模型、本人录音和逐字稿执行准备；专用短试听工具限制 120 字且只发布素材。缺录音时可以先完成引擎准备并保留具体待补项。
- 粗剪选段可经 `media.audio.extract` 提取 3–30 秒真实 WAV；源素材和成片不变。完整媒体任务的返回值中不包含 Host 路径。
- 目前初始化支持 Apple Silicon macOS，需要已有 uv、FFmpeg/ffprobe；Python 3.12、固定依赖和约 1 GB 模型在私有目录准备，合计预计约 1.2 GB 下载。
- 使用本机 Tingting 合成测试音作为参考，完整 Host 链路已从带前后留白的源音频提取 8.3 秒参考，再生成 7.642375 秒中文 PCM WAV，48 kHz 单声道，生成阶段实测约 14.18 秒。此值仅为这次本机样本，不是普遍速度承诺。
- 实际 WAV：`artifacts/video-studio/audio8-host-validation/audio8-host-chinese.wav`；任务与测量记录：`artifacts/video-studio/audio8-host-validation/evidence.json`。另一个 provider 样本用 Whisper base 核查到完整末句“保留自然的停顿”，ASR 不能替代听感或相似度判断。

## 0.4.7 面板自管验证

- 实际调用路径为面板桥 → 通用 `PanelAppProcessService` → 随包 Node 工具 → Audio8 → 通用 `media.recording.*` 入库。主程序收到的 Audio8/Qwen 专用生成或安装调用为 **0**；检查器会对任何此类透传直接报错。
- 8.3 秒系统 Tingting 参考生成 8.153208 秒中文 WAV，48 kHz 单声道、782786 字节。包含参考传输与输出入库的生成阶段为 40.973 秒，整个验证为 49.756 秒；这是单次本机测量，不是模型推理速度或相似度结论。
- 仅授予一个测试 app-data 目录，批准一次 Node 执行；模型通过 APFS 复制复用，无重复下载。任务临时目录已清理，进程和服务已关闭。
- 输出与记录：`artifacts/video-studio/audio8-panel-native-validation/audio8-panel-native-chinese.wav`、同目录 `evidence.json`。面板普通工具启动有节流，参考准备和结果保存分别显示进度。
- 面板关闭后任务标记为中断，可重试；同工程内切主题或忙闲状态变化不会取消。任务表有条数与字节预算，较早的完成记录单独归档，命名音色仍可读取其试听凭据。

旧桌面需要通用 `media.assets.read` 和素材提取能力才能完成这条面板流程；这些能力不包含模型清单或推理代码。正在运行的应用不会被源码构建自动替换。
