# 第十八轮：上下文摘要取消独立质量核对

Completed。主审独立阅读作者3测试/82断言脚本、两个冻结快照最终日志，核对ChatView/MessageStream/App/RunController/preload/Core/LLMClientBase相关生产源码；审计新增执行0，未改产品。支持将C18-1作为**一个P3**收录，等本轮其余专项完成后统一编号。不得拆成“无取消”“30秒超时”“迟到目标”等多个发现。

## 正常入口和分级

实际ChatView选择模式使用hidden包住整个composer，普通Stop位于其中且依赖busy；MessageStream packaging期间退出按钮disabled，closeContextSelection也拒绝退出。fork不经过App send，实际Core exclusive操作也没有session_started/运行通知。即便假设busy=true，Stop仍在hidden祖先内。这不是直接调用disabled按钮或服务方法冒充用户操作。

主审核对App全局Escape只关palette/search、ChatView Escape处理slash/mention，Main菜单及palette没有另一个摘要Stop入口。用户仍能切换视图，不称整个应用卡死。现有选择退出只承诺退出选择，未宣称点击X取消摘要；缺陷是已经具备Core abort能力的长操作没有正常用户取消路径。有限等待/存储无损与恢复入口支持P3，无依据升级P2或永久hang。

Core ChatSession.runExclusive正确防止并行摘要，源busy/queue门禁正确；真实AgentServer agent/cancel可abort当前exclusive。fixture在ordinary busy/selection关闭时实际点可见Stop，证明普通按钮能够调用supplied onStop；该callback是最小preload.cancel替身，不是完整App RunController实验，不能反推摘要期间有可用Stop。

## 超时和模型边界

actual preload.forkSession使用默认30000ms rpc；timer只delete pending/reject。作者仅截获这个真实timer callback手动触发，没有实等30秒或修改生产常量；timeouts.length=1避免误读别的timer。真实Core signal未abort、exclusive仍busy；释owned provider后真实target落盘/回复，但preload pending已不存在，created callback为0。timer捕获只限同步rpc调用并立即恢复全局setTimeout，清理时清owned替代handle。

owned LLMClientBase createMessage覆盖仅内存等待/返回，不执行withRetry，不能表示真实SDK无限等待。生产默认timeout120000、retryMaxAttempts3，组合deadline max(2×timeout,120000)，当前默认每attempt240秒；OpenAI/Anthropic使用其重试信号，真实错误最终能恢复。多块summary可能多次请求，源码没有保证全部30秒内完成，足以支持生命周期窗口；未做模型自然时长/费用/网络实验，不量化发生频率或成本。

迟到target仍持久存在。完整App创建回调、catalog import、reload/恢复、SessionsView和Main均未动态运行，不能称历史被删、target永远不可达或正常搜索必能立即找到。正常完成会注册目标的App接线和已知磁盘import恢复只作源码依据；纯summary transfer没有普通message正文，全局全文搜索不是找回保证。

## 隔离、证据和去重

脚本先检查maintained guarded HOME，在Core/Host前安装exact dummy-loopback fetch/HTTP guard并deny directnet/tls，network计数每测试为0，没有监听或真实网络。Core真实AgentServer/ChatSessionManager/Engine/SessionManager和源/target磁盘，唯一provider名自行注册，所有文件位于owned temp/隔离HOME；Electron只mock IPC/contextBridge，actual preload原样导入。React MiniDOM正式handlers、真实ChatView/MessageStream；完整Main/worker/stdin/BrowserWindow是静态接线，没有真实Electron/CLI/模型。

afterEach unmount、释放owned await、await server.close/engine.dispose、清timer/listener/provider控制记录及owned目录；没有清理其他任务。作者首次失败是ready通知和中文Stop label的harness断言错误，已保留，最后两基线3/82 Completed且0fail/skip；不把失败数加入产品问题。源代码从cwd定位、没有临时worktree硬编码，可便携。

本项与R07外部CLI busy、R08Web错误协议、R14async question、R30终态拒写独立；R03/R41不确定聊天意图/草稿和R55旧导航也是别的边界。第十七轮context四正常控制仍成立，本轮正是在其明确未测的Desktop取消入口发现缺口，无互相矛盾。

建议提供专属operation取消与状态，保留source/operation身份直到真实终态，区分等待超时和后台仍运行；长操作不宜直接套短查询超时。设计cancel时保留generation/owner fence，不能让迟到取消中断已接替的普通run或把原选择强制激活。保留当前Coreexclusive/目标存在/range验证，避免以移除门禁解决UI反馈。

**Completed：支持单项P3，独立审计新增执行0。后续主审便携复制和运行收据需单独标记，不改本审计的0执行口径。**
