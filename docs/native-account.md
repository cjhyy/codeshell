# TUI 与 serve 的可选账号登录

本地聊天、工具和本地项目不要求账号。TUI 与 headless serve 复用 Desktop 的原生账号管理器，
提供同样的登录、令牌刷新、退出及账号功能读取；账号登录不会改变 Hub 管理员、passcode、
项目授权或自动登记设备中继，也不会上传本地数据。

```sh
code-shell account register --origin https://accounts.example
code-shell account login --origin https://accounts.example --username member
code-shell account login --origin https://accounts.example --github
code-shell account status --origin https://accounts.example
code-shell account features --origin https://accounts.example
code-shell account links --origin https://accounts.example
code-shell account logout --origin https://accounts.example
```

`code-shell-serve account …` 支持相同命令。账号管理子命令执行后返回，不启动 Hub；正常的
`code-shell-serve --cwd …` 启动方式不变。`register` 先读取账号服务声明的注册页面：新服务打开 `/register`，旧服务回退到
`/api/v1/account/manage` 注册门户。路由只接受固定值，不信任服务下发的任意 URL。
无浏览器环境使用 `--no-open`，复制输出的地址到浏览器。不同 origin 分别保存账号，后续
命令须使用相同的 `--origin`。省略时使用产品默认账号服务。

密码通过不回显的交互提示输入，也可通过 `--password-stdin` 读取单行标准输入。没有
`--password` 参数；不要把密码放入命令行或 shell 历史。GitHub 登录独立于可选的远程
GitHub Link 连接，不会自动授予数据连接权限。

持久凭据分别保存于 macOS Keychain、Linux Secret Service（`secret-tool`）、Windows
当前用户 DPAPI 加密文件。凭据通过子进程标准输入传递，不进入进程参数列表；安全存储
不可用时明确失败，不回退到明文文件。

同一系统用户、同一 origin 的持久账号命令共享跨进程锁；从读取凭据到刷新、保存、注销和
管理器释放均在锁内执行，避免两个进程重用同一枚刷新令牌或用旧状态覆盖新登录。等待使用
异步重试，最多 5 秒；登录提示或浏览器授权尚未结束时，其他命令可稍后重试。不同 origin、
网页注册和 `--memory` 会话互不阻塞。锁不根据时间自动抢占；进程崩溃可能留下空锁目录。
恢复时须先确认该 origin 的所有账号命令已停止，再删除错误信息所列目录中的空 `.lock`
子目录；不要删除账号存储文件。锁位于 `~/.code-shell/accounts/locks/`，仅包含互斥目录，
不存放令牌。正常成功或失败会在 `finally` 中释放锁。

在没有系统安全存储的交互终端中可以使用：

```sh
code-shell account login --memory --origin https://accounts.example --username member
```

该命令保持当前进程中的账号控制台，可执行 `status`、`features`、`links`、`register`、`logout`、
`exit`。正常退出时注销临时会话；没有凭据落盘。它不把账号状态传给另外启动的进程，
也不能用于一次性非交互 stdin 登录。进程被强制终止时无法保证通知服务器注销，服务端
仍执行原有会话到期规则。

`features` 读取 `/status` 与登录后的 `/overview`，仅输出公开身份与经过白名单投影的
功能状态，不输出 token。此版 CLI 已接入 `links.remote` 的账号连接列表读取（`links`），
只有服务端同时提供账号 Link 管理时才显示可用；电脑派发、手机中继、云项目等尚无 CLI
操作入口的功能统一显示 `hidden`，不会把服务端 `enabled` 当作本机 `ready`。旧服务没有功能清单时从旧能力字段推导；尚未实现的功能保持
关闭。界面功能状态不能替代各服务接口的鉴权。

登录完成后即输出成功的账号状态；若随后读取功能状态失败，会显示重试提示并保留登录。
`--memory` 控制台也会继续运行，可用 `features` 重试，不会因一次能力查询失败就注销。
