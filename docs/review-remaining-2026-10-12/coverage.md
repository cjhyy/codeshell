# 本轮补审覆盖与剩余验证边界

这是用户要求“剩下模块继续审查”后的补审台账。旧报告没有对应专项的模块，本轮都增加了源码流程审查、控制实验或安装后合同记录；**不表示逐行审完所有文件，或已验证所有设备、部署、外部服务和分支**。不把目录清单、测试依赖图、静态源码阅读混称为执行覆盖。

CodeShell 冻结基线 `62a58ac8`，Panel Apps 冻结基线 `aabba34c`。旧 86 项冻结在 `84740d56/a66f4ef2`，没有在本轮全部重跑；新旧报告不能直接相加作为当前 main 的缺陷数。

| 上轮缺口 | 本轮补充 | 仍需单独验收/深审 |
| --- | --- | --- |
| 当前 Desktop 账号/云登录 13 路径差异 | 全部变更 hunks及manager/http/IPC/renderer主链，权限、origin、generation与状态回包检查；未确认新缺陷。见 [Host](hosts.md)。 | 完整真实 Electron 账号登录/登出、服务不可用、跨窗口和真实 relay。 |
| Core LLM、请求/账本、hooks、子代理 | Anthropic 真实 SDK 的内存 SSE 失败/重试/用量，实际 TurnLoop/UsageLedger；双 SDK auth 缓存旋转；hook/agent seam控制。见 [Core](core.md)。 | 活跃流取消/黑洞 transport、全部 fallback/provider、实际 token 到期、磁盘账本恢复、完整 Engine 进程/子代理重启。Core 41 目录逐项深度见原报告台账，不称整个 Core 已逐行完成。 |
| Core 持久运行、operations、profile、memory、sources、composition | 实际RunManager/EngineRunner冷暖恢复、AuxiliaryPipeline并发dream与cadence落盘，90测试通过；其他关键主链及正常控制见 [Core生命周期](core-lifecycle.md)。 | 真实模型记忆提炼、完整多进程压力与每个资料解析器、所有激活和插件组合。 |
| Server project-runtime / relay / tunnel | manager/registry/locks/control/backup/proxy/Docker关键链和 relay 字节流/凭据轮换/静态部署，源码反证若干候选。见 [Host](hosts.md)。 | Docker运行、真实公网 relay/tunnel、反向代理、长期稳定性、生产恢复和多实例容量。 |
| Web Environment / PWA /采集/移动恢复 | environment菜单、SW缓存与升级逻辑、采集生命周期、upload/abort、socket/visibility主链。见 [Host](hosts.md)。 | 物理移动浏览器后台冻结、系统相机/麦克风权限、实际SW升级与离线安装；未启动真实采集。 |
| Desktop task inbox/logs/runs/subagents/media/独立浏览器 | 关键服务/动作/分页/归属/缓存及renderer主链；真实 owned TCP验证 Chrome退出挂起；原 13 路径以外的新账户关联也有记录。见 [Host](hosts.md)。 | 实际Chrome扩展安装与用户profile、全Electron窗口/OS事件、媒体真实Host/native组合。 |
| Coding LSP、external runtimes、quota/工具 | 实际 owned 协议子进程正常/退出/启动失败/忽略TERM、真实工具Notebook本地文件；quota/orchestrator/其余工具主链静态。见 [Coding/TUI/Chat](coding-tui-chat.md)。 | 真实 Codex/Claude/LSP安装、真实quota服务、OS进程组及完整coding工具矩阵。 |
| TUI | 实际 Ink + PTY 输入、Esc、Ctrl+C与raw恢复；main/repl/run/stream/exit主链静态。见 [Coding/TUI/Chat](coding-tui-chat.md)。 | IME、多行/缩放、SSH/SIGSTOP恢复、Windows控制台、真实语音/外部编辑器/模型回合、全部slash commands。 |
| Chat 各平台 | 12 adapter与gateway/inbox/delivery/config/reconnect/attachment主链；真实Telegram adapter+ownedHTTP、Slack/Ding callback+真实持久队列；全部其他账号用静态边界。见 [Coding/TUI/Chat](coding-tui-chat.md)。 | 真实12渠道的授权、SDK网络、限流/重试语义、QR登录和service install；没有给他人发消息。 |
| Link 独立包 | 全4生产文件及catalog测试，10provider/30action与Core注册合同一致。见 [Coding/TUI/Chat](coding-tui-chat.md)。 | 真实CLI/OAuth、网页授权指南当前有效性与所有外部provider权限配置。 |
| Pet 完整委派与生命周期 | delegate-work/profile/projection/long-task关键链和会话路由/收据/分段/消息工具；当前37份既有测试330通过。见 [Root](root-and-video-download.md)。 | 完整真实Host+模型委派、长任务跨进程/外部IM、未逐行阅读的disclosure/剩余长文件；测试通过不替代这些。 |
| Optimization Lab | 实际 Controller/Store/Lease 停止冷恢复、模块/queries/预算/runner/报告主链及既有纯控制。见 [Root](root-and-video-download.md)。 | 付费评估、真实worker崩溃、人工打分/采纳所有组合、跨实例与OS故障。默认关闭的实验功能。 |
| CDP 兼容包 | driver/keymap/scroll-state主链及既有控制；未新增确认缺陷。见 [Root](root-and-video-download.md)。 | 所有真实页面/DOM变化、设备输入和浏览器后端。兼容层不是当前维护中的生产fallback。 |
| Arena | context工具、provider/research/transitions与Host启用边界；实际自建Git对象读取失败。见 [Root](root-and-video-download.md)。 | 完整debate/planning/iterate模型多回合。私有保留，Host不加载。 |
| 根打包发行/SDK | 清洁构建后9tarball、47类型入口、45runtime入口及packed owner-auth/uploaded documents合同；发行脚本静态。见 [Root](root-and-video-download.md) 与 [收据](validation/packaging/receipt.json)。 | 真实npm发布、自动更新/回滚、Windows/Linux安装/签名/公证；未运行发布命令。 |
| 独立 Video Studio | 编辑/恢复/映射/evaluator/audio/export关键链；完整逐文件深度台账；1146通过4跳过，扩展原生67通过6超时，倒放边界对照。见 [Video Studio](video-studio.md)。 | 145/204文件未手读，依赖图152文件不表示行覆盖；实际MP4 picture导出6项超时仍未验收；全部真实模型/云同步/UI仍有缺口。 |
| 独立 Video Download | 保存/绑定/后台任务/结果库/查询/恢复/依赖刷新关键链；147既有测试；实际模块DOM下启动回执丢失正常失败对照。见 [Root](root-and-video-download.md)。 | 完整6600行app逐行、真实网站/Cookie/yt-dlp/FFmpeg/依赖安装/真实付费查询。 |
| 独立 Quant Lab / Job Hunt HQ | 账本/保存/导入/scope与任务主链、岗位/简历/面试/备份恢复；300 Node tests与16 standalone脚本。见 [Quant/Job](quant-job.md)。 | 全浏览器UI、真实行情/招聘/个人资料/账户、PDF/native音频/转写模型、全部状态组合。 |
| 独立 Design Studio | 真实app.js + DOM的索引文档打开/编辑/保存/回滚，模型/导出和布局控制，30唯一用例通过。见 [Design Studio](design.md)。 | 真实Host文件系统、多设备、系统字体/远程字体与完整绘图/触摸路径；具体fixture限制见专项。 |
| Panel共享SDK/打包 | shared select全文、5项真实headless UI控制，builder/discovery关键链与66项合同。Core/Host接口的媒体/资源/task审查分别见Host与业务报告。 | 实际安装升级/回滚、所有Host API组合、系统辅助功能与跨版本客户端。 |

## 不能算作已通过的项目

- Video Studio 扩展原生套件 **6 项画面渲染测试失败（30 秒超时）**，没有环境正常对照支持将其定为产品缺陷；同样不能称全套通过。
- 部分命令/权限方向的复现被平台内容检查中止，提示“可能涉及网络安全风险”。停止后没有改换工具重试；仅保留已经完成的静态/seam证据与未验证附录。这些方向没有获得完整动态审计覆盖。
- 开发依赖安装成功、清洁构建成功、单元控制通过，与真正外部账号/设备/部署验收是不同证据。没有为填覆盖表而启动真实付费模型或联系他人。
- 所有报告只记录问题和验收建议，未修复产品。不宣称找到所有可能缺陷。
