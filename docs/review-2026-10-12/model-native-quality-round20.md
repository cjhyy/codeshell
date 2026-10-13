# 第二十轮：原生模型存储边界主审核对

Completed。主审独立阅读作者冻结源、最终31断言日志/JSON、清理与首次launch失败材料，核对生产窗口/偏好接线和maintained Electron隔离入口，并在latest工作区另执行一次同源portable native fixture。结论：补强R75/P3，不增加发现或Bun测试。作者31与主审31分别记录，不合并成一套62断言。

生产[createWindow webPreferences](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1370)未设置session/partition；[loadFile](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1498)加载同一个renderer文件。实际[useBucketOverrides初始化和effect](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useBucketOverrides.ts:30)、[saveOverrideMap](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/transcripts.ts:268)和[run模型lookup](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useRunController.ts:206)与第十八轮实际组件证据一致。BrowserPanel guest的独立分区不隔离主renderer偏好。

本轮owned Main没有加载产品Main/preload或React。prepareConfinedElectronFixture只生成但不执行其product入口；launch显式使用owned入口，私有userData/sessionData在app ready前设置并从实际Electron读回断言。Main加载maintained guard后拒绝raw net/tls及Node/utility child-start，Chromium webRequest只允许精确owned HTML、页面CSP禁止外部资源。parent保持maintained Playwright CDP启动通道，不导入Core/Host。guard attempts为空只说明没有尝试，未动态测试所有拒绝路径；hardcoded productLoaded=false字段须结合冻结源判断，不能独自当执行证明。

主审最终Main62446，两初始renderer62451/62452独立且均使用defaultSession、相同精确file URL，真实location.origin为file://。A写后B的实际storage event带A值、真实localStorage可读A，但B普通JS旧图未更新；B整图写后实际存储只剩B，真实reload A读B-only。fallback只是复制lookup表达式，不是实际hook在Electron运行。第十八轮两个React roots/MemoryStorage的actual ModelPill与hook补另一层证据，不能把两层拼写成完整App E2E或真实provider错用。

晚开C读最新A、加入B保留A，reload A仍得alpha；独立partition D写control不覆盖defaultSession。此控制支持旧已打开窗口条件，不把所有双窗、所有file路径或dev HTTP origin概括为已测。当前活A内存选择仍在，重开/重载才按缺失override回默认，可重新选择恢复；保持P3，不扩权限/goal或费用影响。

主审同源脚本SHA256为8cb93bb7c8f304501980dcf040036e3369a310888d1e82880d62144c10811f51，与作者一致。最终31独立Node断言、Completed，cleanup completed=true/failure=null、close code0/signal null、privateHOME已删除，7个Chromium请求仅owned file、无renderer错误。主审事后只检查本次Main和4个renderer PID均不存在，不增断言；outer maintained runner exit0。作者首次launch顶层await ready与Playwright loader互等，0断言诊断已保留，不是产品缺陷或成功次数。

本次native仅在latest Electron33.4.11/macOS运行；产品代码不参与该独立存储contract，重复到旧checkout不能额外证明旧App。本项加入时通用Bun为79文件236测试、本项新增0；同轮随后Goal新增的80/240总数见主报告。没有实际worker、模型、CLI、登录或operator应用状态。证据与执行分账见[原生报告](model-native-round20.md)和[结果JSON](validation/round20-model-native-results.json)。
