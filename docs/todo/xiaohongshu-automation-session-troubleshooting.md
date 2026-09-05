# 小红书自动回复：Session 与登录态排查

## 结论

小红书是单点登录场景，自动回复任务不能在每次触发时重新注入凭证。任务必须绑定到一个已经登录小红书的 CodeShell 对话，并在触发时续接该对话；登录失效后应停止并提示用户人工恢复，不能通过重复注入维持登录。

## 已观察到的现象

- 定时任务触发后出现新的自动化 Session。
- 新 Session 没有原会话中的小红书页面和登录上下文，因而无法可靠读取或回复消息。
- 仅修改自动化提示词，或者要求每轮重新注入凭证，不能解决 Session 隔离问题。
- 反复注入会覆盖浏览器当前 Cookie；对单点登录服务还可能使其他会话失效。

## 根因

CodeShell 自动化有两条不同的执行路径：

1. `resumeSessionId` 为空：进入独立自动化路径，每次触发创建新的 headless Engine Session。
2. `resumeSessionId` 有值：进入续接路径，通过 `agent/run` 将定时提示作为新用户消息送入指定的既有 Session。

分支逻辑位于 `packages/desktop/src/main/automation-host.ts` 的 `makeCronRunnerWithResume`。桌面端在 `packages/desktop/src/main/index.ts` 中使用 `injectResumeTurn` 投递续接任务，并通过 `requireExisting: true` 防止目标 Session 被删除后静默创建空 Session。

因此，本次问题不是小红书页面地址或回复提示词错误，而是自动任务未稳定走 `resumeSessionId` 分支。

## 正确运行方式

1. 用户在一个固定 CodeShell Session 中人工完成小红书登录。
2. 创建自动化时写入该 Session 的 `resumeSessionId`。
3. 每轮触发只续接固定 Session，并打开或刷新消息页；不要调用凭证注入。
4. 只把带发送者身份的对方消息视为入站消息；不要回复本账号的出站消息。
5. 群聊回复应引用或 `@` 原发送者，避免脱离上下文。
6. 每条自动回复标注“由 CodeShell 自动回复”。
7. 页面要求登录、验证码或人工验证时停止发送并报告阻塞。

## 验收检查

- 自动任务记录中的 `resumeSessionId` 等于目标已登录 Session。
- 连续触发两次后，侧边栏不新增独立自动化 Session。
- 两次触发均使用同一个小红书登录态，期间没有调用 `InjectCredential`。
- 删除目标 Session 后，任务被自动停止并显示“续接的对话已被删除”。
- 登录失效时不发送消息、不绕过验证，并给出明确提示。

## Cookie 生命周期

- 固定 Session 使用持久化浏览器 profile。小红书响应中的 `Set-Cookie`、过期时间延长和 token 轮换由 Chromium 正常写入该 profile，后续轮询会继续使用更新后的 Cookie。
- 每条 Cookie 凭证提供“自动更新 Cookie”开关，默认关闭。明确恢复到内置浏览器后，会绑定该凭证与 Electron Session；池中的后台页面与可见页面共用该 partition，因此两者的 Cookie 更新都能被同一监听捕获。
- 同 Session 的账号恢复、同凭证的跨 Session 迁移按队列执行。注入前解除旧绑定，只有完整恢复成功才建立新绑定；部分失败不会把混合账号快照写回凭证。同一 Session 中不相关域的凭证可以同时更新。
- 恢复前与恢复后均重读原存储层，防止排队期间的新登录、删除或开关变化被忽略。恢复保留 `hostOnly` 属性，避免把主机 Cookie 扩大为域 Cookie 并产生同名重复项；清空模式前先校验整个输入。
- 回写使用绑定时的精确 user/project 层，并在凭证库文件锁内检查开关与原始 secret，再更新 secret。项目同名覆盖、删除、重新登录或其他进程的新版本不会被旧快照覆盖。Cookie 顺序变化不会触发重复写盘。
- 删除事件会取消排队快照，并使在途旧读取失效。缺失初始 Cookie 标识的快照会跳过回写，防止退出后仅剩统计 Cookie 覆盖凭证。这是保守完整性检查：合法删除或改名也可能需要重新绑定；网站使用同名访客 token 时，仅靠通用 Cookie 事件无法确定登录健康状态。
- 开关关闭时暂停抓取；重新开启已有绑定时读取当前快照，无需重复注入。应用退出前会尝试保存最后的排队更新，最多等待 2 秒，然后释放监听。
- 单凭证单监听约束的是凭证回写来源，不会关闭旧浏览器，也不能保证服务端单点登录一直有效。小红书自动回复仍应复用固定 profile，不应每轮执行 `InjectCredential`。
- 当前绑定保存在进程内；浏览器池释放/重建同 partition 的页面不会丢绑定，但完整重启应用后仍需明确建立绑定。当前自动回写仅覆盖 Electron 内置浏览器，独立 Playwright 使用自身持久化 profile，尚未回写此凭证库。
- 如果固定 profile 已被服务端注销、要求验证码或需要人工验证，任务应停止并报告；不能自动回灌旧快照循环重试。

## 补充说明

独立自动化路径虽然为同一任务配置了稳定的浏览器 profile（`automation:<jobId>`），但它仍会为每次触发建立新的 Agent Session。对于要求复用原对话、原页面和单点登录状态的小红书自动回复，应明确使用续接模式，而不是依赖独立自动化 profile 或重复注入 Cookie。

Quick Chat 使用 `browser:qchat:*` 临时 partition，普通任务使用 `persist:browser:*`。浏览器挂载与凭证服务共用同一校验规则；明确传入非法 partition 时拒绝访问，避免悄悄切到全局登录态。

## 本地验证（2026-09-06）

- 凭证库、回写、恢复队列、Cookie 服务及分区的 81 项回归测试通过。
- 全工作区类型检查、修改文件的 ESLint 和格式检查通过。
- `bun run --cwd packages/desktop smoke:cookie-sync` 通过真实 Electron 事件验证轮换保存、profile 复用、暂停/恢复、不完整登出快照保护、退出排空。该测试使用临时目录及合成 Cookie，不访问小红书或使用真实凭证。
