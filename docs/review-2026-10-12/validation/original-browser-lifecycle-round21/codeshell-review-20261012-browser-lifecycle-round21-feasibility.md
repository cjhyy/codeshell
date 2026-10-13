# 第21轮 Browser 生命周期可行性预审

冻结基线 a66f4ef291f304ee4df9da8095a90671d9a8f140；首次核时 UTC 2026-10-11 22:36:55（SG06:36:55）。仅只读产品、/tmp 证据；截止 SG2026-10-12 11:00。

已读 CODESHELL.md、主审 README/flow-coverage、panels-round6、links-round8、download-round11，已有79项未发现 Browser Runtime idle Chrome 连接状态问题；R22/R23 是独立安装 Panel 项目上下文，R57 是后台 Bash 下载，不重复。

## 正式入口与排除

- BrowserPanel 283–314 每2秒通过 preload/Main 读取 built-in 与 Chrome status；Main index4324 起的 assertRendererSessionAccess 要求已知任务并限制 owner，再由4483–4510调用实际 ChromeBackend。
- 用户 Chrome按钮347–379：有granted/pairing时撤销，否则beginPairing；服务129–148建立短期配对，extension真实入口先grant独立tab并回pairing.grant，服务276–310校验code、URL、grantId及跨任务tab占用。
- built-in revoke/TTL/destroyed保留撤权marker，dispatch返回NEEDS_HUMAN，禁止静默回落到另一目标；旧grant/epoch队列被拒绝已有tests。Panel按状态撤销/授权且action失败toast可见。
- Chrome queued revoke/expire/disconnect/reconnect已有tests240–278，具体由实际action调用isCurrentGrant触发清理；不将已有阻断再算新缺陷。
- BrowserToolCard虽使用“已操作”summary，但ToolCardShell failed状态有error badge，展开可读结果/错误；未据单句summary构造新问题。

## 可行最小候选：idle Native断线仍显示“正在使用”

ChromeBackend.status150–173调用liveGrant550–564，仅TTL到期清grant；返回connected:false时仍返回granted，无error。实际ChromeNativeServer close166–174清client/拒绝pending，未通知Backend。extension service-worker65–75断线revokeAll，重连hello225–239也清grant；isCurrentGrant491–509明确将disconnected视为grant ended，因此不是断线仍可继续使用的设计。

BrowserPanel618–623依据granted显示实际文案（i18n/panels201）“Browser Runtime 正在使用已登录的 Chrome 标签：{title}”，未读connected；按钮575–580仅给撤销。无新hello、无browser动作、TTL未过时，正常2秒status轮询不消除矛盾。显式撤销→连接→extension新授权可恢复，动作时会正确阻断，暂只建议窄P3候选，非安全越权/永久故障。

最小fixture计划：实际ChromeBackend + 实际BrowserPanel/React/MiniDOM + actual preload及未改的Main status/begin/revoke回调；Native transport、窗口owner目录及Electron IPC为owned内存边界。正常从按钮生成code，再合法pairing.grant；idle transport断线后等实际轮询，断言DOM/实际status；对照显式撤销→新hello→按钮重新配对恢复，确认动作拒绝旧grant。不得打开Chrome/外站/账号或启动worker/model/CLI。

导入产品前使用maintained exact-origin guard并额外封net/tls/child_process，maintained runner隔离HOME。尚未执行；本页不计finding或测试通过。
