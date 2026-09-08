# 用 Node.js 部署个人 CodeShell Hub

需要为多个项目分配独立容器、文件和配置时，请使用 [项目沙箱部署](project-sandboxes.md)。本文保留默认的单工作区部署方式。

当前部署形态是单管理员、单 Workspace、一个独立 Worker。电脑和手机浏览器可登录远端 Hub，进行对话、审批、停止、历史管理、工作区文件预览/下载，以及模型、Skills、MCP 和 Link 管理。服务进程直接使用 Node.js，Bun 只用于安装依赖和构建；无需启动桌面 Electron。

**桌面端开启的 Web 与独立 Hub 已共用浏览器工作台和管理页面。** 桌面 Web 通过设备配对连接原来的 Desktop Worker；独立 Hub 通过管理员登录连接自己的 Worker。Electron 原生窗口选择远端 Hub 作为执行目标尚未实现。两种 Web 的实现与入口区别见 [共享 Web 工作台](todo/shared-web-workbench.md)。

本文描述当前源码构建后的能力。正在运行的旧进程和旧页面不会因修改源码自动升级：Hub 要重新构建并重启，桌面 Web 要重新构建 Desktop 的主进程及 mobile 页面并重启桌面应用。

本地验证后，可使用同一版本代码按 [Docker 部署说明](docker-deployment.md) 部署到其他机器；Docker 默认映射 8791 端口，可与原生服务的 8790 并行。

## 1. 安装与构建

准备 Node.js **22.12 或更新版本**、仓库声明的 Bun **1.3.11**，以及 Git。服务包运行时最低要求为 Node 20.10；这里采用更高版本以同时满足 Web 构建工具要求。Agent 要用到的项目工具（例如 Python、编译器、Git）也需要装在服务器上。

在仓库根目录执行：

```bash
# 只安装本次服务端构建相关的工作区及根构建工具，跳过桌面安装脚本
bun install --frozen-lockfile --ignore-scripts \
  --filter '@cjhyy/code-shell' \
  --filter '@cjhyy/code-shell-server' \
  --filter '@cjhyy/code-shell-link'
bun run build:server
```

