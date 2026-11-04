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
`code-shell-serve --cwd …` 启动方式不变。`register` 只打开所选服务的 `/register` 网页。
无浏览器环境使用 `--no-open`，复制输出的地址到浏览器。不同 origin 分别保存账号，后续
命令须使用相同的 `--origin`。省略时使用产品默认账号服务。

密码通过不回显的交互提示输入，也可通过 `--password-stdin` 读取单行标准输入。没有
`--password` 参数；不要把密码放入命令行或 shell 历史。GitHub 登录独立于可选的远程
GitHub Link 连接，不会自动授予数据连接权限。

持久凭据分别保存于 macOS Keychain、Linux Secret Service（`secret-tool`）、Windows
当前用户 DPAPI 加密文件。凭据通过子进程标准输入传递，不进入进程参数列表；安全存储
不可用时明确失败，不回退到明文文件。

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
