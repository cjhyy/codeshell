# 第十六轮：Link 授权取消、重新尝试与项目切换恢复

冻结工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`，HEAD `a66f4ef291f304ee4df9da8095a90671d9a8f140`。已读 `CODESHELL.md`、主报告当前 R01–R68、flow-coverage 与 links-round8.md，按 R38/R42/R43 去重。

本轮 **没有确认新的正式问题**。新增便携证据为 **1 文件 / 5 测试 / 73 expect / 0 fail / 0 skip / Completed Bun shard**，验证实际授权组件与真实 Host 服务组合的正常保护和恢复。本次未修改产品、主报告、goal 或 heartbeat，未创建子代理，未 build/clean；没有实际浏览器/OAuth 账号、CLI、模型、worker 或提供方调用。

## 新增动态证据

[link-recovery.test.tsx](reproductions/link-recovery-round16/link-recovery.test.tsx) / [最终日志](reproductions/link-recovery-round16/link-recovery.test.tsx.log)。所有路径从 `process.cwd()` 解析，脚本可便携复制；只依赖冻结工作区已有构建产物与测试依赖，没有重新构建。

实际组合为：`LinkConnectionDialog` → **源码** `LinkAuthorizationController` + `LinkAuthorizationStepView` → 可控 `window.codeshell.links` transport → 实际 `createNativeLinkAuthorizationManager` → 实际 `createLinkService` → 实际 `CredentialStore`/`PlaintextCipher` 写入 owned 临时用户存储。装饰性 Dialog 容器替换为普通 MiniDOM 容器，表单、输入、提交、取消、重试、完成反馈仍为实际组件。提供方 token validation 与远端 catalog 为明确接口替身；OAuth open 接口只产生内存句柄，无真实窗口。

| 新用例 | 已验证结果 |
| --- | --- |
| 启动回包尚未到达时关闭真实弹窗 | 实际取消按钮卸载 UI；native manager 通过初始 request ID 取消原授权；迟到 pending job 不再发布，存储保持空。重新挂载生成新 request ID，显式输入后可正常保存且回调一次。 |
| begin transport 明确失败后重新授权 | 实际 alert 显示错误，未写存储；点击“重新授权”创建新 attempt。输入本身不验证/保存；同一 tick 连调实际 form submit 两次，只有一次 respond/validation/持久化。 |
| 实际提交已经持久化，但回包被 transport 丢弃 | UI 显示 transport 错误且清除一次性 secret 表单；已有 store 仅一条；控制器按实际默认 4 秒重试间隔 authorizationGet 状态查询后回到 connected，respond/validation 均仍一次，未自动重放 secret。 |
| 按正式 cwd key 换项目，旧 token validation 仍 pending | 旧弹窗 cleanup 取消旧 job，新弹窗的 secret 为空；释放旧 validation 后，无旧 success callback、无旧持久化，旧 job 为 cancelled。新项目显式输入再提交可保存。两个项目 context 共用同一个 owned 用户 store，未人为建立每项目独立账户仓库。 |
| OAuth 窗口分发仍 pending 时取消，再尝试 | 实际 manager 拒绝异 owner 取消，合法 owner 取消立即 abort；迟到内存 window handle 正好关闭一次，旧 callback 返回 false 且不换 token。新 request 可再次开始 pending OAuth，再取消后第二句柄关闭，存储保持空。 |

第 1/2/3/4 项主要证据在脚本 110–155；第 5 项在 157–181。最终日志五项均通过。此次失败与恢复均为可控交付顺序，没有把任意人工旧 snapshot 覆盖当成生产可达缺陷。

## 正式 UI 接线与生命周期保护

- 主页面 [App.tsx:2417](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:2417) 将当前项目 path 传给 CredentialsPage；[CredentialsPage.tsx:178](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/credentials/CredentialsPage.tsx:178) 在 Link tab 挂 LinkTab，离开 tab/page 会卸载该子树。
- 本地授权由 [LinkTab.tsx:659](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/credentials/LinkTab.tsx:659) 设置 localDialog；[LinkTab.tsx:964](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/credentials/LinkTab.tsx:964) 的实际 dialog key 含 cwd/provider/method/connection ID，切项目或连接会重挂。[RemoteLinkSection.tsx:484](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/credentials/RemoteLinkSection.tsx:484) 的远端同样含 cwd/provider/connection ID。不能用“同一实例直接改 input 却不换 key”的不正式 seam 推断旧 secret 跨连接保留。
- [LinkConnectionDialog.tsx:50](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/credentials/LinkConnectionDialog.tsx:50) 保存 request ID，57–64 将 cwd 与每次 request 绑定到 transport。89–105 使用 controller-specific effect 世代，真实 detach 时 dispose，并补 cancel 尚未知 job ID 的 startup request。StrictMode 同步 effect 重挂被明确保留，不能当真实卸载。
- [LinkConnectionDialog.tsx:138](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/credentials/LinkConnectionDialog.tsx:138) 切认证模式先等待 cancel，仍 pending 时不开始下一种方式；150–153 的关闭先发 cancel 并立即 onClose，不等待远端取消结束才关 UI。376–379 在 terminal 或 begin error 后提供显式“重新授权”。本轮动态未覆盖模式切换和 CLI 安装，相关保护只作静态核对。
- [LinkConnectionDialog.tsx:106](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/credentials/LinkConnectionDialog.tsx:106) 仅在 connected 且有持久 connection 时回调，并以 authorization ID 去重；298–308 将 controller/transport 错误可见呈现。
- [link-authorization-view.tsx:249](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/src/link-authorization-view.tsx:249) 提交才采集 token，255 立即清一次性字段，未提交输入不上传。此次验证了不确定回包后的自动 authorizationGet 状态查询，不能把清字段解释为秘密自动重放或自动恢复原 token 草稿。
- [link-authorization.ts:128](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/src/link-authorization.ts:128) stop 递增世代；142–150 在接纳前拒绝旧 generation、错误 provider/method；204–227 的迟到 begin 仅取消、不发布。230–258 响应路径先占 busy，并对不确定写入安排 GET，不重放 respond。263–289 cancel 同样换代，300–306 dispose 清监听并取消。

## Main、服务和持久归属

- 正式 [preload:1483](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/index.ts:1483) 将 cwd/request ID/response 传入授权 IPC。实际 [remote-link-ipc.ts:35](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/remote-link-ipc.ts:35) 要求 live Main window/main frame，先解析注册项目 cwd，await 后再次验证；43–87 建立 window owner 并按 cwd 建 manager。主 frame 导航或 destroyed 在 47–63 close 全部该 owner managers，89–95 的操作 context 在异步恢复后也重查 owner 和项目权威。
- [link-authorization-manager.ts:61](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/link-authorization-manager.ts:61) 先校验 owner；63–71 接纳前已取消 request 会直接终止。86–101 为 service 传取消感知 context；40–47 finish 标记后删 flow、clear timer、abort、关闭句柄；147 处理迟到 open handle。184–201 取消支持 request/job ID，异 owner 被拒绝；210–225 owner/manager 退役使所有 flow 无效。
- [service.ts:997](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/links/service.ts:997) 在 provider validation 完成后重查 context、job pending；1042 再 check，1057–1071 commit 前再设 beforeCommit。实际 [service.ts:569](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/links/service.ts:569) 在写入之前调用 beforeCommit，再做 CAS；取消发生于 validation await 期间不会因 validation 成功而恢复旧授权。1469–1486 的 cancel 将 interactive job 终止并 abort。
- Link connection 持久化目标是 **user scope**（service.ts:528、572），不是点击时的任意项目文件。项目 cwd 影响服务权限/可见上下文，不能把本轮共享 user store 的新连接在其他项目可见称为串写。525–529 和470–473 拒绝 project-scoped 只读 connection 被修改，并以 expectedRevision/CAS 保护现有 user connection。
- [service.ts:490](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/links/service.ts:490) 的默认连接 ID 是稳定 provider/method ID，**已有 ID + expectedRevision=null 会返回 conflict**，不是无条件覆盖。这里不能把 R42 的 Cookie 新账号名称碰撞直接移植为 Link 覆盖旧账号。重新授权的正式 UI 传现有 connection ID/revision，不能假设“新建第二个同 provider/method 账号”已经属于该默认入口的多账号能力。
- 远端 disconnect 在 [service.ts:731](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/links/service.ts:731) 先禁用本地使用；外部 revoke 失败返回 unavailable 并保留 disabled record，成功才 CAS 删除。本文没有真实远端撤销实验，既有 links-round8 结论继续有效。

## 去重与没有扩大结论的部分

- **R38** 是配对设备 HTTP logout 卡住导致本地退出等待。这里 LinkConnectionDialog 关闭立即 onClose，cleanup 持有 owner/request 并取消；本轮不能改写或宣称修复 R38。
- **R42** 是 Cookie 新增 ID 碰撞无条件覆盖；Link 的 expectedRevision=null conflict 和 CAS 是独立正常保护，没有新覆写证据。
- **R43** 是 TokenTab 的实际存储拒写无可见错误。本轮实际 Link 授权对 begin/响应 transport 错误可见，且对已提交但丢回包能只读恢复；未执行真实 filesystem 拒写，不能用它推翻 TokenTab 既有发现。
- useRemoteLinkSnapshot 仍只按 cwd/生命周期换代，没有每次 reload 单独序号（RemoteLinkSection.tsx:17–49）；Main snapshot 在远端 catalog await 后构建当前事实（remote-link-ipc.ts:99–103）。维持第八轮边界：任意延迟手工旧 snapshot 不是新的生产反例，本文没有新增这一疑点。
- LinkTab 的本地 credentials load、legacy mcpOAuth.login/refresh/logout 与 CLI install 不是此次动态组合的全部覆盖对象。对 legacy McpOAuthService 的 generation/singleflight 只读见 mcp-oauth-service.ts:371–389；未运行系统 OAuth/browser/CLI 安装，不能写“所有提供方和所有 OAuth UI 均端到端正常”。

## 执行、隔离与计数

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/review-2026-10-12/reproductions/link-recovery-round16/link-recovery.test.tsx
```