`build:server` 按顺序构建 Link、Core、Coding、Web 和 Server，包含浏览器的 `packages/web/dist-app`。构建后保留整个安装目录及其 `node_modules`、工作区目录和符号链接；只拷贝 Server 的 `dist` 不足以运行。跨操作系统或 CPU 架构迁移时，在目标机器重新安装与构建。[Bun 工作区过滤与安装说明](https://bun.com/docs/pm/filter)。

构建后可以先运行本地部署验证：

```bash
bun run test:server-smoke
```

验证使用真实 Node 服务与 Core Worker，配合临时目录和本机模拟模型，检查管理员初始化、流式对话、工具审批、停止、重启后历史恢复及续聊。不会读取个人模型密钥，也不会调用外部模型服务。

## 2. 配置模型

可以先按第 3 节启动服务、创建管理员，再进入「设置 → 模型与连接」添加文本连接，填写服务商、模型 ID、接口地址和所需 API Key，并选择默认对话模型。界面支持编辑、删除、辅助模型选择及连接测试；删除被默认值引用的连接时，按提示先选择替代连接。测试会使用服务器上的真实凭证发送一次小型模型请求，可能产生费用，可主动取消；测试成功后再用一次实际对话验证工具和流式输出。

如需在启动前准备配置，也可以在**将交给 Agent 的 Workspace** 中创建 `.code-shell/settings.local.json`。这是模型配置，不是 Hub 登录密码：

```bash
mkdir -p /absolute/path/to/workspace/.code-shell
cp deploy/settings.example.json \
  /absolute/path/to/workspace/.code-shell/settings.local.json
chmod 600 /absolute/path/to/workspace/.code-shell/settings.local.json
```

编辑该文件，替换 `REPLACE_WITH_YOUR_API_KEY`、`REPLACE_WITH_YOUR_MODEL_ID`，以及需要使用的 `baseUrl`。模板使用内置 `openai` 目录项，适用于相应的 OpenAI 兼容文本接口；使用 Anthropic 等其他协议时，应把凭证和连接的 `catalogId` 一并改为对应内置目录项。

配置由三部分关联：`credentials[].id` 保存密钥，`modelConnections[].credentialId` 引用它，`defaults.text` 选择连接的 `id`。现有桌面配置中的这三个字段也可以迁移过来。不能仅设置 `OPENAI_API_KEY` 就期望 Worker 自动创建模型连接；JSON 中的 `${ENV_NAME}` 也不会自动展开。

`settings.local.json` 覆盖 Workspace 的 `.code-shell/settings.json`。让运行服务的系统用户能读写该 Workspace，并在该项目的 Git 忽略规则中排除本地配置，避免提交密钥。模型密钥保存在服务器配置文件中，界面只返回是否已配置；编辑时未替换的密钥保留。

Web 保存的模型、Skills 开关和 MCP 配置写入 Workspace 的本地层。任务运行期间会拒绝配置修改，空闲时调用与桌面端相同的配置热更新接口，保留登录、历史和后台命令；其他已登录页面会收到配置变更。默认对话模型用于随后发送的任务，包括现有会话的下一轮。手动编辑配置文件后仍建议重启服务。

没有可用文本连接时 HTTP 服务仍可健康，设置界面也可使用，但 Worker 无法开始对话。默认服务日志只保留运行元数据；排查配置问题可临时加 `--debug-logs` 查看 Worker 诊断，该模式可能含任务正文或工具答案，应只写入私有日志。

### 与桌面端共用什么

| 能力              | 共用部分                                                                            | 部署后的区别                                                              |
| ----------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Agent、模型与工具 | 同一个 Core 引擎、模型配置格式、审批协议                                            | 工具和命令在服务器运行                                                    |
| Skills            | 同一个扫描器、SKILL.md 格式、启用规则，以及提取到 Core 的文件管理和 GitHub 安装逻辑 | 扫描服务器系统用户及 Workspace 的目录，客户端文件不会自动上传             |
| MCP               | 同一份配置格式、Core MCP 客户端及工具权限语义                                       | 命令、网络连接和环境变量属于服务器，探测由 Hub 的临时客户端执行           |
| 配置              | 同一个 SettingsManager 与配置分层                                                   | Web 修改服务器 Workspace 的本地层，不修改浏览器所在电脑的桌面配置         |
| 浏览器工作台      | 同一个 `Workbench`、消息组件及模型、Skills、MCP、历史、文件、Link 页面              | Desktop 与 Hub 分别提供 controller，保留各自认证及传输协议                |
| 对话              | 共用 Core、流式状态处理及持久历史投影                                               | Desktop Web 使用原来的桌面 Worker；独立 Hub 使用自己的 Worker             |
| Link              | 同一个服务商目录、凭证管理服务、Core 验证器和 LinkAction                            | 凭证、CLI 登录与网络请求属于当前宿主的系统用户，不会从浏览器电脑迁移      |
| 系统集成          | 可复用纯展示和状态逻辑                                                              | 本机窗口、钥匙串、桌面 Panel Host 等需单独适配，尚未提供完整 Web 对等功能 |

### Skills 与 MCP

「Skills」列出服务器实际发现的条目，支持搜索、查看正文、启用/禁用。可以在界面创建项目 Skill、编辑其 `SKILL.md`、删除项目 Skill；可写范围限于 Workspace 的 `.code-shell/skills` 与 `.agents/skills`，新建和安装默认放在 `.code-shell/skills/<名称>/`。用户、插件及 Panel App 来源在这里只读，界面会说明来源和限制。插件关闭时，单独打开其中 Skill 不能绕过所属插件的禁用状态。

GitHub 安装先检查仓库并预览选中的 Skill，再安装固定提交中的完整目录，包括脚本和资源；后续可检查更新、查看目录变更并确认更新。当前使用公开 GitHub 接口，没有私有仓库授权入口。安装过程不运行 Skill 的脚本；Agent 使用它时仍在服务器执行相关操作。桌面端的用户级 Skills、插件文件及依赖程序需要另行安装或迁移到运行服务的系统用户下，仅复制模型配置不会迁移这些内容。

「设置 → MCP」支持新增、编辑、删除、启停连接，管理环境变量、认证请求头和工具允许/禁用列表。新增连接可选择本地命令（stdio）或 Streamable HTTP，已有 SSE 配置可以保留编辑。插件提供的启动命令和地址由插件管理，不能在此修改；界面可撤销本地覆盖、恢复继承配置。已保存的敏感值不会返回明文，修改命令或服务域名时会要求明确确认能否复用已有认证配置。

MCP「测试连接」会建立临时连接并列出工具，不调用工具；stdio 测试会实际启动所配置的服务端程序。测试可取消，结束后关闭临时连接。命令、依赖、环境变量和网络地址都按服务器环境解析；浏览器所在电脑安装的程序不会自动可用。当前探测支持 stdio 和 Streamable HTTP，已有 SSE 连接的运行能力与探测支持范围不同。

### Link 连接

侧栏「Link」管理 GitHub、GitLab 等服务的连接，与模型 API Key 和 MCP 配置分开。可以查看服务商与可用操作、验证并保存 token、重命名或断开连接、检查并绑定宿主上已登录的 CLI。Web 不安装 CLI，也不启动交互式 CLI 登录；需要 CLI 时，先在运行服务的系统用户环境中安装并登录对应程序。

GitHub/GitLab 的设备授权需要宿主分别设置 `CODESHELL_GITHUB_APP_CLIENT_ID` / `CODESHELL_GITLAB_OAUTH_CLIENT_ID`，且对应应用已启用所需的设备授权能力。界面显示授权地址和用户代码，支持等待、取消及授权状态查询；访问凭证由宿主保存，不返回浏览器。当前没有自动 OAuth 续期：显示授权过期后需要重新授权，Core 不会继续使用已过期的 OAuth token。这里使用服务商直接授权，没有另一个已部署的云端 Link Server。

新建连接保存在运行用户的 `$HOME/.code-shell/credentials.json`，这是用户级配置，同一系统用户下的 Workspace 共用；已有项目级 Link 可查看但在此只读。独立 Node 宿主使用权限为 `0600` 的本地凭证文件；Desktop 使用其原有系统加密适配。不要把桌面加密文件直接复制到 Linux 或 Docker 后当作可用凭证，应在目标宿主重新连接。

连接详情只返回状态、账号摘要和能力，不回显 token。并发编辑或删除使用版本校验，防止覆盖其他设备的修改。普通连接修改在空闲时保存；断开允许在任务运行中执行，以取消仍依赖该连接的 LinkAction。设备退出或撤销会取消该设备尚未完成的授权，写入前也会再次检查身份与版本。Link 操作仍受 Core 工具审批控制。

### 面板

侧栏「面板」支持从 GitHub 搜索、审阅安装、更新、绑定和打开面板。Desktop Web 与 Hub 共用管理页和运行服务，已接入续租、进程查找/启动/取消、独立 Agent Task、面板工具回调及受控目录下载；执行授权在可信父页面确认。具体方法以 `availableMethods` 为准，媒体、音频、Cookie、自动化和 PDF 等尚未完整接入。现有本机安装可以直接绑定到 Hub 工作区。完整范围及 Mimi 历史持久化限制见 [Web 面板](web-panels.md)。

## 对话、历史与文件

- 对话支持 Markdown、代码复制、表格、模型实际返回的思考内容折叠、工具结果和子任务展示；流式阶段优先显示文本，完成后渲染 Markdown。远程图片不会自动加载，工作区附件通过登录保护的文件接口打开。
- 历史可按标题或会话 ID 查找、重命名、归档/恢复，并导出 Markdown 或 JSON。归档保留原始记录；正在运行的会话需结束后归档或导出。
- 「文件」可浏览 Workspace、预览文本及常见图片、下载文件，也能从对话附件打开对应文件。该页面是只读浏览器；项目修改通过 Agent 工具完成。路径不能越出 Workspace，符号链接及敏感目录/文件会被过滤，例如 `.git`、`.env` 和本地配置；`.code-shell/attachments` 允许读取。
- 浏览器读取或导出的完整对话上限为 32 MiB，会话状态文件上限为 1 MiB。超过上限会显示明确错误，完整记录仍保留在服务器，需从备份中获取。
- 单附件上传上限 20 MiB，未发送的暂存附件 15 分钟后过期；文件下载上限 100 MiB，文本预览显示前 512 KiB，每个目录最多展示 500 项，并且最多扫描 4,096 项；截断时会提示。HTML 和 SVG 仅下载，不作为可执行页面内嵌。
- 切换会话保留本页面内尚未发送的草稿和附件，但它们不会跨页面刷新持久保存；刷新或关闭前会提示尚未发送的内容。已发送对话保存在 Worker 数据目录中。
- 刷新或短暂断网后，会合并已保存历史与当前运行的服务内存事件，避免重复消息。运行事件缓冲每会话最多 8 MiB 或 16,000 条，总计最多 64 MiB；超过上限会提示并退回已落盘历史。服务重启后保留历史，但不会自动继续被中断的任务，未落盘的输出也可能丢失。
- 慢设备的 WebSocket 发送队列也有独立上限：普通积压及大历史后的实时尾部各最多约 8 MiB，允许一个不超过 64 MiB 的历史帧，全体设备合计最多 128 MiB。超过上限会断开积压连接，浏览器自动重连并恢复历史，不会停止服务器正在运行的任务。

## 3. 启动与管理员初始化

```bash
node packages/server/dist/bin/code-shell-serve.js \
  --auth hub \
  --host 127.0.0.1 \
  --port 8790 \
  --cwd /absolute/path/to/workspace \
  --data-dir /absolute/path/to/codeshell-data
```

也可以使用 `bun run serve:server --cwd ... --data-dir ...`；该快捷命令执行的仍是 Node.js。省略 `--auth` 时默认使用 Hub 管理员认证。

首次启动在终端打印带 `#setup=` 的管理员初始化链接。通过该链接设置管理员登录信息，密码至少 12 个字符。初始化令牌只用于首次创建管理员，重启不会再次打印；需要时查看首次启动日志。登录后退出可撤销当前浏览器的登录 Session，也可以在设备管理中撤销其他设备。登录 Cookie 使用 HttpOnly、SameSite=Strict，HTTPS 地址下还会设置 Secure；HTTP 与 WebSocket 均校验认证和浏览器 Origin。不要把初始化链接转发给他人或写入共享文档。

在本机检查服务：

```bash
curl --fail http://127.0.0.1:8790/health
```

健康接口不要求登录，只表示 HTTP 服务存活；不会调用付费模型，也不代表模型凭证有效。第一次对话可验证模型、流式回复及工具审批。

服务器在远端、暂时没有域名时，可在自己的电脑建立 SSH 转发：

```bash
ssh -L 8790:127.0.0.1:8790 your-user@your-server
```

然后在本机打开初始化链接。默认地址为 `http://127.0.0.1:8790`，避免混用 `localhost` 与 `127.0.0.1`。使用域名或不同的对外地址时，按第 5 节配置公开 Origin。

## 4. Linux 后台运行

仓库附带 [`deploy/codeshell.service`](../deploy/codeshell.service)。示例约定如下，可按实际安装位置统一修改：

| 路径                        | 内容                               |
| --------------------------- | ---------------------------------- |
| `/opt/codeshell`            | 完成安装、构建的仓库，服务用户只读 |
| `/srv/codeshell-workspace`  | Agent 可读写的项目                 |
| `/var/lib/codeshell`        | Hub 持久数据                       |
| `/var/lib/codeshell/worker` | Worker 会话及运行数据              |
| `/etc/codeshell/server.env` | 可选服务环境配置                   |

先把前面构建好的仓库放到 `/opt/codeshell`，准备示例 Workspace；模型可预先写入配置，也可启动后在 Web 中添加。使用专用系统账号运行：

```bash
sudo useradd --system --user-group --home-dir /var/lib/codeshell \
  --shell /usr/sbin/nologin codeshell
sudo install -d -o codeshell -g codeshell -m 700 \
  /var/lib/codeshell /srv/codeshell-workspace
sudo install -d -m 755 /etc/codeshell
```

如果系统已有该账号，保留现有账号即可。确认 Workspace 里的项目文件和本地模型配置允许 `codeshell` 用户读写。用 `command -v node` 核对服务文件的 `/usr/bin/node`；如果 Node 安装在个人 home 中，先安装到服务可访问的系统位置。

```bash
sudo install -m 644 /opt/codeshell/deploy/codeshell.service \
  /etc/systemd/system/codeshell.service
sudo systemctl daemon-reload
sudo systemctl enable --now codeshell
sudo journalctl -u codeshell -n 50 --no-pager
```

最后一条命令可查看首次初始化链接。服务以非 root 用户运行，退出失败时自动重启；停止服务会同时清理 Worker 子进程。示例只允许写入持久数据和 Workspace，使用其他工作目录时同步修改 `--cwd` 和 `ReadWritePaths`。[systemd 文件系统隔离说明](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#ProtectSystem=)。

## 5. 公网 HTTPS（可选）

先将自己的域名解析到服务器，允许 Caddy 使用 80/443 端口，并安装 Caddy。编辑 [`deploy/Caddyfile`](../deploy/Caddyfile)，把 `codeshell.example.com` 换成真实域名；代理后端仍使用 loopback 的 `127.0.0.1:8790`。Caddy 负责证书和 HTTPS，同时支持 WebSocket 代理。[Caddy HTTPS 说明](https://caddyserver.com/docs/automatic-https)、[WebSocket 代理说明](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。

在 `/etc/codeshell/server.env` 写入与浏览器访问地址完全一致的公开 Origin：

```dotenv
CODE_SHELL_SERVE_PUBLIC_URL=https://codeshell.example.com
```

该值也可以通过 `--public-url https://codeshell.example.com` 传入。必须使用站点根地址，不能附带子路径。服务据此生成初始化链接、校验浏览器 Origin，并为 HTTPS 登录设置 Secure Cookie；只增加反向代理而不配置公开 URL 会导致认证或 WebSocket 连接失败。

首次管理员初始化之前完成此配置，然后安装 Caddy 配置并重启服务：

```bash
sudo install -m 644 /opt/codeshell/deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl restart codeshell
sudo journalctl -u codeshell -n 50 --no-pager
```

已有 Caddy 站点时，将 CodeShell 站点块合并到现有配置，保留原有站点。外部只需访问 80/443，8790 无需对公网开放。更换域名后使用新地址重新登录。如果在配置域名前已经启动过，但尚未初始化管理员，保留首次日志里的 `#setup=...` 片段，把前面的地址替换成新的 HTTPS Origin 后再打开。

## 6. 重启、升级与备份

```bash
# 查看日志与服务状态
sudo journalctl -u codeshell -f
sudo systemctl status codeshell

# 修改配置后的重启
sudo systemctl restart codeshell
```

备份时先停止服务，按实例的**实际路径**保存以下内容，再启动，保证它们来自一致时间点：

- `--data-dir`：Hub 账号、设备登录、Worker 会话和运行数据。
- Workspace：项目文件、项目 Skills、已发送附件和 `.code-shell/settings.local.json` 等项目配置。
- 运行服务的系统用户的 `$HOME/.code-shell`：用户级 `settings.json`、Link `credentials.json`、Skills、插件及其登记信息。使用 CLI 连接时，还需按相应 CLI 的规则保存其用户配置。如果这些文件已位于 `--data-dir` 内，不必重复归档；额外配置的 `CODE_SHELL_HOME` 或插件资源目录也应按实际位置保留。
- 部署配置和代码版本：systemd 服务文件、`/etc/codeshell/server.env`，以及使用 HTTPS 时的 Caddy 配置。

**`--data-dir` 不会移动 `$HOME`，也不会把用户级模型、Skills 和插件自动复制到其中。** 例如本机默认数据目录为 `~/.code-shell/serve`，只备份它会遗漏同级的 `settings.json` 和 `skills`。前面的 systemd 示例将服务用户 home 设为 `/var/lib/codeshell`，所以备份该目录也包含该用户的 `.code-shell`。

下面仅适用于前面的 systemd 示例；使用其他路径时替换对应参数，并补上位于这些目录之外的用户配置。备份目录必须位于所有被归档目录之外，不要放进 Workspace、数据目录或待备份的用户 home 中；使用尚不存在的归档文件名：

```bash
sudo install -d -m 700 /absolute/path/to/private-backup
sudo systemctl stop codeshell
sudo tar -C / -czf /absolute/path/to/private-backup/codeshell-backup.tgz \
  var/lib/codeshell srv/codeshell-workspace \
  etc/codeshell etc/systemd/system/codeshell.service
sudo chmod 600 /absolute/path/to/private-backup/codeshell-backup.tgz
sudo systemctl start codeshell
```

归档含密钥和登录数据，应仅允许运维者访问；如已部署 Caddy，另行保存其实际配置。备份命令失败时保留错误输出，确认归档完整后再升级。

恢复时先停止目标服务，使用空目录或独立实例，保留备份中的认证文件，避免覆盖另一实例的账号或混合会话。保持原数据目录、Workspace 和用户 home 的绝对路径及系统用户权限一致；会话按 Workspace 路径筛选，直接改目录名会使旧会话不再显示。恢复部署配置后检查登录、历史和一次对话，不需要重建管理员。

升级前停止服务并备份，用明确的 Git tag 或提交更新代码，重新执行第 1 节的安装与构建，再启动并检查 `/health`、登录、历史会话和一次对话。需要回退时使用之前的代码版本及对应备份。

### 丢失初始化链接或管理员密码

首先检查首次启动的受限日志。如果初始化链接和日志都丢失，或忘记管理员密码，拥有服务器文件管理权限的运维者可以重建认证文件。**此操作撤销所有旧设备登录，并要求重新创建管理员；Worker 会话和 Workspace 保留。**

按上面的 systemd 路径执行，备份文件名应使用一个尚不存在的名称：

```bash
sudo systemctl stop codeshell
sudo mv /var/lib/codeshell/hub/auth.json \
  /var/lib/codeshell/hub/auth.before-reset.json
sudo systemctl start codeshell
sudo journalctl -u codeshell -n 50 --no-pager
```

通过新打印的初始化链接创建管理员。自定义 `--data-dir` 时，对应文件是 `<data-dir>/hub/auth.json`；不要删除整个数据目录或 `worker` 目录。保管好移出的旧认证文件，不要把它恢复到正在使用新账号的服务中。

## 当前边界

- 同一个管理员可以在多个浏览器登录；这不是团队多用户隔离部署。Agent 的工具权限仍由 Core 审批策略控制。
- 两种 Web 共用对话、历史、文件、模型、Skills、MCP、面板和 Link 页面；独立 Hub 仍没有多 Workspace 切换、团队账号隔离、插件市场和完整原生 Panel SDK 的 Web 适配。Desktop Web 可选择桌面已知项目，不代表 Hub 已有 Workspace Registry。
- Link 目前属于一个宿主系统用户，多设备登录不构成账号隔离；桌面授权、CLI 登录和系统钥匙串不会自动迁移。OAuth 过期需重新授权。
- PWA 可安装并离线打开已缓存的页面外壳；对话、设置和文件操作仍需要连接服务器。容器或专用系统账号的文件访问边界由部署者配置，Web 文件列表的过滤规则不等同于 Agent 的系统沙箱。
- 旧式共享口令可显式使用 `--auth passcode --passcode <口令>`；它和 Hub 管理员账号是独立的访问模式，不是账号迁移或密码重置手段。
