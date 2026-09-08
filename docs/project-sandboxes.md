# 按项目运行 CodeShell Hub

项目模式复用现有 Web 工作台，在管理员登录后增加项目列表。每个项目在自己的 Docker 容器中执行任务，拥有独立的文件、会话、配置和面板。Node.js 控制服务负责登录、项目启停和转发请求，工作任务交给项目容器执行。

这是单管理员的多项目部署入口：最多创建 **32 个项目**，最多同时运行 **4 个项目**。原来的 [Node 单工作区模式](deployment.md) 和 [Docker Compose 单工作区模式](docker-deployment.md) 仍然可用。

## 本地启动

需要 Node.js 22.12 或更新版本、Bun 1.3.11，以及已启动的本地 Docker Engine 或 Docker Desktop。运行 Node 控制服务的用户必须能访问同一台机器上的 Docker daemon。先按 [安装与构建](deployment.md#1-安装与构建) 安装仓库依赖，然后在仓库根目录执行：

```bash
bun run build:server
docker build -t codeshell-project-runtime:local .
```

项目服务使用预先构建的镜像；点击“启动并打开”不会自动构建或拉取镜像。根目录的 `Dockerfile` 同时用于原有单工作区 Hub；项目管理器在创建容器时替换启动入口，使用受管理的项目运行方式。

为项目模式选择单独的数据目录和端口，保留原来的 Hub 数据：

```bash
node packages/server/dist/bin/code-shell-serve.js \
  --runtime docker \
  --runtime-image codeshell-project-runtime:local \
  --host 127.0.0.1 \
  --port 8792 \
  --data-dir "$HOME/.code-shell/project-hub"
```

首次启动会输出一次性的管理员初始化链接。用该链接创建账号后，在项目页填写名称，点击“创建项目”，再点击“启动并打开”。如果已在同一浏览器使用另一个 Hub，建议给项目服务使用不同主机名或浏览器资料；Cookie 不按端口隔离。

如果页面提示运行环境不可用，先检查 Docker 是否已启动、当前用户能否运行 `docker info`，以及 `docker image inspect codeshell-project-runtime:local` 能否找到镜像。没有确认运行成功的项目不会进入工作台；启动失败会保留可读的错误提示。

## 每个项目的配置与数据

新项目从空配置开始，**不会自动继承宿主机或桌面端的模型密钥、Skills、MCP、Link 连接和已安装面板**。进入项目后，使用共享工作台配置：

- 在“设置”中添加模型连接，完成连接测试并选择默认模型。
- 在“Skills”和“MCP”中为当前项目添加需要的能力。
- 在“面板”中从 GitHub 发现、审阅并安装面板，再绑定当前项目。
- 在“Link”中添加该项目需要的连接或启动授权。

每个项目有两个 Docker 命名卷：`/workspace` 保存项目文件和项目设置，`/data` 保存运行环境的会话、用户目录及其他持久数据。项目之间不共享这两个卷。控制服务自己的 `--data-dir` 保存管理员登录信息、项目注册表和运行身份材料；它也是恢复部署所必需的数据，应保持私有并与项目卷一起备份。

镜像包含 Node.js/npm、Git、Python 3、ffmpeg、yt-dlp、ripgrep 和 curl 等基础工具。需要额外系统软件时，先基于该镜像制作自己的项目镜像，再通过 `--runtime-image` 指定；运行中的项目使用非 root 用户和只读根文件系统，普通项目依赖可写入 `/workspace` 或项目用户目录。yt-dlp 的站点兼容性取决于镜像中的版本，镜像包含下载工具不代表所有站点、会员 Cookie 或桌面专用能力都已可用。

项目内 `npm install -g` 安装到持久化的 `/data/home/.local`；命令搜索路径优先包含 `/data/panel-bin`、`/data/home/.local/bin` 和 `/data/home/.bun/bin`，随后保留 Node 镜像的标准路径，不继承宿主机环境。

浏览器地址中的 `?project=<项目 ID>` 记录当前选择。会话、HTTP、WebSocket、面板资源和下载请求都由同一个项目入口转发。工作台侧栏显示项目名称，并提供“返回项目列表”；离开有未发送草稿或未保存修改的工作台时会提示，草稿和附件不会带入另一个项目。

## 停止、重新启动与升级

项目列表中的“停止项目”会先请求确认。停止会中断该项目的任务和面板进程，保留 `/workspace`、`/data` 命名卷；重新启动后可继续使用已保存的文件和配置。返回项目列表本身不会停止容器。

控制服务正常退出时停止其管理的项目。控制服务重启时也会核对注册表并停止遗留运行环境，用户需要重新进入项目页并启动项目。新的运行代次会撤销旧连接；未发送草稿和尚未完成的审批不承诺跨停止或重启恢复。

升级时先停止项目和控制服务，再重新构建服务端与项目镜像，使用原来的控制数据目录启动。项目文件与配置由命名卷保留。不要把删除容器或镜像与删除持久卷混为一谈，也不要清理仍需要保留的项目卷。

## 部署到另一台服务器

当前支持的方式是：**Node 控制服务直接运行在 Docker 宿主机上**，项目任务运行在 Docker 容器内。把代码和构建过程放到目标机器，先构建项目镜像，再启动控制服务。对外访问使用 HTTPS 反向代理，并为控制服务传入浏览器使用的公开地址：

```bash
node packages/server/dist/bin/code-shell-serve.js \
  --runtime docker \
  --runtime-image codeshell-project-runtime:local \
  --host 127.0.0.1 \
  --port 8792 \
  --data-dir /srv/codeshell-project-hub \
  --public-url https://projects.example.com
```

`projects.example.com` 是示例地址，替换为实际配置的域名。反向代理必须同时转发普通 HTTP 和 WebSocket，并保留原始路径；项目路由位于 `/p/<项目 ID>/` 下。项目容器只发布宿主机 loopback 的动态端口，由控制服务转发，浏览器不需要直接连接这些端口。

**不要直接给现有 `docker-compose.yml` 增加 `--runtime docker` 来运行控制服务。** 当前实现依赖 Docker 宿主机的 loopback 地址和宿主机上的只读运行身份文件路径；把控制服务直接装进原 Compose 容器后，这两个位置不能按现有实现互通。原 Compose 继续用于单工作区模式；远程 Docker daemon 和容器化控制服务的独立部署方案尚未提供。

## 当前能力边界与验证

项目模式复用了共享 Web、Core Worker、工具审批、Skills、MCP、Link 和面板接口，并在容器级别分开文件与运行进程。容器采用非 root、只读根文件系统、移除 Linux capabilities 和资源限制；这不等于完整多租户安全方案，也不等于阻断所有出站网络。当前仍是同一个管理员管理多个项目。

面板 SDK 仍需以运行时 `availableMethods` 和面板页面提示为准。Cookie、音频、媒体、automation、PDF 及部分桌面宿主功能尚未完整对齐；面板的基础界面可以打开，不代表全部桌面功能可用。Mimi Download 的历史仍受其使用 `localStorage` 而未声明 storage 权限的限制，opaque iframe 重开后不能依靠该历史恢复；已下载到项目卷的文件与此不同。详见 [Web 面板说明](web-panels.md)。

Link 连接在项目中独立配置。需要独立 OAuth 服务的提供方仍需部署和配置相应授权服务；项目模式不会自动启动或替代它。

Web 自动化验证覆盖项目选择、启动与停止、会话 URL、项目切换后的草稿隔离、旧面板续期与清理、目录链接、上传中卸载，以及旧项目异步回调不会转向新项目。

本轮浏览器验收使用独立 `localhost` 临时实例和真实本地 Worker，已验证创建两个项目、启动进入工作台、项目标题、空配置、Skills/面板/Link 入口、草稿离开确认及切换隔离、停止一个项目而保留另一个运行。浏览器控制台没有运行错误。这次浏览器验收通过临时 provider 启动本地进程，用于验证界面与接口。

另一次集成验证使用原生 Node 控制服务和两个真实 Docker 项目，已验证面板进程、主 Agent 和独立面板任务共同读写文件、HTTP 下载、项目隔离，以及停止恢复后保留文件和对话、撤销旧授权。测试模型在容器内运行，不使用真实模型密钥。构建服务和镜像后，可重复执行：

```bash
node scripts/smoke-project-sandboxes.mjs
```

脚本只清理本次创建且带有对应安装标识的容器、网络和卷。已有 Hub 进程仍需按所选部署方式更新，不会因为代码测试通过自动升级。镜像中的下载器固定为经校验的 [yt-dlp 2026.08.19](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19)，避免使用基础发行版中过旧的版本；其他版本升级需要更新 Dockerfile 中的下载地址与校验值。