最终 **5 pass / 73 expect / 0 fail / 0 skip / Completed**。只计最终集合一次；`link-recovery.initial-pass.log` 是补实同 tick 双 submit 前的通过诊断，不累计。开发保留三个 harness 失败日志：第一次 mock web entry 漏导出 i18n 依赖，第二次 /tmp bare workspace entry 无法解析，第三次 retry 按钮中文选择器用错；均已修正，是 fixture 错误而非产品发现。

脚本入口拒绝非 guarded isolated HOME；Core/Host 导入之前安装 exact-origin `http://127.0.0.1:9` HTTP/fetch guard，并拒绝 direct net/tls。没有连接该端口，也没有启动本地 HTTP 服务；所有提供方数据来自注入的 validation/catalog 函数。这个 guard 不是 OS sandbox，不声称子进程网络隔离；本轮没有创建 agent/helper 子进程。唯一内存 OAuth open 两次，没有实际原生窗口/账号。

文件仅写 owned 临时目录并在 finally/afterEach 清理；每用例确认 direct network unexpected 计数为零。`node_modules` 是 /tmp 目录内指向冻结依赖的 symlink，不应提交。最终 git status 仅 root 所有的 `?? docs/review-2026-10-12/`，产品未改。

主要 dialog/LinkTab/controller/StepView/native manager/remote IPC/server service 在 `git diff 84740d56..HEAD -- <上述路径>` 输出为空。这是关键源码两基线一致的静态事实；本轮动态只执行 latest a66f，没有把它包装为两基线都执行。第八轮与既有 baseline 通过收据不重复累计到本轮 5 测试/73 断言。

## 主审便携复核

主审已把最终脚本复制到初始84740与新a66f冻结快照，分别通过项目规定的guarded runner；两份完成日志及metadata均已归档。本附录前文的“原始只在latest运行”仅描述专项作者原始实验，不能覆盖这次独立双基线复跑。没有产品改动、build/clean、真实模型/账号或额外完整Electron实验。
本专项1文件5测试73个Bun expect，两基线分别0fail/skip、Completed，正式新增0。
