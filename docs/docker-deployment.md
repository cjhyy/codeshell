# 用 Docker 部署个人 CodeShell Hub

先用 [Node.js 本地部署](deployment.md) 验证模型和浏览器流程，再把同一版本代码放到装有 Docker Engine 和 Docker Compose v2 的机器上。Docker 镜像内包含 Web 页面、Hub 和 Worker；运行进程使用 Node.js 22 和非 root 用户，Bun 1.3.11 只参与构建。

默认映射 `http://127.0.0.1:8791`，可以和本机 Node 的 `8790` 同时运行。容器中固定监听 `0.0.0.0:8790`，只向宿主机 loopback 发布端口。它与 Desktop 开启的 Web 共用工作台页面，但采用自己的管理员登录、Worker 和持久目录；不是连接到宿主机上正在运行的 Electron。

同一浏览器并行使用多个 Hub 时，请为它们使用不同主机名（例如原生访问 `127.0.0.1:8790`，Docker 访问 `localhost:8791`），或使用不同浏览器资料。浏览器 Cookie 不按端口隔离，只改端口会相互覆盖登录状态，账号和持久数据仍独立。为每个实例选定地址后，初始化与后续访问保持该地址一致；已设置公开 Origin 时，也要使用对应的地址。

## 1. 准备模型配置并启动

在仓库根目录执行：

```bash
cp deploy/settings.example.json deploy/settings.local.json
chmod 600 deploy/settings.local.json
```

编辑 `deploy/settings.local.json`，按 [模型配置说明](deployment.md#2-配置模型) 填入密钥、模型 ID 和接口地址。也可以把文件内容改为 `{}`，先启动并登录，再在 Web 中添加模型。Compose 要求这份文件实际存在且可读；留着模板中的占位密钥不能完成真实对话。

该文件只读挂载到 `/data/home/.code-shell/settings.json`，作为服务器用户的默认配置，不会进入镜像，也不会遮住项目原有的 `.code-shell/settings.json`。Web 中保存的模型、Skills 开关和 MCP 设置写入 `/workspace/.code-shell/settings.local.json`，覆盖默认值，不直接改写绑定文件。不要把本机 `node_modules`、个人 `.code-shell` 或数据目录复制进镜像；构建上下文只允许必要源码和清单进入，镜像自己安装对应平台的依赖。[Docker 构建上下文说明](https://docs.docker.com/build/concepts/context/#dockerignore-files)。

Linux 的绑定文件保留宿主机权限，容器用户是 UID/GID `1000:1000`。若配置文件不属于 UID 1000，保持文件私有并授权给容器用户，例如只调整这份配置文件：

```bash
sudo chown 1000:1000 deploy/settings.local.json
sudo chmod 600 deploy/settings.local.json
```

Docker Desktop 的文件共享方式可能不同；先执行下面的配置读取检查。不要通过把密钥文件改为全员可读来解决权限问题。

```bash
docker compose config --quiet
docker compose build
# 不打印密钥，只验证容器用户能读取配置和写入两个持久目录
docker compose run --rm --no-deps --entrypoint node hub -e \
  'const fs=require("node:fs"); JSON.parse(fs.readFileSync("/data/home/.code-shell/settings.json","utf8")); for(const p of ["/workspace","/data"])fs.accessSync(p,fs.constants.W_OK); console.log("Configuration and volume permissions OK")'
docker compose up -d
docker compose logs --tail=50 hub
```

首次日志会打印带 `#setup=` 的管理员初始化链接。用该链接创建管理员，密码至少 12 个字符。该链接只在首次启动时打印，应保存在私有位置。然后验证：

```bash
curl --fail http://127.0.0.1:8791/health
docker compose ps
```

打开初始化链接，配置模型后发送一次对话并验证工具审批。健康检查只确认 HTTP 服务存活；Web 中的模型连接测试会发送小型真实请求，可能产生费用。镜像自带 Node、npm、Git、SSH 客户端、Python 3 和 ripgrep，其他编译器、模型 CLI 或项目依赖需要按项目补充，不会从宿主机自动获得。

可在仓库 `.env` 中调整端口和配置文件位置。该文件也不会进入镜像：

```dotenv
CODESHELL_HTTP_PORT=8791
CODESHELL_MODEL_SETTINGS=/absolute/path/to/private/settings.local.json
```

`CODESHELL_HTTP_PORT` 改为其他端口时，默认初始化链接自动使用对应的 `127.0.0.1` 地址。始终用初始化链接中的同一个 Origin 访问，避免混用 `localhost` 与 `127.0.0.1`。

## 2. 工作目录和持久化

| 容器路径                                     | 默认存储              | 内容                                           |
| -------------------------------------------- | --------------------- | ---------------------------------------------- |
| `/data`                                      | `hub-data` 命名卷     | 账号、设备登录、上传文件和 `/data/worker` 会话 |
| `/data/home`                                 | 与 `/data` 一起持久化 | 容器用户 home，`/home/node` 指向这里           |
| `/data/home/.code-shell/credentials.json`    | `hub-data` 命名卷     | Web 保存的用户级 Link 连接                     |
| `/data/home/.code-shell/panel-apps`          | `hub-data` 命名卷     | GitHub 安装的面板包与安装索引                  |
| `/data/panel-app-storage`                   | `hub-data` 命名卷     | 面板按项目隔离的持久键值存储                  |
| `/data/panel-data`                          | `hub-data` 命名卷     | 面板的专用数据目录                            |
| `/data/panel-bin`                           | `hub-data` 命名卷     | 面板使用的用户级可执行文件目录                |
| `/workspace`                                 | `workspace` 命名卷    | 项目文件、项目 Skills 和已发送附件             |
| `/workspace/downloads`                      | `workspace` 命名卷    | 面板受控下载目录中的输出文件                  |
| `/data/home/.code-shell/settings.json`       | 宿主机文件，只读挂载  | 部署默认模型密钥和连接配置                     |
| `/workspace/.code-shell/settings.local.json` | Workspace 持久卷      | Web 保存的模型、Skills 开关和 MCP 本地覆盖配置 |

命名卷在新建时使用镜像预设的非 root 目录权限。`docker compose down` 保留命名卷；`docker compose down -v` 会删除它们，不能用作普通重启。[Docker 卷生命周期说明](https://docs.docker.com/engine/storage/volumes/)。

如需让 Agent 操作服务器上的现有项目，在仓库创建 `compose.override.yaml`，将默认 Workspace 卷替换为绝对路径绑定：

```yaml
services:
  hub:
    volumes:
      - type: bind
        source: /srv/codeshell-workspace
        target: /workspace
        bind:
          create_host_path: false
```

先创建并授权目录；对于专供该服务的新目录，可使用：

```bash
sudo install -d -o 1000 -g 1000 -m 700 /srv/codeshell-workspace
sudo install -d -o 1000 -g 1000 -m 700 /srv/codeshell-workspace/.code-shell
```

已有项目请按实际文件所有者授权 UID 1000 读写，避免递归改动其他人的项目权限。部署默认模型配置仍从前面配置的独立文件挂载，本地覆盖文件保存在 Workspace 中。修改挂载或环境配置后执行 `docker compose up -d --force-recreate`，再做配置读取检查。[Compose 挂载配置说明](https://docs.docker.com/reference/compose-file/services/#volumes)。

### 浏览器功能与容器环境

容器部署使用相同 Web 工作台，支持模型连接管理和测试、Skills 新建/编辑/删除及 GitHub 安装/更新、MCP 配置和工具列表探测、会话整理/导出、工作区文件预览/下载，以及独立的 Link 页面。面板的 GitHub 安装、绑定与浏览器运行也使用共用实现；当前进程、任务和工具能力及构建验收状态见 [Web 面板](web-panels.md)。具体可写范围、限额和重连行为见 [Node 部署说明](deployment.md#skills-与-mcp)。一般配置修改需要空闲，保存后下一次任务生效；Link 断开允许运行中执行，以中止仍依赖该连接的操作。

项目 Skills 位于 `/workspace/.code-shell/skills` 或 `/workspace/.agents/skills`，Web 新建和 GitHub 安装默认使用前者。用户级配置、Skills 和插件属于容器的 `/data/home`，随 `/data` 卷持久化；镜像将 `/home/node` 指向该目录，不会读取宿主机用户的 home。`--data-dir /data` 本身不会移动 home，这是镜像单独设置的目录布局。MCP 的 stdio 命令在容器中启动，HTTP 地址也从容器访问；`127.0.0.1` 表示该容器自身。需要额外系统包或 MCP 程序时，应写入自定义镜像并重新构建，确保重建后仍可使用。不要依赖在某次运行中的容器里临时安装程序。

默认镜像没有安装 `yt-dlp` 或 `ffmpeg`。使用 Mimi Download 等依赖外部程序的面板时，需要按面板要求在自定义镜像中安装对应的 Linux 程序及依赖，再重新构建并验证面板中的程序探测。本机 Node 部署能够下载，不代表容器已具备相同依赖；宿主机的 macOS 程序也不能直接复制进 Linux 容器使用。

面板安装包、专用数据、键值存储和用户级程序目录随 `/data` 保留，项目绑定配置和默认下载文件随 `/workspace` 保留。浏览器中的「查看并下载文件」用于访问服务端提供并鉴权的文件列表，不会打开浏览器所在电脑的本地目录。程序运行仍需父页面确认和宿主检查，容器配置与面板授权不等于完整的操作系统沙箱。

重建容器保留卷中的账号、会话、Skills 和项目配置；正在运行的任务会中断，需要恢复服务后重新发送。Web 文件页面仅提供读取，Agent 的命令权限仍由 Core 审批与容器可访问的文件范围共同决定。

### 容器中的 Link

可在 Web「Link」验证并保存 token、管理连接，或绑定容器用户已经登录的 CLI。镜像不内置 `gh`、`glab` 等 Link CLI；需要时写入自定义镜像，并在容器用户环境完成登录。Web 不代替交互式 CLI 登录，宿主机的 CLI 登录态也不会自动进入容器。Link 凭证文件随 `/data` 持久化；CLI 的登录数据是否位于 `/data/home`，需按该 CLI 的存储规则核对。

GitHub/GitLab 设备授权需要把应用 client ID 显式传入容器，例如在自己的 `compose.override.yaml` 中追加以下配置。对应值可放入仓库 `.env`；只写 `.env` 而不添加 `environment` 不会传入 Hub：

```yaml
services:
  hub:
    environment:
      CODESHELL_GITHUB_APP_CLIENT_ID: ${CODESHELL_GITHUB_APP_CLIENT_ID:-}
      CODESHELL_GITLAB_OAUTH_CLIENT_ID: ${CODESHELL_GITLAB_OAUTH_CLIENT_ID:-}
```

设置后保留卷重建容器，再在 Link 页面发起授权。当前没有自动 OAuth 续期，过期后需重新授权；不存在额外的云端 Link Server。连接属于这个容器系统用户，单管理员多设备不等于各自独立的 Link 账号空间。更多边界见 [Link 连接](deployment.md#link-连接)。

## 3. 其他服务器上的访问

没有域名时，在自己的电脑使用 SSH 转发：

```bash
ssh -L 8791:127.0.0.1:8791 your-user@your-server
```

随后在电脑访问日志中的本地初始化链接。如果本机已有容器占用 8791，先停止该本地容器，或在远端和转发参数中统一换一个端口。

要通过公网域名访问，在宿主机部署 Caddy 等 HTTPS 反向代理；后端设为 `127.0.0.1:8791`。例如宿主机 Caddy 站点块为：

```caddyfile
codeshell.example.com {
    reverse_proxy 127.0.0.1:8791
}
```

在仓库 `.env` 加入公开地址，然后重建容器配置：

```dotenv
CODE_SHELL_SERVE_PUBLIC_URL=https://codeshell.example.com
```

```bash
docker compose up -d --force-recreate
docker compose logs --tail=50 hub
```

该地址必须是浏览器实际访问的 HTTPS 根 Origin，不能有子路径。它影响初始化链接、Origin 校验和 Secure Cookie；部署 HTTPS 时必须一并配置。域名、证书和 Caddy 安装见 [公网 HTTPS 说明](deployment.md#5-公网-https可选)，其中 Node 示例的后端端口 `8790` 在此改为宿主机映射的 `8791`。Compose 不直接将 Hub 端口开放到公网。

## 4. 重启、升级和迁移

```bash
# 修改部署默认模型文件后重建容器，保证替换过的绑定文件也重新挂载
# Web 已保存的本地覆盖优先于默认文件；日常模型修改可直接在 Web 设置中完成
docker compose up -d --force-recreate
# 查看运行日志
docker compose logs -f hub
# 停止服务，保留持久卷
docker compose down
```

升级前先停止服务并备份 `/data`、`/workspace` 和独立模型配置，再在目标服务器上切换到明确的 Git tag 或提交，执行 `docker compose build --pull` 和 `docker compose up -d`。确认登录、历史会话和一次对话正常。镜像不携带运行数据，单独复制镜像不会迁移账号、项目或历史。

下面从仓库根目录执行，将归档写入独立的私有备份目录；服务停止期间不要运行其他使用同一持久卷的 Hub。备份目录必须位于被归档的 `/data`、`/workspace` 之外；使用宿主机目录绑定时，也不能放在这些绑定目录之内，否则会把归档自身一起备份。所有路径按实际部署替换：

```bash
docker compose stop hub
umask 077
mkdir -p /absolute/path/to/private-backup
chmod 700 /absolute/path/to/private-backup
docker compose run --rm --no-deps -T --entrypoint tar hub -C / -czf - data workspace \
  > /absolute/path/to/private-backup/codeshell-backup.tgz
chmod 600 /absolute/path/to/private-backup/codeshell-backup.tgz
docker compose start hub
```

归档包含绑定的模型密钥文件。备份路径和文件名应使用尚不存在的位置；备份失败时保留错误输出并重新备份，确认归档完整后再升级。还应单独保存 `compose.yaml`、所用版本信息和自定义 `.env` / `compose.override.yaml`。

迁移到另一台 Docker 主机时，先停止目标服务，在空的专用卷或目录中恢复 `/data`、`/workspace` 的完整内容和 UID/GID 1000 权限，单独恢复模型绑定文件，并继续使用同样的容器内路径。`/data/home` 中的用户配置、Skills 和插件也要完整保留。宿主机上的绑定路径可以改变，但不要覆盖另一实例已有的账号或混合两份会话目录；完整恢复原实例无需重新初始化管理员。

从本机 Node 试用迁移到 Docker 时，先按 [原生备份范围](deployment.md#6-重启升级与备份) 保留原数据目录、Workspace 和运行用户的 `.code-shell`，仅复制 `--data-dir` 不包含全部用户配置。现有容器中的账号应保留，迁移模型和 Skills 不需要替换它的 `hub/auth.json`。首次在其他机器试用时，可以使用独立的新 Docker 实例，按需迁入项目文件、模型连接、用户级 Skills 和插件；其中用户级内容应放入容器实际的 `/data/home/.code-shell`，部署默认模型文件仍按 Compose 的只读绑定配置。

不能把本机目录和配置原样复制后就假定全部生效：会话按 Workspace 绝对路径筛选，原来的 `/Users/...` 与 `/workspace` 不同；插件登记、Skill 脚本、MCP 命令中的本机绝对路径和系统依赖也需要核对，MCP 网络地址按容器环境重新配置。跨操作系统的程序应在目标镜像中安装，插件应核对安装位置和登记信息。需要保留原历史时，先规划一致的容器内 Workspace 路径与对应数据布局，再导入完整备份；保留原实例和备份，确认模型、Skills、MCP 及历史均正常后再切换使用。

当前仍是单管理员、单 Workspace 部署，远程入口是浏览器/PWA，共用 Web 面板的能力以运行实例返回的 `availableMethods` 为准。Electron 原生窗口选择远端 Hub 作为执行目标、多用户隔离以及全部原生 Panel SDK 的 Web 适配尚未实现。Web 已有 Link 管理，但桌面加密凭证和系统钥匙串不能直接搬到容器使用，应在目标宿主重新授权。源码修改不会升级已运行的镜像，必须重新构建并保留卷重建容器。
