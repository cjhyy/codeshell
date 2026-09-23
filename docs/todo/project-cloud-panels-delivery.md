# 本地／云端项目、跨设备 Panel 与独立服务：交付记录

状态：实施中，整套目标尚未完成。工作包与发布门槛见 [总实施清单](project-cloud-panels-plan.md)。完整原始目标见 [objective](project-cloud-panels-objective.md)。

## 初次检查基线（历史记录；当前状态见增量与总实施清单）

- Host task worktree：`/Users/admin/.codex/worktrees/project-cloud-panels/codeshell`，分支 `codex/platform/project-cloud-panels`，起点 `64743b5e9cc136c4c8187008b1bdcbf9a7e63934`。
- Panel task worktree：`/Users/admin/.codex/worktrees/project-cloud-panels/codeshell-panel-apps`，分支 `codex/panel-shared/project-cloud-panels`，起点 `cc717c56f147902dc8fbbe7c2c7b527a36b78dc0`。
- `codeshell-services` 尚不存在；独立 Link 尚未实现。
- 2026-09-23 首次实际检查：Docker CLI 存在，daemon 未启动。后续容器验收须重新检查并启动测试环境。
- 主检出与其他任务工作区保持不动；本任务仅在上述隔离工作区推进。

## 完成证据规则

源码、mock 测试、真实本地进程、真实 Docker、真实服务商、真实手机各自记录，不能互相代替。
每项要求默认未完成；只有检查实际结果、测试覆盖与产物后才标记通过。
不发布未完成的全量版本，不把试验功能或文档状态当作已部署。

## 本轮实施顺序

1. 固定基线、建立环境身份与受认证环境发现、跨端项目引用。
2. 环境入口、项目路由、同源授权与手机工作台。
3. Panel 版本／任务／资源与功能对齐，四种组合的实际流程。
4. 独立 services 仓库、Link 上下游授权及 Host 接入。
5. 全部 Panel 与部署升级／恢复验收。

## 逐项要求

**同一个 Panel，可以用于本地项目或云端项目；项目决定文件、数据和任务在哪里执行，电脑和手机都能进入项目继续操作。Link 独立提供第三方连接与授权服务。**

**一、最终需要具备的产品能力**

**二、已有基础与主要缺口**

**三、项目模型与连接路由**

- [x] 为执行环境建立稳定身份，区分电脑和云端环境。

- [ ] 客户端用“环境 ID＋项目 ID”定位项目。

- [ ] 统一项目名称、执行位置、在线状态和能力描述。

- [ ] 保留桌面与云端已有注册表，通过适配器提供一致操作。

- [ ] 手机只提交受授权的项目身份，由 Host 解析实际目录。

- [ ] 所有上传、保存、审批、取消操作固定目标项目，切换页面后也不能发错位置。

- [ ] 本地项目断线时明确显示离线，不自动转到云端。

- [ ] 项目数据仍由所属 Host 管理，不要求全部上传到中央服务。

**四、Panel Host 与功能对齐**

- [ ] 整合桌面和服务端共享的授权、存储、资源、进程、任务服务。

- [ ] 保留现有接口兼容及数据布局，逐步迁移调用。

- [ ] 统一能力探测、错误、事件和资源限制的表达。

- [ ] 文件选择、上传、下载、录音、预览等由对应设备／Host 提供适配。

- [ ] 模型、业务流程、处理脚本、依赖安装策略继续归 Panel。

- [ ] 明确跨平台程序要求；针对只支持特定系统的引擎提供适配或经过验证的等效方案。

- [ ] 以完整操作结果判断功能对齐，不能只通过隐藏按钮或“页面能打开”验收。

**五、Panel 版本与项目绑定**

- [ ] 同一项目的电脑、手机页面加载同一个确定安装版本。

- [ ] 页面与后台程序使用匹配的包内容。

- [ ] 项目记录 Panel 版本及内容摘要。

- [ ] 安装包支持不可变存储，后续实现多版本共存。

- [ ] 不同项目可以独立安排升级。

- [ ] 任务记录启动时使用的 Panel 版本。

- [ ] 更新处理活跃任务、权限变化及文档格式迁移。

- [ ] 保留旧项目数据，提供可验证的升级和恢复路径。

**六、项目数据、资源与后台任务**

- [ ] 工程、素材、队列、历史和结果保存在项目 Host。

- [ ] 需要继续编辑的草稿同步到项目；滚动位置等界面状态留在设备。

- [ ] 多设备编辑采用版本校验，避免静默覆盖。

- [ ] 长任务交给后台，提交后返回稳定任务 ID。

- [ ] 请求重试识别重复提交，执行结果不明确时先查询状态。

- [ ] 重新打开页面先读取任务快照，再接收后续事件。

- [ ] 关闭页面、断网、撤销授权、取消任务、停止项目分别定义行为。

- [ ] 需要无人值守的 Panel 工具提供后台入口，页面和 Agent 共用。

- [ ] 输入资源完成交付后再启动处理；输出进入项目资源存储，再提供预览或下载。

- [ ] Host 重启后的中断和重试明确可见，不盲目重放有副作用的操作。

**七、手机工作台与电脑远程连接**

- [x] 保存并选择“我的电脑”“我的云端”入口。

- [ ] 分别完成电脑配对和云端登录。

- [ ] 打开项目、Panel、任务、审批和结果。

- [ ] 持续显示当前项目及执行位置。

- [ ] 支持从手机上传、从项目选素材、下载到手机。

- [ ] 适配触控、窄屏、软键盘、横竖屏和长列表。

- [ ] 验证锁屏、切换应用、弱网及重开恢复。

- [ ] 稳定的电脑远程地址和设备身份。

- [ ] 主机主动连接、在线状态、重新连接及设备撤销。

- [ ] 统一设备／项目目录与安全中继。

- [ ] 任务完成、失败、等待审批的通知。

- [x] 电脑原生窗口进入云端项目。

**八、每个 Panel 都需要实际适配**

**九、独立 Link 服务**

- [x] 独立启动入口、管理页面、配置和持久存储。

- [x] 首版单 owner，支持多个明确选择的第三方连接。

- [ ] 上游授权、账号识别、凭据保存及服务商支持的刷新。

- [x] 下游应用登记、授权同意、令牌签发、刷新和撤销。

- [x] 按应用、连接、操作和数据范围检查权限。

- [ ] 第三方原始凭据留在 Link，项目只取得受限访问授权。

- [ ] 本地 Host 和云端 Host 接入同一个远程 Link 契约。

- [ ] 保留现有本地连接方式，不强迫用户迁移。

- [x] 验证重启、授权过期、撤销和在途请求处理。

- [ ] Link 故障不阻断不依赖它的项目功能。

**十、云端服务与部署**

- [ ] 固定源码版本、构建产物和运行镜像。

- [ ] 完成管理员初始化、公开地址和 HTTPS 配置。

- [ ] 验证项目创建、启动、停止、文件持久化和重启恢复。

- [ ] 配置模型与 Panel 实际需要的程序和依赖。

- [ ] 区分控制服务、Link 服务和项目执行环境。

- [ ] 分别管理数据目录、凭据、日志、健康检查和资源限制。

- [ ] 完成备份、恢复、升级及回滚演练。

- [ ] 提供可重复的部署说明和冒烟验证。

**十一、仓库与发布组织**

- [ ] 明确共享包的公开接口和依赖方向。

- [x] 服务仓库使用确定版本的包，避免跨仓库源码路径依赖。

- [x] 不复制 Core，也不整体搬走桌面正在使用的 `packages/server`。

- [ ] 独立生成控制服务、Link 和项目运行环境的构建产物。

- [ ] 建立 Host、Panel、服务、镜像的兼容与发布记录。

- [ ] 新仓库先承接 Link，云端控制层逐步提取。

**十二、实施顺序与完成标准**

- [ ] 电脑操作本地项目。

- [ ] 电脑操作云端项目。

- [ ] 手机操作本地项目。

- [ ] 手机操作云端项目。

## 证据与剩余工作

### 增量 1：环境身份与连接入口（2026-09-23）

已实现：Desktop / 单工作区 Hub / 项目控制服务的受认证 `/api/v1/environment`；稳定环境身份；Web 工作台与登录/项目页的连接管理；地址不保存配对令牌；环境切换保留原任务执行位置且沿用草稿离开确认。

验证：

- `bun run build:server`：通过。
- Web typecheck：通过。
- 环境存储、API 作用域、身份并发/损坏用例：20 通过。
- Web 项目门禁、Desktop controller、Panel 提交回归：37 通过。
- Desktop HTTP / 项目控制服务：16 通过。
- Hub 环境发现与重启身份用例：通过；受登录和 Origin 限制。
- `node scripts/smoke-environment-navigation.mjs`：真实 Node HTTP + Chromium，390px / 1440px 通过。两个不同主机名的登录隔离、连接保存、含令牌地址拒绝、跳转、重开、Escape 和横向溢出检查通过。
- 截图在任务旁 `../evidence/environments-{390,1440}.png`（本地证据，未放进发布包）；已人工查看 390px 图。
- 改动文件 ESLint：通过。

限制：手机尺寸浏览器不是物理手机验收；当前连接记录按站点保存，尚非统一账号设备目录或中继。项目引用契约已定义，但全部项目读写仍需逐端接入。四组合 Panel 全流程、版本锁定和独立 Link 尚未完成。

回归异常：完整 `hub-server.test.ts` 在已有 WebSocket 用例中触发 Bun 1.3.11 segmentation fault；不能标记整套服务端测试通过。崩溃进程已确认并终止，新增 HTTP 路径另以 Node 浏览器测试验证。后续须诊断运行器或以原生 Node 补齐等价回归。

Docker：专用任务镜像 `codeshell-project-runtime:project-cloud-panels` 已构建，`node scripts/smoke-project-sandboxes.mjs codeshell-project-runtime:project-cloud-panels` 通过。两个真实项目容器分别运行主 Agent / Panel 任务，文件和会话隔离；停止再启动保留文件/对话且旧授权失效。使用合成模型服务，不需要真实账号密钥。

### 增量 2：独立服务仓库与 Link（2026-09-23）

新仓库 `/Users/admin/Documents/个人学习/代码学习/codeshell-services`，分支 `codex/services/project-cloud-panels`，提交 `a6e8535`。使用固定公开 `@cjhyy/code-shell-server@0.9.22` 包，不复制引擎和共享 Host。

已实现独立 Link 启动/管理/持久化、GitHub OAuth adapter、下游授权码 + S256、机密客户端认证、连接与仓库/action 授权范围、刷新轮换/重放检测、撤销及在途结果丢弃、加密凭据、在线备份与离线恢复。另有云端产品启动入口、Link 镜像/Compose、systemd 与 HTTPS 配置模板。

验证：21 项测试在本机 Node 25.8.1 与镜像 Node 22.23.2 通过；真实 Chromium 在 390/1440px 完成管理及授权闭环；非 root、只读容器的健康检查、重启持久化、备份恢复通过。GitHub 上游使用受控测试响应，没有将它记为真实账号授权。具体证据在服务仓库 `docs/acceptance.md`。

仍缺真实 GitHub App / 公网部署验收、现有 Host 远程 Link 适配、云端卷恢复/回滚、兼容版本发布与远程仓库。已向用户询问真实服务器、域名和 OAuth App 非密钥配置，独立工作继续。

### 增量 3：原生桌面进入云端（2026-09-23）

桌面侧栏新增“云端工作台”，在独立原生窗口打开输入的 HTTPS 首页地址（回环 HTTP 仅用于本机）。每个 origin 使用独立持久浏览器会话；云端窗口没有 Desktop preload、Node 或本地 Agent bridge。标题固定标识执行环境，同源页面可导航；不自动跳转到其他 origin 或打开任意弹窗。地址只保存规范化首页，不保存初始化/登录令牌。

验证：主仓库完整构建、Desktop 生产构建、Desktop typecheck、改动文件 ESLint、17 项相关单元回归通过。真实 Electron smoke 验证无本地接口、同源导航、跨站导航拦截、多个环境 cookie 隔离及重开；生产主进程/preload/renderer + 真实项目控制服务 E2E 从侧栏打开、独立登录、创建云端项目、确认本地注册表未改变、重开恢复登录与项目均通过。

仍未把该入口当作全部 Panel 功能对齐。跨域第三方网页弹窗/授权跳转、真实录音设备/通知、真实手机和各 Panel 长流程需后续验收。


### 增量 4：多设备条件保存与下载 Panel 接入（2026-09-23）

共享 storage 提供 `getSnapshot` / `compareAndSet`：按 key 内容摘要比较，缺失与 JSON null 分开表达，条件删除、冲突返回当前快照，旧 JSON 数据格式不变。Desktop/Web 共用磁盘锁；写入前复验当前授权，冲突不会写文件。

下载 Panel 队列、历史、搜索恢复记录和归档已按能力探测接入。冲突后保留服务器记录，暂停后续保存；不采用冲突返回的新版本盲目重试。请求回复丢失时先核对已保存内容，结果无法确认则要求重新打开。旧 Host 保留兼容路径。

验证：服务端构建、Desktop typecheck、改动文件 ESLint 通过；共享运行服务 16 项、HTTP/桌面存储与能力 39 项通过。真实生产 Electron E2E 验证 Desktop 与 Node Web Host 同一文件的跨进程竞争、冲突、180 KiB 文档及原有 Panel 安装/更新流程。Panel 下载套件 187 项通过；随后增加的能力降级保护包含在存储 12 项复验中；新增 390/1440px 冲突 UI 两项通过，确认旧页面不会启动未保存的下载。上述浏览器业务进程为模拟，未将其记作下载的真实四组合全流程。

限制：内容版本不是历史计数器，也不是自动合并。旧客户端仍可能无条件保存；其他 Panel 尚未全部接入。下载长队列仍需迁移到持久后台任务，不能据此声称关闭页面仍能继续所有下载。

对应提交：Host `3dc5c325`，下载 Panel `f90d7cb`。`npm run validate` 全部安装包与规定 smoke 检查通过。均仅提交任务分支，未发布或部署到公网。

### 增量 5：下载后台入口与准备阶段去重（2026-09-23）

Panel 提交 `a04fe80`：声明经过摘要验证的 `download-runtime` 和 `resources` 权限，使用固定 yt-dlp / FFmpeg 命令读取结构化配置，向 Host 发送进度和带 SHA-256 的产物清单。入口拒绝浏览器提供的可执行路径、原始参数、输出路径及 Cookie 路径；任务输出保存到 Host 分配的工作目录，资源服务再接管产物。此时尚未替换现有下载界面，不把原生入口记为完整四组合闭环。

Host 提交 `5a422773`：修复同时提交相同 requestKey 时重复准备输入、最终一方报错的竞态。相同作用域和输入共享一次准备并取得同一任务 ID；不同输入立即拒绝；等待方取消只结束自己的等待，准备失败通知所有等待方，显式重试仍可进行。

验证：

- 下载原生入口与安装包检查 11 项通过；`npm run validate` 全部通过。
- Host 持久任务和真实原生执行器相关 20 项通过；服务端构建、改动文件 ESLint 通过。
- `node scripts/smoke-download-task.mjs <video-download-package-dir>` 使用本机真实 FFmpeg 生成 MP4、本机真实 yt-dlp 从受控 HTTP 下载，再由真实 Host executor / task / resource 服务运行。输出字节和摘要与源文件完全一致。
- 同一脚本验证并发重复提交只有一个任务、资源不能跨项目读取、真实网络等待中的进程取消后才返回取消状态、同一任务明确重试后 attempt=2 成功、Host 重启后仍可读取产物。全部通过，临时服务器、文件和进程均随测试关闭。

仍待集成：界面后台队列、目标目录交付、账号授权、任务事件恢复，以及桌面和手机同一项目的任务协调器。真实媒体测试使用本机 MP4，不代表公网视频服务或账号流程已验收。

### 后台任务共享的实施依据（增量 6 已落实协调器）

实际源码有明确分离：`PanelAppBridge` 使用 `panel-tool-jobs`，Desktop Web 的 `createPanelRuntime` 使用按 cwd 划分的 `panel-web-tool-jobs`，以避免两个独立协调器争抢同一个磁盘锁。桌面和 Web 的 Panel revision 计算方式也不同。不能只把两个存储路径改成相同路径。

据此确定由 Desktop 持有唯一任务协调器，通过可信 Host 适配器供 Web 使用；冻结且校验已审查的安装版本映射，路由同一 app/project 的任务列表、状态、事件和取消。Web handler 关闭或被缓存淘汰不能 shutdown 桌面协调器；退出登录／设备撤销的处理应只影响相应授权范围，不能取消其他设备或桌面拥有的无关任务。既有 Web 任务目录要保留并明确迁移策略。

目录书签也有两个存储文件，且当前重新记住相同目录会换 ID；接入后台目的目录前需处理稳定性、目录身份变化及权限撤销。Cookie 原始数据不能作为任务 JSON 或永久产物持久化；应通过 Host 提供的有限授权交付。


### 增量 6：桌面与配对 Web 共享原生任务（2026-09-23）

Desktop 将自己持有的任务协调器通过 `SharedPanelToolHost` 注入 Web。
Web 按经过验证的安装包、项目和冻结的 Desktop 执行 revision 建立绑定，
不再另建一份新任务，也不把 Web catalog revision 当作 native revision。
两端的 `tasks.start/list/get/cancel/retry` 使用同一任务 ID、去重记录、输出资源和事件。
Web handler 只拥有查看授权和订阅，不拥有 coordinator 的 shutdown 权限。

已接收任务归项目：页面关闭、登出、设备撤销、远程服务停止或 HTTP 缓存淘汰
不取消项目任务；登出会取消尚在准备输入的请求。请求回复不明确时要求重连查询，
不声称已提交任务必定取消。明确取消、项目/应用撤销及 Host 关闭仍遵循原有停止／中断规则。
共享事件只传摘要，同时检查 native 与 Web 查看者授权，有界排队并随授权移除订阅。
绑定变更只撤销相应项目的 Web handler；应用更新／卸载仍通知所有相关项目。

旧的 `panel-web-tool-jobs` 文件保持原位置。首次读取会把旧未结束任务标为 interrupted，
以 `readOnly` 和 `historySource: desktop-web-legacy` 返回；不自动重放，也不允许通过新协调器
重试旧记录。单独的 Hub 尚保留 session ownership／登出取消规则，已通过 capabilities 显式说明；
尚未声称所有 Host 的任务生命周期完全一致。

验证：

- Server 构建、完整 Desktop 生产构建、Desktop typecheck、改动文件 ESLint 通过。
- HTTP runtime、持久任务、真实 executor、配对 facade、Desktop capabilities 共 61 项通过。
  覆盖双向任务身份、去重、取消、项目隔离、冻结执行版本、旧历史保留、事件订阅及失效。
- `node packages/desktop/scripts/e2e-shared-panel-tasks.mjs` 通过：真实 Electron
  main/preload/guest、真实配对 HTTP、受控 Node 原生程序，验证 Desktop 任务在配对入口可见并取消、
  配对入口任务在 Desktop 可见、同请求跨两端去重、真实进度、登出后结果恢复、设备撤销和远程服务停止
  不误停项目任务。临时账号、目录、进程均随测试清理。

范围限制：该 E2E 使用配对 HTTP 客户端，并非物理手机 UI 验收；下载业务界面仍未迁移到持久队列。
项目独立包版本、目录交付、Cookie 有限授权、其他 Panel 和正式公网部署仍在总清单中待完成。
下一步继续统一目录授权与后台产物交付，再接入下载队列，避免把同任务可见误记为整个 Panel 完成。


### 增量 7：稳定目录书签与主项目跨端恢复（2026-09-23）

Desktop 与配对 Web 改为共用 `panel-app-directory-bookmarks.json`。
重复选择同一 app／项目／实际目录时保留标识；若同路径的目录身份已变更，必须重新选择并生成新标识。
旧 `panel-web-directory-bookmarks.json` 不删除；恢复时先核验 app、项目、路径与 dev/ino，
再把原标识导入共享记录。如果两端原先选择过同一目录，两份标识作为别名继续有效；
已存在的其他作用域标识不能被旧文件覆盖，导入不静默挤掉当前书签。

配对 Web 可恢复 Desktop 明确选择过的目录；Host 独立复验安装包、process 权限、
主项目绑定以及项目／实际工作区信任。撤销信任会使现有 Web process grant 失效。
未注入 Desktop 目录授权的独立 Hub 仍只能恢复原有服务端下载目录，不扩大其文件访问范围。

验证：目录书签、HTTP runtime 与配对 facade 共 43 项通过，Server 构建、Desktop typecheck、
改动文件 ESLint 通过。真实 Electron E2E 增加双向目录恢复和受认证目录浏览，
连同增量 6 的真实原生任务流程通过；仅 OS 目录选择器返回的是测试指定目录，
后续 IPC、权限、持久化、配对 HTTP 均走产品实现。

仍有限制：Desktop 原有目录书签按实际 cwd 绑定，Web 按 bindingCwd；本增量验证的是主项目 cwd
一致的情形。worktree 与主项目的范围迁移必须单独完成，不能把旧 cwd 授权直接扩大到其他项目。
后台 executor 的目录参数仍只支持任务目录／app-data，下载产物交付和账号授权仍待接入。


### 增量 8：后台任务目录授权与下载产物交付（2026-09-23）

公共 executor 支持作用域绑定的目录书签参数，Desktop 和独立 Web Host 均提供解析器；
准备、启动、执行中和接受结果时重新核验。任务记录只保存不透明书签，不保存解析后的输出路径。
默认 Downloads 选择也返回可恢复书签，保留旧目录句柄兼容。worktree 范围问题仍待处理。

Download 原生入口增加可选的 Host 输出目录，逐文件校验来源与摘要，通过临时文件和
非覆盖发布保存产物。同名同内容可验证后复用，不同内容、目录和符号链接不覆盖。
输出名称包含规范化选项摘要及显式副本后缀；结果只记录相对文件名。
按文件完成交付，后续失败不回滚此前已验证文件；明确重试可核验并复用这些文件。

验证：
- Server 构建，executor/runtime 46 项测试，Desktop typecheck 和改动文件 ESLint 通过。
- Panel manifest 验证与下载全套 206 项通过；其中原生下载／交付 16 项另在 Node 22 Linux 容器通过。
- 真实 FFmpeg 生成 MP4，经 yt-dlp、本地 HTTP、持久任务 executor 下载：验证授权目录实际字节、
  重复提交同一 ID、另一个明确请求复用同内容、跨项目隔离、真实取消／重试、Host 重启后结果保留。
- 真实 Electron 与配对 HTTP 均启动原生任务写入同一已授权目录；验证结果不泄露解析路径。
  既有登出、撤销远程设备、停止远程入口及恢复结果的检查继续通过。目录选择器返回使用测试夹具。

尚未完成：下载业务 UI 仍使用旧页面队列；本增量没有声称整队后台调度、Cookie 授权或四组合业务闭环完成。
下一步需要把队列全部交给后台，并解决暂停、并发设置、重连恢复与账号授权。


### 增量 9：作用域后台队列调度与跨设备控制（2026-09-23）

新增 `tasks.queue.get/set`，Desktop、独立 Web 和共享 Desktop coordinator 使用同一
app／项目／执行版本作用域。暂停只停止等待任务进入执行，已启动任务继续；并发修改作用于后续启动。
设置使用 revision 条件保存，另一设备的旧设置不会覆盖新设置；响应不明时可读取当前状态。
Web 修改须经已有确认流程，并在修改前重新核验授权。设置暂不单独广播事件，客户端需刷新状态。

队列容量从 32 调整到每作用域 128 个未完成／准备中任务，覆盖下载界面的 100 项上限；
新提交与重试都检查容量。全局原生进程并发仍最多 2，单作用域可进一步设为 1。
队列配置原子保存且有 512 个作用域／4 MiB 上限；目录损坏不会默默恢复默认并启动任务。
Host 重启保留队列设置，但原未完成任务仍标为 interrupted，必须明确重试。

验证：调度服务新增整队容量、暂停／恢复、跨项目并发、设置竞争、重启、旧包作用域、
非法配置和授权失效检查。调度／HTTP runtime 共 54 项通过；随后增加重试容量断言的调度
17 项复验通过。Server 构建、Desktop typecheck、改动文件 ESLint 通过。
真实 Electron＋配对 HTTP 验证桌面暂停、手机读取同一设置、任务保持 queued、
手机确认后恢复、桌面读到同一新 revision；此前任务／目录 E2E 同时通过。

本增量仍是公共能力，下载 app.js 尚未接入持久整队提交；不能据此标记下载 UI 闭环完成。


### 增量 10：下载页面接入持久任务（2026-09-23）

Download 在 Host 明确提供目录书签、队列控制与 `tasks.find` 时启用后台适配。
队列逐项提交给 Host，执行并发由后台控制；每项提交前保存关联 key，丢失启动响应时查询原任务，
重开页面从已保存 key／ID 恢复，不自动重放未确认的提交。未提交项目显示等待提交；
关闭页面只保证已接收任务继续，未确认项重开后需要用户明确恢复。

页面读取快照并处理有序 `tasks.changed` 事件，定期刷新补齐遗漏；完成后从后台结果恢复文件清单。
暂停／取消／重试使用同一原生任务 ID，移除等待项前先停止后台任务。
全部暂停先暂停调度，再停止逐项任务；只恢复一个任务时其他任务保持停止。
提交中的暂停等待原 ID，避免启动晚到后失去取消目标。
记录保存冲突不会把已接收任务误报为失败，也不会阻断显式取消；队列设置响应丢失会读取当前值。
旧 Host 保留原调用，但本版本已标记为后台的记录不能被旧进程路径重放。

Host 新增只读 `tasks.find`（按当前作用域和请求 key 查找），并给已授权项目根目录返回书签，
与 Downloads 一样供任务使用。独立 Hub 可恢复已授权项目根／下载目录，仍不接受任意客户端路径。
worktree 与主项目的旧授权范围问题尚未迁移。

验证：
- 下载全套 221 项通过，其中后台客户端 13 项覆盖丢回复、重开、事件顺序、保存冲突与取消竞态；
  浏览器使用真实页面／受控 Host，覆盖 390px 和 1440px；随后新增的全部暂停／单项恢复 UI 测试单独通过。
- Host 调度／HTTP runtime 55 项、Server 构建、Desktop typecheck 和改动文件 ESLint 通过。
- 新增真实 Electron Download 页面验收脚本：实际安装任务 Panel，真实 FFmpeg 生成本机视频、
  yt-dlp 下载，整队两个任务（一个执行、一个等待），删除原页面并重开，两个原 ID 均完成，
  授权项目目录产物与输入视频字节一致。最终页面版本复验通过，没有使用模型、个人账号或用户项目。
- 共享 Desktop／配对 HTTP E2E 复验通过，并验证主项目书签跨端恢复与 request key 查询同一任务。

范围仍未完成：新后台入口尚未接入 Cookie 授权，选择账号时明确拒绝而不降级为匿名下载；
正式发布前必须补齐。该增量不能替代独立云端 Linux、物理手机、跨设备新任务目录实时发现、
项目版本锁定或其他 Panel 的全流程验收。下一步继续账号授权和跨端实际流程。

### 增量 11：后台 Cookie 共用交付层（2026-09-23）

新增 `PanelTaskCookieService`，Host 注入凭据库和权限检查；公开元数据仅包含账号 ID、名称、
域和不透明版本。版本通过 Host 私钥计算，绑定应用、项目、安装版本及账号内容，不是用户确认凭证。
更换、删除、损坏或混淆账号时拒绝旧选择；跨项目和跨版本不能复用。
账号包含整分区 Cookie 时，只交付其声明域及子域的有效记录，跳过过期和格式损坏的行。

原生执行器增加可选 `cookieArgument`，默认没有适配器时拒绝请求。
任务 JSON 仅保留账号选择和版本；临时文件位于独立 Host 私密目录，以 0600 权限交付给真实原生程序。
准备、启动、运行中和接受结果时复验；取消或授权撤销等待进程退出，再等待文件清理完成。
同一清理操作共享 Promise，避免进程授权回收与任务结束同时删除同一租约。

验证：新增凭据交付 9 项和真实子进程 6 项；连同现有 executor、持久任务及 HTTP runtime，
79 项通过。Server 构建、改动文件 ESLint 通过，Node 能从构建后的公开 panels 入口加载新服务。
真实 Node 程序验证临时 Cookie 文件权限和内容，排队时账号替换、运行中撤销、显式取消、
原生失败及再次执行均验证了文件清理。所有凭据均为隔离测试数据。

本增量没有启用产品账号下载。仍须完成 Host 私钥持久化与崩溃遗留文件清理，
桌面和 Web 的账号列表／明确确认／重试确认、共享执行版本适配，以及下载脚本和页面接入。
在这些条件完成前，不发布能力声明，现有下载 UI 继续明确拒绝后台账号下载。

### 增量 12：后台 Cookie Host 生命周期与跨端确认（2026-09-23）

`PanelTaskCookieHost` 独占私密目录，原子保存 0600 的 Host 私钥；重开保留账号版本。
启动时先取得唯一执行进程所有权，再清除已退出 Host 留下的管理范围内临时文件。
活跃 Host 的文件不会被另一个实例清除；损坏密钥拒绝启动，不静默覆盖。
关闭时拒绝新取用，等待在途读取，清理尚存租约；调用者先停止后台进程，再关闭凭据 Host。
真实子进程被 SIGKILL 后重新启动的测试验证了旧文件回收与版本保持。

桌面、配对 Web 和 Hub 接入 `credentials.cookies.listForTask`，仅在具备 process、resources、
credentials.cookies 三项权限时声明能力。桌面读取已有凭据库；配对 Web 通过共享协调器
读取同一执行版本的安全账号元数据；Hub 仅读取当前项目凭据，避免继承控制服务的用户账号。
提交和重试都明确展示账号、站点和已审查工具，默认拒绝，并在确认后复验。
账号替换、面板关闭、项目／安装版本变化或会话撤销不能沿用等待中的确认。

验证：Server 构建、完整 Desktop 生产构建、Desktop typecheck 和改动文件 ESLint 通过。
凭据生命周期、真实 executor、持久任务、HTTP runtime 和能力声明共 92 项通过；随后补入
确认后账号读取期间退出登录的竞态检查，HTTP runtime 41 项复验通过（相关测试合计 93 项）。
HTTP 测试以真实 Node 程序使用测试 Cookie，验证拒绝不入队、确认期间换号不入队、
重试重新确认且仍使用原任务 ID；任务结果不包含 Cookie 原值。

真实 Electron＋配对 HTTP 验收通过：两端账号版本一致；桌面提交和重试的拒绝／接受；
配对网页确认后原生程序实际读取临时凭据；两端看到同一任务与结果，取消后租约清理。
既有目录交付、队列控制、退出登录、设备撤销和关闭远程入口的任务行为继续通过。
系统账号确认框的返回值和目录选择器使用测试响应，其他 IPC、权限、凭据库、HTTP、
原生执行与落盘流程走产品代码；没有使用真实个人账号，也不等于物理手机验收。

现有真实 Download 匿名流程也复验通过：删除页面后重新挂载，两个原任务 ID 完成，文件字节一致。

尚待完成：Download 脚本接受 Host Cookie 文件、UI 选择和保存账号版本、重新选择账号时的
任务恢复，以及完整云端／手机业务验收。网页暂不提供登录采集与浏览器登录恢复。
Host 崩溃后的孤儿程序终止沿用现有任务机制，凭据目录回收本身不承诺终止这些程序。


### 增量 13：下载 Panel 后台账号与显式换号恢复（2026-09-23）

下载 Panel 按 Host 能力读取 `credentials.cookies.listForTask`，把选中账号 ID、站点与
授权版本写入项目队列。准备提交时再次查询，不接受选中后已变化的版本；账号消失或查询
失败时保留原选择并显示错误，不静默改为匿名。正常重试继续使用 Host 内的原任务和原账号。
停止的任务提供“用所选账号重试”，用户明确选择后创建新的请求，旧任务仍保留原授权记录。

`download-runtime` 接受 `useSavedLogin` 业务标记；Cookie 文件仅来自 Host 的密封命令参数。
账号标记和文件必须同时存在，且文件须为任务产物目录之外的私有普通文件；拒绝符号链接、
硬链接、公开权限及浏览器 JSON 中的原始路径。yt-dlp 使用该文件，产物清单不会包含它，
文件清理由 Host 负责。安装清单中的原生入口摘要同步更新。

验证：下载完整套件 236 项通过；之后增加选中后账号版本变化的浏览器回归，相关 28 项
账号／任务单测和 4 项 Chromium 界面回归通过（现有用例总数 237）。窄屏 390px 与桌面
1440px 验证重开、原账号重试、明确换号；拒绝授权与账号变化均没有创建匿名任务或页面进程。
原生入口测试用真实私有文件和受控子进程验证参数、产物排除、权限和错误；不是第三方授权测试。
包校验、改动差异检查通过。实际 Electron 匿名下载也通过：两个后台任务，关闭／重开页面，
原任务完成且输出与 FFmpeg 测试视频字节一致。

完整范围仍未完成：网页登录采集、带账号的信息读取、真实第三方服务商、云端和物理手机
下载业务验收。暂不支持带账号信息读取的入口会明确报错，不能作为功能对等验收通过。


该真实链路另外发现并修复了通用 Cookie 导出问题：省略 `hostOnly` 且域名不带前导点时，
旧实现仍输出包含子域标记 TRUE，Python/yt-dlp 的 Netscape 解析器会直接拒绝。
现在缺省值按已保存域名推断作用范围，显式 hostOnly 会规范化域名前导点；Desktop 复用
Core 的同一导出函数。真实 Python `MozillaCookieJar` 验证五种输入的可解析性及作用域，
连同桌面凭据、后台凭据及原生 executor 共 45 项通过；Core 构建、Desktop 主进程构建、
Desktop typecheck 与改动文件 ESLint 通过。


修复后实际 Electron + 安装的 Download Panel + yt-dlp + 本机 HTTPS 站点的带账号下载通过：
站点只向携带指定测试 Cookie 的请求返回 FFmpeg 视频；两项任务分别确认账号，删除原页面后
继续排队并完成，重开查询同一任务 ID，交付文件字节一致，Cookie 临时目录清理完毕。
测试仅替换系统确认框返回值；下载程序通过隔离工具适配器使用 `--compat-options no-certifi`
与测试专用 `SSL_CERT_FILE` 信任临时 CA，没有关闭 TLS 验证或修改系统证书库。
该兼容选项依据 [yt-dlp 官方说明](https://github.com/yt-dlp/yt-dlp#differences-in-default-behavior)；
生产下载参数未增加此选项。全部账号和站点均为测试夹具，不包含个人凭据。

复验命令：

```sh
node packages/desktop/scripts/e2e-download-background.mjs /absolute/path/to/codeshell-panel-apps/apps/video-download
node packages/desktop/scripts/e2e-download-background.mjs /absolute/path/to/codeshell-panel-apps/apps/video-download --cookies
```

Panel 提交：`328156d`，仍位于本任务开发分支；尚未合并或发布整套版本。

### 增量 14：带账号信息读取与临时进程授权（2026-09-23）

增加通用、带版本校验的临时进程账号接口。Desktop、配对 Web 与 Hub 通过
`process.cookieCredentials` 声明支持；客户端将选中账号 revision 传给
`credentials.cookies.authorizeProcess`，仅取得不透明文件参数句柄。配对 Web 复用
Desktop 的账号库、密钥和租约，浏览器不接触 Cookie 内容及文件路径。

公共进程服务在执行确认后、运行期间及最终退出前校验授权。账号变化会撤销句柄、
清理文件并终止程序，快速退出也不能将失效输入报告为成功。临时进程跟随页面生命周期，
后台下载仍由项目任务协调器持有。旧 Desktop 无 revision 调用保留原兼容行为。

下载 Panel 将短期授权缓存绑定到账号版本、站点及可执行程序；暂停后台队列时仍可
读取视频信息。现代 Host 缺少版本能力会明确提示更新，不退回忽略 revision 的旧接口。

验证证据：

- 初始相关 Host 四文件 74 项通过；补入租约准备期间退出登录和能力声明检查后，
  HTTP runtime 与 Desktop 能力两文件 48 项通过（相关总用例 75 项）。
- 下载完整套件 240 项通过，包含 390/1440px 暂停队列下带账号读取信息，
  同版本复用和新版本重新授权。Panel 包校验通过。
- Server 构建、Desktop 主进程构建、Desktop 类型检查及改动代码 ESLint 通过。
- 真实 Electron＋安装的 Download＋yt-dlp＋HTTPS 测试站点：账号信息读取，
  两个后台下载，关闭并重开，原任务 ID、精确文件字节与凭据文件清理全部通过。
  一次信息读取授权在两个链接间复用，两项后台任务各自确认，共三次账号确认。
- 真实 Electron＋配对 HTTP：网页临时进程通过共享账号文件运行并返回公开结果；
  账号与执行授权分别确认；页面删除清理文件。既有共享后台任务、目录、队列、
  退出登录及撤销设备流程继续通过。

真实执行使用本地生成的媒体及测试账号；系统确认框采用测试响应，配对路径直接
访问产品 HTTP 接口。不是第三方账号、手机浏览器 UI 或物理手机验收。网页登录采集、
真实服务商、云端与手机完整下载业务，以及其他五个 Panel、版本绑定、Link 接入和
部署发布仍须继续，完整目标保持未完成。

### 增量 15：真实配对网页下载与局域网 ID 兼容（2026-09-23）

新增实际手机工作台浏览器验收，不再只直接调用配对 HTTP。390×844 Chromium 使用
Desktop 正式配对地址，经项目选择和 Panel 列表打开已安装的 Download。它读取桌面原有
两个任务的同一 ID、使用已保存测试账号读取新视频信息、提交第三个原生后台下载，
关闭浏览器页再重开项目，恢复三个完成记录。最后从任务页“打开文件夹”进入认证文件列表，
通过浏览器下载保存产物，校验与 FFmpeg 测试源字节相同。整条命令退出码 0。

此流程发现并修复普通局域网 HTTP 的兼容问题：浏览器不提供 `crypto.randomUUID()`，
队列因此无法创建。独立 Chromium 实验确认同一 iframe 在 localhost 提供该方法，在
实际 LAN 地址不提供，而两者均提供 `crypto.getRandomValues`。Download 新增 Panel
内部 UUID v4 辅助函数，队列、历史恢复、重复副本和搜索操作统一使用安全随机数回退。
不使用时间或 Math.random，原有持久 ID 保持不变。

同类修复扩展到 Video Studio 的 30 个源码模块：工程、素材、字幕、时间线、同步、
语音、后台处理及导出操作。对应安装包重新构建，与源码和 build-manifest 一起提交。
这只完成标识生成的兼容，不意味着视频 Panel 的完整手机／云端流程已验收。

验证：

- Download 完整 241 项通过，新增缺少 randomUUID 时连续提交两个不同后台请求的浏览器回归；包校验通过。
- Video Studio 类型检查、构建、确定性构建检查和包校验通过；主套件 887 通过／3 跳过，
  CLI 套件 5 通过／1 跳过。新增模型用例验证无 randomUUID 的有效工程与不同 ID。
- 单独 Chromium 用例在关闭 randomUUID 后实际新建、保存、重载工程，通过；
  媒体模型等条件性跳过沿用原套件，并未把它们算作真实环境验证。
- Desktop 带账号下载与正式配对网页整个流程通过，使用真实 Electron、产品 Web 构建、
  安装 Panel、yt-dlp、临时 HTTPS 站点及浏览器文件下载；账号确认在测试中自动选择允许。

复验命令：

```sh
bun run --cwd packages/desktop build:mobile
node packages/desktop/scripts/e2e-download-background.mjs /absolute/path/to/codeshell-panel-apps/apps/video-download --cookies --paired
```

Panel 提交：`6fd63db`（版本化信息读取）、`86a2a2c`（Download LAN ID）、
`ffba90a`（Video Studio LAN ID）；对应 Host 临时授权提交为 `c7c94a75`。
全部仍为本任务开发分支，没有把整套版本标记发布。

仍待完成：真实服务商登录与采集、物理手机录音／弱网／锁屏等行为、云端真实下载，
下载历史的客户端播放／打开，其余 Panel 全业务流程、项目版本绑定、Link Host 接入和
公网部署／恢复／回滚。上述浏览器结果只证明记录的测试组合，不替代其他验收项。


### 增量 16：下载历史的浏览器预览与资源流授权（2026-09-23）

Web/Hub 新增通用 `resources.open({assetId})`，通过当前登录、Panel 实例和项目作用域
解析资源。受信工作台验证资源 ID 与实例 URL，保留发起时的项目路由，渲染视频、音频、
栅格图片并提供“保存到此设备”；不支持的类型及解码失败保留下载入口，HTML/SVG 不执行。
不透明 Panel 只收到 `{opened:true}`，不会拿到工作台的认证资源 URL。

资源 GET/HEAD 支持 Range、强制下载和禁止缓存；开始读取、逐块输出以及无数据期间
均检查当前授权。关闭一个 Panel 实例即中断其文件流，不因另一个实例仍有资源权限而
继续读取；退出登录也会关闭空闲流。错误不暴露内部文件路径。

Download 保留后台产物资源 ID，并在历史保存、文件检查与重新打开时保留该字段。
网页播放／打开先检查授权目录中的原文件，再打开资源；旧记录缺少资源 ID 时通过
`resources.capture` 导入，并保存 ID。网页定位改用认证目录列表，不启动 Host 的系统
播放器。桌面原有播放器与文件管理器流程继续兼容。

验证：

- Server HTTP runtime + Web PanelHost 共 90 项通过：范围读取、HEAD、下载、项目隔离、
  错误 URL、跨登录访问、关闭授权、流中断、空闲时撤销及原项目路由。
- Download 完整套件 246 项通过；新增 390/1440px 旧记录预览、重开资源复用、目录访问、
  文件缺失和导入失败流程。目录相对路径补充根目录情况后相关模型／任务 27 项通过。
- Server 构建、Server/Web 类型检查、Desktop 主进程和 mobile 构建、Desktop 类型检查、
  改动 Host 代码 ESLint、Panel 包校验通过。
- 真实 Electron＋安装 Download＋yt-dlp＋临时 HTTPS 测试账号，桌面两个后台下载以及
  390px 配对工作台新增下载、关闭／重开继续通过。网页点击下载历史“播放”后，工作台
  video 元素成功解码 FFmpeg 生成的 H264 MP4（非零视频宽度与约一秒时长）；预览下载
  和目录列表下载均与源文件字节完全一致。整条命令退出码 0。

```sh
bun test packages/server/src/panels/runtime.test.ts packages/web/app/PanelHost.test.tsx
npm test -- --suite video-download
node packages/desktop/scripts/e2e-download-background.mjs /absolute/path/to/codeshell-panel-apps/apps/video-download --cookies --paired
```

仍为任务分支上的实现和验证，未发布完整版本。临时站点／测试账号与模拟手机宽度不能
替代真实服务商或物理手机验收。云端完整下载、其余 Panel、版本锁定、Link 接入、远程
中继和部署恢复等原目标保持未完成。


### 增量 17：云端下载、跨登录接续和项目重启恢复（2026-09-23）

Hub 的已接收原生任务改为项目持有：发起登录退出后任务继续运行，相同项目、Panel 和
安装 revision 的其他授权页面收到任务摘要。准备阶段和未完成审批仍随登录撤销；
已撤销页面无法继续查询、读取文件或启动进程。停止 Host／项目仍中断执行协调器，
重新登录不自动重放未完成任务。此处指原生工具任务，不扩大为全部 Agent Task 的保证。

真实 Docker 验收发现旧目录书签文件的锁落在 `/data.lock`，只读根文件系统会拒绝创建。
Hub 改用数据卷内 `panel-directories/bookmarks.json`，锁也留在数据卷内；旧记录经过
相同 app、项目和目录身份校验后迁移，保持原书签 ID。Desktop 共享布局不变。

下载 Panel 现在通过事件及周期快照发现另一设备新增的已提交下载记录，并向任务协调器
查询进度和完成产物；不导入未提交草稿，不推进当前编辑器的条件保存版本，不回写旧草稿。
页面重开仍由项目记录和同一后台任务恢复历史。保存位置文案改为项目运行设备的所选目录，
避免云端页面错误宣称文件保存在手机或用户电脑。

验证证据：

- Download 完整套件 247 项通过，新增已打开设备发现另一设备任务、无重复提交／条件保存的回归。
- Server runtime 与书签迁移共 49 项通过，涵盖跨登录事件、退出后完成、旧授权失效与只读卷布局。
- Server 类型检查、改动 Host ESLint、Panel 包校验通过。
- 新增可复验的云端下载浏览器验收，复用两个真实 Docker 项目隔离检查。
  实际安装 Download 包及容器中的 yt-dlp，用 FFmpeg 生成 H264 MP4，测试 HTTP 站点延迟返回文件。
  1440px 登录提交任务，在运行中退出并关闭；另一独立 390px 登录看到原任务完成。
  检查产物与源字节一致、另一个项目不可读取、父页面解码视频、保存到设备字节相同且无横向溢出。
- 停止再启动项目，用新浏览器登录恢复相同任务 ID、成功状态、资源 ID 与文件字节，历史可播放；
  后台任务数量仍为一，没有重新提交下载。整条真实 Docker 命令退出码 0。

```sh
bun test packages/server/src/panels/runtime.test.ts packages/server/src/panels/directory-bookmarks.test.ts
npm test -- --suite video-download
node scripts/smoke-project-sandboxes.mjs codeshell-project-runtime:project-cloud-panels --download-panel /absolute/path/to/codeshell-panel-apps/apps/video-download
```

浏览器证据图保存为任务工作区 `../evidence/cloud-download-preview-390.png` 并已目视检查。
验收使用实际 Node、Docker、Chromium、产品工作台与安装包；模型响应和媒体站点为测试夹具，
执行确认由测试点击允许。未调用外部模型或真实账号，不代表真实服务商、物理手机、云端带账号
下载或完整四组合全部业务已经验收。其他五个 Panel、项目版本锁定、Link Host 接入、设备目录／
中继／通知、公网部署与恢复回滚仍须继续，整套版本没有发布。


### 增量 18：保留 Panel 历史包，为项目版本绑定提供存储基础（2026-09-23）

安装器保留 `.versions/<appId>/<packageDigest>` 包快照，摘要包括文件名、长度和内容，
覆盖 manifest、页面、原生程序与 Skill，排除 Host 来源／安装时间元数据。
新安装自动保留包；更新前保留有效旧包；重复内容安装复用同一地址，不覆盖原快照。
旧可变安装目录和现有返回路径保留兼容。卸载当前目录不删除历史包；引用追踪和回收尚未接入。

新增 `retainInstalledPanelApp` 和 `resolvePanelAppPackage`，由 Host 显式保留和解析确定内容。
解析重新校验包内容和元数据，拒绝缺失、内容改变、路径穿越、链接目录或链接文件，不退到
当前最新版。这些方法仅管理包字节，不授予项目权限，也不接收项目提供的任意安装路径。
暂存与发布分离：Host 的最终授权／版本检查拒绝时清理副本，保留原安装和注册表。
损坏旧目录仍可通过重新安装修复，但损坏字节不会被当作有效历史包保留。

验证：

- Core Panel 全部 101 项通过，新增 8 项快照测试：两个版本的 UI／原生程序／Skill
  在更新和卸载后仍可读取、同内容目录复用、同版本不同内容分离、旧安装迁移与并发保留、
  缺失／篡改拒绝、路径与链接拒绝、损坏当前目录修复不覆盖已有历史包、拒绝重复安装不发布新包。
- 现有独立进程安装 CAS、撤销授权、更新来源检查和注册表安全回归通过。
- 使用实际 Core 安装器的 Web 管理、HTTP 与 Hub 绑定共 19 项通过，包括暂存后撤销授权、
  多工作区绑定 CAS、陈旧更新拒绝及 worktree 身份校验。
- Core 构建、已构建公开／内部导出 smoke、Server 类型检查、改动 ESLint 和差异检查通过。

```sh
bun test packages/core/src/panel-apps
bun run --cwd packages/core build
node scripts/smoke-core-exports.mjs
bun test packages/server/src/panels/management.test.ts packages/server/src/panels/management-http.test.ts packages/server/src/panels/hub-binding.test.ts
```

本增量没有把项目版本锁定记为完成。下一步必须共同接入项目绑定 schema／条件更新、
Web 运行目录、Desktop 多项目资源选择、主机原生任务解析和 Core Skill 扫描；当前 Desktop
的全局 descriptor 和 `preparePanelApp` 仍按 Panel ID 选第一项，不能直接给两个版本共用该路径。
之后还需升级／回滚 UI、活跃任务门禁、文档迁移与实际双项目跨设备验收。未发布新版本，
其他 Panel、Link 接入、远程中继及部署等原范围保持未完成。


### 增量 19：Core 项目包选择与相同版本 Skill（2026-09-24）

增加项目层 `panelAppPins` schema，每个 Panel 保存版本与包内容摘要，拒绝任意路径、非法
标识、无效摘要和多余字段。它不授予项目绑定或权限；用户全局层 pin 不参与项目选择。
通用远程配置写入禁止修改该字段，后续由可信 Host 的绑定／升级操作执行审阅和条件保存。

Core 提供项目包选择接口和严格项目层读取。配置损坏、null pin、缺失包、版本不符、
内容篡改、链接配置目录或断开的配置符号链接都不会转为最新版。严格读取复用设置管理器
的有界 JSON/YAML 路径，并保留普通设置读取的默认行为。全局注册表控制可发现性，固定
包不依赖当前可变安装目录完整；模拟另一项目更新时目录暂时移走，旧 pin 仍可解析。

Skill 扫描已接入项目版本：与异步安装检查共享摘要格式和大小限制，同步校验所选快照的
完整内容、manifest 和来源元数据后读取 Skill；worktree 继承主项目 pin，pin 更改进入缓存键。
即使管理页请求显示禁用 Skill，无效 pin 也不会偷偷读取全局版本。现有绑定、全局关闭、
子 Agent allowlist 等过滤继续保留。卸载全局注册后，保留的包文件不会自行恢复可用性。

验证：

- Core Panel、设置、Skill 管理及 allowlist 共 262 项通过。新增实际临时项目与安装包用例
  验证两项目分别使用 1.0.0／2.0.0 及匹配 Skill、更新 pin 后缓存刷新、worktree 继承、
  损坏／缺失／篡改拒绝、坏配置与断链、pin 不授予绑定、全局 pin 不继承，以及目录切换期间
  旧项目继续可读／全局卸载后不可用。
- Web 管理、HTTP、Hub 绑定原有 19 项回归通过；这些仍是旧 Host 流程回归，不是 Host pin UI 验收。
- Core 构建、公开／内部 dist 导出 smoke、Server 与 Desktop 类型检查、改动 ESLint 通过。

```sh
bun test packages/core/src/panel-apps packages/core/src/settings packages/core/src/skills/scanner.allowlist.test.ts packages/core/src/skills/management.test.ts
bun run --cwd packages/core build
node scripts/smoke-core-exports.mjs
```

尚未完成：Desktop／Web 绑定和升级写入、已有绑定迁移、执行目录选择、Desktop 多项目
同名 Panel 的 descriptor／protocol／inspection cache 选择、原生任务与远程页面一致性、
活跃任务门禁、版本切换 UI 与实际双项目跨设备验收。测试直接准备项目 pin 配置，不能
说用户界面已经支持完整版本锁定。整套版本和其他原目标仍未完成、未发布。


### 增量 20：Hub 项目版本绑定与真实 HTTP 执行（2026-09-24）

Hub 的管理列表、绑定与运行时共同启用项目包选择。新绑定先保留经过校验的安装包，
审阅安装／升级将版本与内容摘要写入项目设置，解除绑定删除该项目 pin。更新分别检查
项目选定版本与全局安装状态；Core 提交前重复检查，安装完成后在设置锁内检查项目状态。
另一设备并发解除绑定时返回冲突、保留其修改和原 pin；新全局包可能已安装，但不会静默
改动项目选择。旧项目的更新来源仍保留原分支，刷新预览后可明确升级到相同的新包。

网页入口、普通原生入口和后台工具解析均使用选定快照。管理快照和执行包的摘要不一致时
拒绝继续，防止跨两次读取的版本切换把旧权限与新程序拼在一起。全局包升级不改变另一
个已固定项目的 revision 或已打开页面授权。全局卸载继续撤销注册可用性，保留包文件
不表示仍获授权。

验证：

- 管理、HTTP、Hub 项目／worktree 绑定和真实 Hub 路由 24 项通过。其中新增两项目独立
  升级、陈旧全局更新预览拒绝、安装后并发解除绑定不被覆盖，以及缺失包／坏配置拒绝。
- 运行时与新项目版本 HTTP 集成共 49 项通过。新增测试使用实际 Core 安装器、真实 HTTP
  路由及 Node 后台程序：两项目固定 1.0.0 后更新全局安装，A 明确重新绑定 2.0.0，B 的
  已打开页面仍返回 1.0.0；两后台程序分别产出各自版本；重启 B 后读取原任务 ID 和结果；
  篡改旧包拒绝访问，不退回完整的新全局包。测试身份由 Host fixture 提供，不是完整登录
  或物理手机验收；认证／Origin／撤销另由现有真实 Hub 路由回归覆盖。
- Server 构建与类型检查、Desktop／mobile 类型检查、改动 ESLint 和格式／差异检查通过。

```sh
bun test packages/server/src/panels/management.test.ts packages/server/src/panels/management-http.test.ts packages/server/src/panels/hub-binding.test.ts packages/server/src/serve/hub-panels.test.ts
bun test packages/server/src/panels/project-packages.test.ts packages/server/src/panels/runtime.test.ts
bun run --cwd packages/server build
```

尚未完成：原生 Desktop 的多项目 descriptor／protocol／inspection cache 以及配对 Web
共同接入、已有未固定绑定迁移、任务跨项目升级后的历史展示／恢复、活跃任务完整升级门禁、
版本选择／回滚 UI 和文档迁移。配对 Desktop Web 在原生 reader 接通前明确保留相同的全局
读取方式，不能提前声称四组合版本一致性完成。当前修改仍在任务分支，未发布或部署；
六个 Panel、Link Host 接入、中继、真实手机和整套部署验收等原目标继续保留。


### 增量 21：Desktop 项目版本、协议资源与配对任务（2026-09-24）

Desktop 从每个主项目的 pin 选择安装包。同一个 Panel 保留原页签 ID，允许多个不同
hostId／revision 的项目变体；渲染器按项目解析页面、标题、图标和 Agent 工具，不会选
数组第一项。协议资源按项目更新，刷新一个窗口不删除其他窗口的旧版本。准备页签和
附加分区检查项目范围；pin 改变后，即使另一项目仍使用旧包，原项目旧页面与 bridge
调用也会被拒绝。异步列表返回顺序不再让旧刷新覆盖最新渲染器状态。

原生检查缓存同时检查选定路径、pin 标识和文件／注册表身份；异步检查期间切换版本、
同路径错误版本和损坏配置都不返回旧缓存。后台程序、目录授权、Cookie 后台授权与配对
Web 共用此选择。配对 Web 正式启用项目包读写，并向原生窗口发送绑定变更通知。更新
不会取消另一个固定版本项目的任务，但仍撤销跟随全局安装的旧项目；全局卸载继续撤销
全部项目与原生 guest。

验证：

- Desktop 缓存、项目包、协议入口、Registry 和 AgentPanelHost 共 33 项入口测试通过；
  其中协议入口启动独立 Electron mock 进程，内部 68 项通过。新增实际安装两版本与两
  项目的缓存切换，路径未变但版本错误、坏配置、全局卸载拒绝；页面和 Agent 工具变体、
  重复变体拒绝；单窗口刷新不撤销其他项目、A 换 pin 后旧页面拒绝而 B 保持、两个真实
  Node 原生任务分别输出 1.0.0／2.0.0、配对 HTTP 读取同一旧任务；坏项目不隐藏好项目。
- 生产 Desktop 完整构建、后续 main 构建、Desktop／mobile 类型检查、改动 ESLint 与差异检查通过。
- 真实 Electron＋配对 HTTP 运行 `--project-pins`：项目固定 1.0.0，全局实际安装不同页面／
  程序的 2.0.0；桌面与手机均保持 1.0.0。共享任务 ID、版本、队列、目录产物、测试账号
  版本、确认／重试、临时凭据清理、手机取消、退出登录、关闭远程服务、撤销设备与结果
  恢复全部通过；手机重新绑定同一版本会通知原生 Panel 列表，并保留已完成任务。

```sh
bun test packages/desktop/src/main/panel-app-project-packages.test.ts packages/desktop/src/main/panel-app-inspection-cache.test.ts packages/desktop/src/main/panel-app-protocol.test.ts packages/desktop/src/renderer/panels/PanelRegistry.panelApps.test.ts packages/desktop/src/renderer/panels/PanelRegistry.test.ts packages/desktop/src/renderer/panels/AgentPanelHost.test.ts
bun run --cwd packages/desktop build
bun run --cwd packages/desktop typecheck
node packages/desktop/scripts/e2e-shared-panel-tasks.mjs --project-pins
```

这不是完整版本管理产品验收：测试通过 Host fixture 或文件准备项目 pin；原生桌面绑定／
升级 UI 尚未写入对应条件 pin，旧绑定也没有迁移。还需要原生项目升级审阅、活跃任务
协调、任务历史跨项目升级读取／恢复、数据迁移／回滚以及真实双项目界面验收。物理手机、
真实服务商、全部 Panel、Link 接入、中继和部署等原目标不变。代码仍在任务分支，未发布。


### 增量 22：原生桌面条件绑定与并发状态（2026-09-24）

桌面的扩展列表和能力总览改用共享 PanelManagement 条件写入。主进程授权项目并冻结
主项目／worktree 关联，保存包版本及摘要；两次授权之间等待主 Agent 配置门禁时，窗口
或项目授权失效会拒绝提交。每个项目行使用读取时的 revision，不在点击时悄悄取得新版
revision 覆盖手机修改。绑定只修改指定 Panel，保留其他设备对其他 Panel 的变更；已有
pin 继续选择原包，全球安装新版不自动移动项目。普通 renderer 设置接口拒绝直接写
bindings、pins、legacy overrides。

管理快照在异步包检查前捕获项目状态，生成 revision 时使用同一份状态，返回前检查
并发变化及 pin 与包摘要一致性。损坏／链接设置不能作为空配置继续读取。安装接口返回
实际包摘要；新安装后的绑定须匹配该摘要。绑定失败或项目仍选择不同包时不再弹出
“已安装并绑定”成功提示。项目升级的完整审阅事务仍未完成，不能用此保护代替它。

验证：

- Host 条件绑定、共享管理／HTTP、项目包、桌面界面相关 7 文件 29 个入口测试通过。
  新增真实安装器测试：手机更新其他 Panel 后桌面绑定保留其修改，同 Panel 的旧 revision
  被拒绝，旧项目保持 1.0、新项目选择 2.0，等待门禁后重新授权，以及扫描中修改绑定
  不返回新旧状态混合的快照。
- 原生协议与桥接、项目包、主项目／worktree 和 Hub 路由 4 文件 10 个入口测试通过；
  协议入口仍运行隔离 Electron mock 测试组。
- 界面隔离测试补充实际开关携带旧 revision、显示手机并发冲突；安装后绑定失败、项目
  选择不同包两条路径都不显示绑定成功。新增后单独重跑该界面测试入口通过。
- Server 构建、Desktop 完整构建、Desktop／mobile 类型检查及改动 ESLint 通过。
- 生产 Electron＋配对 HTTP 分别运行普通旧绑定和 `--project-pins` 两种模式：原生 API
  materialize 项目 pin、记录实际摘要，拒绝陈旧解绑后再绑定；固定 1.0 对全局 2.0 不漂移。
  原有跨设备任务 ID、目录、Cookie 版本、队列、取消、退出、设备撤销、远程关闭和结果
  恢复流程仍通过。

```sh
bun test packages/desktop/src/main/panel-app-management.test.ts packages/server/src/panels/management.test.ts packages/server/src/panels/management-http.test.ts packages/server/src/panels/project-packages.test.ts packages/desktop/src/renderer/extensions/PanelsTab.test.ts packages/desktop/src/renderer/extensions/PanelsTab.updates.test.tsx packages/desktop/src/renderer/settings/CapabilitiesOverviewSection.test.tsx
bun test packages/desktop/src/main/panel-app-protocol.test.ts packages/desktop/src/main/panel-app-project-packages.test.ts packages/server/src/panels/hub-binding.test.ts packages/server/src/serve/hub-panels.test.ts
node packages/desktop/scripts/e2e-shared-panel-tasks.mjs --project-pins
node packages/desktop/scripts/e2e-shared-panel-tasks.mjs
```

剩余：原生项目安装／升级需将审阅、项目身份、权限和条件提交绑定成完整流程；旧绑定
批量迁移、全部活跃任务的升级协调、数据迁移与恢复 UI 仍待完成。目前主 Agent 配置
门禁不等于所有 Panel 任务的升级门禁。多项目行读取会检查各自选定包，后续优化必须
保留状态与 revision 一致性。其余 Panel、Link 接入、中继、真实手机和正式部署范围
继续保留，代码仍在任务分支，尚未发布。


### 增量 23：桌面项目安装／升级审阅（2026-09-24）

桌面的源码导入和更新改用共享 PanelManagement 审阅与提交，不再调用全局安装后由
页面另行绑定的两段操作。可信本地入口支持目录、ZIP 与固定 GitHub commit，HTTP
服务不启用本地来源。审阅由主进程持有，限定发起窗口和具体项目，关闭窗口撤销；缓存
有数量和时间限制。客户端提交的来源不能替换已审阅来源。安装、原生升级确认都要求
具体项目，并在提交前复查包内容、项目与全局目录状态及权限；返回失败不会显示成功。

更新从项目所选快照保留的原始来源获取新包，而不是跟随全局目录的另一来源。更新
通知也按所选项目的版本计算。审阅对话框显示目标项目与旧／新版本；切换项目后旧预览
不再打开，检查请求和迟到结果保留原目标。未选择项目时禁用项目更新按钮。成功安装
通过同一 Host 操作条件写入项目 pin，其他已固定项目继续使用原包。

验证：

- Core 来源检查、Desktop 管理和更新缓存、共享管理／HTTP、更新 Hook、真实审阅
  对话框测试入口共 8 文件 92 项通过。新增实际安装器流程覆盖项目 A 原始来源 1.0 →
  2.0、项目 B 不同来源固定 3.0；A 的更新检查不使用 B 的来源，更新不移动 B 的 pin。
- 拒绝把审阅凭据用于另一窗口或项目；拒绝未确认覆盖、手机在审阅后改绑定、来源字节
  改变、窗口 owner 关闭及重复使用已消费凭据。新安装保存实际包摘要；Web 未开启本地
  来源时无法调用该可信入口。Hook 验证项目切换后的在途请求不会显示到另一项目。
- Hub 项目包、原生协议／桥接、PanelsTab 3 文件 5 个入口测试通过；协议测试入口运行
  隔离 Electron mock 测试组。
- 生产 Electron 实际界面：先选择项目并处理信任提示，再点击“从源码更新”；审阅显示
  项目和 1.0.0 → 1.0.1，点击“确认并更新”后项目 pin 更新，实际新 guest 页面返回新
  marker；旧协议权限、跨设备条件存储及独立 Agent Plugin 自动化内容检查继续通过。
- Core、Server、Desktop 构建和 Desktop／mobile 类型检查、改动 ESLint 通过。最终 Hook
  增加结果缓存的项目字段后，单独重跑 Hook 测试和 renderer 构建通过。

```sh
bun test packages/desktop/src/main/panel-app-management.test.ts packages/desktop/src/main/panel-app-update-service.test.ts packages/core/src/panel-apps/update-check.test.ts packages/server/src/panels/management.test.ts packages/server/src/panels/management-http.test.ts packages/desktop/src/renderer/extensions/PanelsTab.updates.test.tsx packages/desktop/src/renderer/extensions/usePanelAppUpdates.test.tsx packages/desktop/src/renderer/extensions/PanelAppInstallReviewDialog.test.ts
node packages/desktop/scripts/e2e-panel-app.mjs
```

真实界面验收补齐了测试初始化：macOS 临时项目使用规范路径；进入扩展前先在侧栏选择
项目并处理该项目的信任提示。测试失败时记录隔离 profile 的页面文本，不改用裸 IPC
绕过界面验收。

限制与下一步：现有主 Agent 配置门禁仍不覆盖所有 Panel 后台任务、临时进程和准备
中的提交，需要实现统一升级协调。全局包与项目配置不是跨文件原子事务，安装后若
其他进程改变项目，条件写入会保留对方状态并返回失败，包可能已进入全局目录。旧未
固定项目迁移、多版本任务历史／恢复、数据迁移及回滚 UI、真实双项目同时开窗仍未完成。
其他 Panel、Link 接入、中继、手机和部署等完整目标继续保留，未发布。


### 增量 24：Panel 执行与包修改的准入协调（2026-09-24）

共享 Server 包新增进程内执行占用服务。Desktop、配对 Web 和 Hub 的 Panel 管理在
检查占用后同步阻止受影响的新调用，安装、升级、绑定和卸载提交结束后释放；原有主
Agent 配置检查继续执行。全局卸载检查所有项目，同项目的绑定／升级检查自身，其他
项目已经固定包版本时允许继续执行；未固定或配置无法读取的项目不能视为不受影响。
项目路径别名和 Git worktree 归到同一主项目，避免同项目被误判成独立项目。

原生任务从授权前登记提交占用，已入队记录（包括暂停队列）持续参与检查，重试遵循
相同准入规则。取消任务不提前释放占用，终态记录仍在实际清理时也计入。临时进程从
授权／审批前开始占用，一直保持到实际 close 和进程组退出清理。Agent 子任务保持到
session close；观察者回调失败不能打断任务及清理。

Desktop 与 Web 的实际桥接操作都有占用记录，RPC 超时只结束调用方等待，后台实际
操作结束后才释放。页面 Agent 工具超时后保留有界的待完成记录，迟到的真实响应或
页面撤销才释放，伪造其他 guest 的响应不能释放。尚未结束的页面工具会阻止更新，
用户可以等待其结束或关闭该页面；已经提交的后台任务仍按任务服务自己的生命周期处理。

验证：

- 执行门禁、真实任务存储、实际进程、Agent session 清理和真实 Core 安装器首轮
  5 文件 49 项通过；覆盖授权尚未返回时的更新拒绝、暂停队列、取消等待退出、重试、
  安装失败释放，以及项目 A 升级时项目 B 固定旧包继续运行。
- Web runtime 与路径别名／worktree、门禁测试 3 文件 52 项通过；实际 HTTP 在升级期间
  拒绝新进程（409），Web 等待审批及进程存活期间阻止修改，实际退出后允许修改。
- 共享管理 HTTP、runtime、Agent Host、Desktop 管理／Agent 服务和协议隔离入口
  7 文件 73 项通过。补充 Desktop 工具超时与实际 RPC 尚未结束的占用断言后，隔离
  Electron mock 入口再次通过（内部 68 项）。检查中发现 macOS 路径别名差异，统一
  规范路径后补充真实别名和 worktree 测试。
- 生产 Electron + 配对 HTTP：项目固定 1.0、全局目录为 2.0；原生任务暂停排队、运行、
  手机等待提交确认时，手机绑定修改和原生项目升级都被拒绝，项目保持 1.0。全部实际
  任务退出后，同一份未消费审阅成功将项目升级到 2.0。跨设备任务 ID、账号、文件交付、
  取消、退出登录、设备撤销、停止远程服务和结果恢复仍通过。
- Server 与 Desktop 构建、Desktop/mobile 类型检查和改动 ESLint 通过。

```sh
bun test packages/server/src/panels/execution-gate.test.ts packages/server/src/panels/package-mutation.test.ts packages/server/src/panels/agent-task-execution.test.ts packages/server/src/panels/tool-jobs.test.ts packages/server/src/panels/process-service.test.ts packages/server/src/panels/management.test.ts packages/server/src/panels/runtime.test.ts
bun test packages/desktop/src/main/panel-app-protocol.test.ts
node packages/desktop/scripts/e2e-shared-panel-tasks.mjs --project-pins
```

范围限制：这是同一 Host 进程中共享 Panel 入口的执行协调，不是跨进程分布式锁，不能
约束外部程序直接修改安装目录。Host 重启会把未完成持久记录标为 interrupted；其历史
版本读取／恢复与旧绑定迁移仍需后续完成。原生完整升级／恢复 UI、数据迁移与回滚、
其他 Panel、远程 Link 接入、中继、真实手机与正式部署仍未完成。代码保留在任务分支，
尚未发布，服务仓库仍依赖旧公开版本。


### 增量 25：旧项目版本固化与未打开项目的迁移基准（2026-09-24）

Core 在项目发现时批量迁移仅有 `panelAppBindings` 或旧 `panelAppOverrides.on` 的绑定。
迁移校验对应不可变包，并在共同配置锁下仅补齐仍然缺失的项目 pin；并发设备写入了
明确 pin 或解绑时保留其结果。已有配置、其它字段和全局禁用状态保持原样，未绑定、
明确 off 或未安装的 App 不会因为迁移获得权限。重复读取不重复写入已经固定的配置。

只做打开时迁移不足以保护未打开／离线磁盘上的旧项目，因此安装器在首次保留旧包、
替换旧安装或卸载时，将准确包引用保存在 `.versions/<id>/legacy-projects.json`。后续
更新和重新安装不移动这个首次捕获的引用。项目明确选择的版本优先于迁移基准；新项目
仍通过审阅／绑定选择当前安装包，不受旧项目基准限制。这里保留的是新迁移机制首次
捕获的已安装版本，不推测此前只有 ID 的配置曾使用过哪些历史版本。

同步 Skill 扫描在配置尚未固化时也读取该基准，避免后台 Agent 先读新版 Skill、页面
随后又迁回旧版。Desktop 发现和包检查缓存先迁移再捕获选择状态；Hub／配对 Web 管理
快照先迁移再计算条件 revision。不可变包缺失／损坏、基准文件损坏或链接不能退回
当前全局包。新的可变安装元数据也镜像保留基准引用，部分恢复遗漏基准记录时仍能发现
旧包缺失；未改变全局 installed.json 的格式，已有不可变包的元数据也不重写。

验证：

- 安装器、提交保护、原生入口、注册表安全、更新检查和包快照共 6 文件 102 项通过。
  覆盖未打开旧项目跨多次更新保持原包、迁移与升级竞争、并发设备 pin／解绑、卸载后
  重装、损坏／链接基准、旧包缺失及部分恢复遗漏基准记录。
- 增加多 App 批量迁移后，包快照文件 21 项通过；确认同时固化所有可用旧绑定，但不
  启用全局禁用、项目 off 和未安装的 App，原有业务设置保持。
- 共享管理、管理 HTTP、真实项目 HTTP、Desktop 项目包／管理／检查缓存及协议隔离
  入口共 7 文件 35 项通过。真实 Hub HTTP 新增此前未打开的旧格式项目，在全局 2.0
  下自动固化 1.0，实际页面和原生 Node 任务都返回 1.0；其它项目显式选择 2.0 仍通过。
- 生产 Electron + 配对 HTTP `--legacy-projects`：在启动前保留旧 ID 绑定并将全局包
  更新到 2.0；首次桌面发现即写入 1.0 pin，后续手机、账号、后台队列、文件交付及查询
  使用旧包。排队／运行／等待手机确认仍阻止升级，任务实际退出后明确审阅升级到 2.0。
- Core、Server、Desktop 构建、Desktop/mobile 类型检查和改动 ESLint 通过。

```sh
bun test packages/core/src/panel-apps/package-snapshots.test.ts packages/core/src/panel-apps/installer.test.ts packages/core/src/panel-apps/installer.commit-guard.test.ts packages/core/src/panel-apps/native-entries.test.ts packages/core/src/panel-apps/registry.security.test.ts packages/core/src/panel-apps/update-check.test.ts
bun test packages/server/src/panels/management.test.ts packages/server/src/panels/management-http.test.ts packages/server/src/panels/project-packages.test.ts packages/desktop/src/main/panel-app-project-packages.test.ts packages/desktop/src/main/panel-app-management.test.ts packages/desktop/src/main/panel-app-protocol.test.ts packages/desktop/src/main/panel-app-inspection-cache.test.ts
node packages/desktop/scripts/e2e-shared-panel-tasks.mjs --legacy-projects
```

范围限制：这是可用旧绑定的版本迁移和缺失时拒绝替换，不是数据文档迁移或回滚界面。
缺失旧包／损坏配置的项目仍需专门修复流程；任务历史跨版本恢复、完整多项目 UI 验收、
其他 Panel、远程 Link、设备中继、物理手机和正式部署继续保留在原目标中。未发布，
服务仓库公开依赖尚未升级到当前任务分支能力。

### 增量 26：后台任务包身份、重试校验与下载历史展示（2026-09-24）

新原生后台任务持久保存 Host 选择的 `package: {version, packageDigest}`，请求不能指定
或覆盖这份身份。Desktop 和 Hub 都从受授权项目安装包解析；配对 Web 继续复用桌面
协调器。输入准备前捕获、准备后入队前复查，执行与明确重试前再次核对版本及完整摘要。
同版本号但内容不同也拒绝执行。检查失败不改写原任务身份或重试记录；恢复原授权包后
可重试，同时仍受原 revision、入口摘要、项目绑定和权限检查约束。

重启保留原包信息和中断状态，不自动重放。旧无包身份记录保持可读，包感知 Host 将其
标为只读，不从当前包推断历史版本。独立旧调用者可省略解析器继续使用无版本记录，但
不能在缺少解析器时执行带包身份的新记录。桌面与 Web 在只读任务重试前直接返回说明，
不为无法执行的操作继续请求账号授权／执行确认。

下载 Panel 队列及历史显示任务版本，只缓存经过格式检查的包引用用于展示；Host 才是
执行授权依据。只读或不可重试任务禁用直接恢复并提示检查链接／设置后新建。项目升级
可能只改变访问权限、不改变任务序号，适配器现在也会接收同序号的只读状态更新。

验证：

- 持久任务、Web runtime、真实 Hub HTTP 首轮 73 项通过。新增五项覆盖请求伪造身份、
  排队重启与去重、同版本异内容、准备／排队期间内容变化、旧记录和缺失解析器。
- 真实 HTTP 追加项目升级后读旧结果、保持旧包身份并在确认前拒绝重试；该文件与
  Web runtime 最终 49 项通过。真实 Node 分别运行项目 1.0 和 2.0，并验证重启历史。
- 执行器、包修改与执行占用回归 19 项通过；Electron 隔离测试入口通过（内部 68 项）。
- 生产 Electron + 配对 HTTP `--project-pins` 通过；项目 1.0／全局 2.0 下，手机和
  桌面读取同一任务的版本和摘要。既有账号、目录、队列、取消、退出与撤销路径仍通过。
- 下载 Panel 完整套件 251 项通过，清单验证通过；独立后台 UI 回归 9 项通过。
  新增 390px／1440px 实际页面测试，截图确认窄屏提示换行、只读重试不可用。
- Server 构建、Desktop 构建及最终 main 构建、Desktop/mobile 类型检查、改动 lint
  和 diff 检查通过。日志位于 `/tmp/codeshell-task-package-*`。

范围限制：这是原生持久任务的版本身份与安全恢复检查，尚未完成项目升级／回滚修复
界面、数据文档迁移、全部 Panel、真实服务商／物理手机、独立 Link Host 接入或正式
部署发布。任务分支尚未合入发布，服务仓库依赖仍是公开 0.9.22。

### 增量 27：项目保留版本审阅与恢复入口（2026-09-24）

Core 增加有界保留包清单，逐包核对内容摘要和元数据，损坏或链接地址只报告不可用，
不作为可选包；目录中保留文件不代替全局安装登记。最多检查 512 个目录项、128 个包。
共享管理服务新增项目历史、恢复预览和确认恢复，提供当前／目标版本、权限及新增权限。
恢复凭据绑定设备 owner、项目状态、当前 revision 和目标包摘要，限时、单次使用；
确认时复查授权、目标内容和兼容性，通过执行占用检查及条件写入仅改变目标项目 pin。
运行任务阻止恢复，其他项目和全局目录继续使用原来版本，项目文档不被覆盖。

Hub 和桌面配对 Web 使用 `/versions`、`/restore-preview`、`/restore` 路由；Host 快照通过
`canRestorePackages` 声明支持。Web 展示当前版本、保留内容、损坏数量、权限变化和数据
兼容提醒；项目被其他设备改动后禁用旧确认。桌面项目绑定列表增加“项目版本”入口，
原生 IPC 复用同一服务，窗口关闭使审阅失效，切换项目会关闭原目标的对话框。

验证：

- Core 包快照与共享管理共 37 项通过：损坏／链接清单、卸载后不再授权、只恢复目标
  项目、全局仍为新版、项目数据保留、新增权限、owner／过期／撤销、并发解绑、运行
  占用及审阅后改包拒绝。
- Web 真实组件、管理 HTTP 和真实项目 HTTP 共 21 项通过；实际 Node 从项目 2.0
  恢复到 1.0 后运行旧脚本，旧任务保留相同版本／摘要并恢复匹配的只读状态。
- Desktop 管理和隔离真实 Radix 对话框入口共 8 项通过；新增桌面测试从绑定行展开
  历史、审阅新增权限，最后只提交目标项目和审阅 token。
- 生产 Electron `e2e-shared-panel-tasks.mjs --project-pins` 通过：先验证后台任务阻止
  升级，任务实际退出后升级到 2.0，再通过原生入口审阅恢复为 1.0，确认摘要与原任务
  一致。既有账号、配对 HTTP、目录交付、队列和退出／撤销路径仍通过。
- `node scripts/smoke-panel-package-history.mjs` 使用真实 Web 组件和受控 HTTP 回复，
  在 390px／1440px 验证权限审阅、确认前无写入、确认后一次请求及无横向溢出。
  截图位于 `/var/folders/1d/6__4f4y51g90nblfptt8s9v80000gn/T/codeshell-package-history-ui-R20W8V`。
  首次测试页遗漏全局 CSS 导致横向溢出，加载实际应用样式后验证通过。
- Core、Server、Desktop 构建和 Desktop/mobile、Web 类型检查通过；改动 ESLint、
  diff 检查通过。日志位于 `/tmp/codeshell-package-restore-*`。

范围限制：当前入口用于选中包及配置可正常读取的项目。损坏／缺失当前包、损坏项目
配置的逐项修复仍未完成；恢复程序版本不代表文档格式降级、数据快照或完整部署回滚。
其他 Panel、远程 Link 接入、中继、真实服务商与物理手机、部署及三仓正式发布继续
保留在完整目标内。此次提交仍未发布，服务仓库固定公开依赖未变。


### 增量 28：故障包隔离与跨设备保留版本修复（2026-09-24）

Core 将可执行包与不可用诊断分开返回。缺失／损坏 pin 包、无法读取旧迁移基准时，
不会退回全局最新版，也不会阻断其他正常 Panel 的迁移、页面、工具和 Skill。原始
项目配置及 pin schema 仍严格校验；配置整体损坏时拒绝读取，不自动覆盖。安装登记
仍是授权依据，卸载后保留文件不能继续提供执行或修复授权。桌面缓存仅准备当前查询
Panel 的迁移，保留原有全文件身份校验，避免每次缓存命中都重新读取全部包。

共享管理快照增加独立故障项，不生成可执行 descriptor。修复 revision 绑定登记信息、
失败包引用及项目绑定状态。历史、预览和确认恢复可以从故障项进入；原清单无法验证时，
目标版本所有权限均要求重新审阅。旧版本不明时显示“未记录”，不猜测历史版本。目标
包内容、权限兼容、审阅 owner／有效期、并发项目变化和执行占用仍由原 Host 检查。
确认仅改变当前项目 pin，不覆盖业务文档、历史任务或其他项目。

Desktop 绑定状态与 Web 快照显示故障卡片，通过“检查可用版本”进入已有审阅流程。
故障包不进入页面运行列表或推荐安装候选；列表不会把不可用包误报为尚未安装。
窄屏与桌面都解释原权限无法读取，确认前展示目标全部权限。

验证记录：

- Core 包快照 24 项通过，新增缺失包与正常 Panel 共存、损坏迁移基准与正常 Skill
  共存、逐项迁移、原 pin 保留、卸载及配置损坏拒绝等断言。
- 共享管理／HTTP／真实项目 HTTP／Web 组件首轮共 39 项通过。真实 HTTP 故意损坏
  已选 1.0 包，拒绝旧页面执行，审阅并恢复 2.0 后实际运行 Node 工具；旧任务产物
  保持可读且只读。管理测试另补原迁移基准损坏且版本未知的修复，最终管理文件
  18 项通过。
- Desktop 管理／项目缓存／检查缓存／协议隔离入口／真实 Radix 界面包装测试共
  19 项通过；覆盖独立故障行、权限审阅与只提交确认 token。协议包装同时执行其
  原有 Electron mock 内部回归。
- Web runtime、包修改范围、Desktop 缓存和 Web 组件回归共 74 项通过。
- Core／Server／Desktop 构建和 Desktop/mobile、Web 类型检查通过。
- 生产 Electron + 配对 HTTP `--project-pins` 通过：先验证任务执行期间不能升级、
  正常版本恢复，再损坏当前包，经真实 preload/IPC 诊断并审阅恢复可用包；恢复前
  不提供可执行扩展，恢复后扩展重新出现。原账号、队列、目录、注销／撤销流程仍通过。
- 生产 Web 组件浏览器冒烟覆盖 390px／1440px 的正常恢复和故障修复，确认前没有
  修改请求，确认后恰好一次 token 请求，无横向溢出。截图位于
  `/var/folders/1d/6__4f4y51g90nblfptt8s9v80000gn/T/codeshell-package-history-ui-QUjB0I`。
  视觉检查发现“已有故障包却
  显示未安装”的空态，已修正并复验。日志 `/tmp/codeshell-package-repair-*`。

范围限制：仅在原始配置可读且存在可用保留包时完成修复。损坏配置、全部历史包丢失、
不可写配置的处理及数据格式迁移仍需专门流程。其他 Panel、远程 Link、设备中继、
真实服务商／物理手机、完整部署与三仓发布仍未完成。代码尚在任务分支，服务仓库
固定公开依赖未变；不能把本增量等同于完整产品交付。


### 增量 29：独立 Link 执行与共享 Host 授权管理（2026-09-24）

Core 提供远程 Link 的 S256 授权交换、账号／操作／仓库范围发现和固定只读动作。
上游 GitHub token 留在 Link，Host 保留下游访问／刷新令牌；桌面 worker 仅通过
Host IPC 提交连接、grant 和动作参数，通用凭据、环境变量和 MCP bearer 路径不能
导出这些令牌。多连接必须明确选择，包括某个连接已失效的情况，失败不换用另一个账号。

刷新前条件保存 refreshing 标记，同进程共享一次请求；跨进程／重启遗留状态不重发。
实测 Bun fetch 在连接丢失时可能自动重发 POST，已改用 Node 单次 HTTP 请求；刷新结果
不明改为 reconnect，必须重新授权。令牌范围只能缩小，断开／替换后不恢复旧连接。

共享 Link 管理服务接入 owner 绑定的私有授权 attempt，信任配置由 Host getter 提供，
不接受浏览器传入 issuer 或客户端密钥。回调交换前后和保存前复查登录、配置、到期、
取消和目标记录；HTTP 提供发起／完成入口并复用查询、取消、快照、改名和断开。
断开先禁用本地记录，再撤销远端 grant，失败保留禁用记录供重试；成功条件删除。
这些接口尚未连到 Desktop／Hub 产品的配置和回调界面，不等于用户连接流程已经完成。

验证：

- 最终 Core、共享管理／HTTP、Desktop 凭据／MCP／连接适配器共 **125 项通过**，
  546 个断言；包含真实本机 HTTP，owner 隔离、重复回调、配置变化、并发修改、退出、
  取消、过期、刷新丢响应不重发、权限缩小及撤销失败恢复。
- `node scripts/smoke-remote-link.mjs /path/to/codeshell-services/apps/link-server/http.mjs`
  通过：真实独立 Link HTTP／SQLite／OAuth、共享 Host 发起和保存、LinkAction、刷新、
  服务端撤销和 Host 断开；上游仍为受控测试响应，不是 GitHub 真实账号。
- Link／Core／Server 构建、Desktop 全构建、Desktop/mobile 和 Web 类型检查通过。
  ESLint 0 错误，MCP 文件中 3 项原有警告；diff 检查通过。
- 初次桌面回归有 3 项默认 5 秒超时，彼时本机其他工作负载导致整体变慢；以 30 秒
  测试等待时间重跑 32 项全通过，随后最终 125 项仅 4.77 秒。未改变业务超时或断言。
  原始桌面构建耗时约 12 分钟，经原进程确认成功后才进行最终构建，没有重复启动替代。
- 主要日志：`/tmp/codeshell-remote-link-final-regression.log`、
  `/tmp/codeshell-remote-link-managed-smoke.log` 和
  `/tmp/codeshell-remote-link-management-*`。

限制：Host 采用既有凭据 cipher，桌面为加密存储，默认纯 Node cipher 不自动变为加密；
生产服务仍须完善对应配置。替换旧 grant／回调未保存的新 grant 的失败清理尚无持久
重试队列；旧 grant 撤销失败在授权结果显式标记，需 Link 管理端处理。IPC 未传播
AbortSignal，不承诺取消即时中断远程 I/O；发布结果前仍校验任务状态。原生／网页配置、
回调和管理 UI、真实 GitHub、完整 Desktop／Hub／物理手机以及三仓正式发布仍未完成。
服务仓库公开依赖仍为 0.9.22，不能把任务分支能力视为已部署。

### 增量 30：Hub 浏览器远程 Link 授权与部署配置（2026-09-24）

Hub CLI／SDK 接入独立 Link 配置，校验固定服务地址、客户端和工作台根路径回调；
部分配置、不安全地址、跨 Host 回调和 passcode 模式会拒绝启用，启动错误不回显密钥。
多项目控制服务经已有只读私密挂载向项目容器传递配置；配置摘要变化要求先停止旧容器，
不会在运行期间更换凭据。普通 Agent／Panel Agent worker 不继承客户端密钥环境变量。
公开 `/links` 包入口提供配置解析函数，服务产品仓库后续可通过兼容包采用。

Hub Link 页面新增独立账号入口，与已有本地连接共存；远程连接单独提供重新授权、
改名和断开，不显示手工 Token 表单。浏览器在同一标签页进入独立 Link，回调前保存
明确的项目路由、授权 ID、state 和到期时间，不保存令牌／verifier。回调页立即移除
地址栏中的 code，通过同一登录完成原项目授权，并提供返回原项目 Link 页的入口。
拒绝授权取消私有 attempt；响应结果不明只查询状态，不重复兑换授权码。StrictMode
复挂载共享一次提交。浏览器拒绝 sessionStorage 不影响普通工作台启动，授权失败有
明确提示。远端撤销失败的不可用状态刷新后仍可重试。

验证：

- 最终 **68 项通过、391 个断言**，包含共享授权管理、部署配置、受管项目配置、
  Docker provider、公开包接口、CLI、实际 Web 组件、回调路由、StrictMode、存储不可用
  和桌面／Hub 共享界面。Docker provider 测试使用受控 Docker 命令，不是真实容器授权。
- `smoke-remote-link-web.mjs` 使用实际构建 Web、真实 Node Hub、独立 Link HTTP／SQLite
  和 Chromium，在 390／1440px 完成登录、添加账号、同意授权、回调、返回连接列表、
  断开与拒绝授权。每次完成恰好一个回调 POST，地址栏与 sessionStorage 不保留授权码；
  实际查询 Link 服务确认 grant 已撤销。上游为受控 GitHub 账号响应。
- 已查看窄屏编辑页和回调页；修正标题栏“刷新”按钮换行后重新构建、复验并查看截图。
  最终截图：`/var/folders/1d/6__4f4y51g90nblfptt8s9v80000gn/T/codeshell-remote-link-web-ui-wPJQEA`。
- Server、Web、Desktop 构建与 Desktop/mobile、Web 类型检查通过，改动 ESLint／diff
  检查通过。日志位于 `/tmp/codeshell-link-ui-*`。
- 初轮 Docker 测试错误地预期运行中容器接受新配置，已改为验证拒绝并要求先停后启。
  扩展回归发现无 Location 的界面测试环境不能读取 href，已用可选 search 恢复兼容。
  一次回归与 Web 清理构建并发导致依赖产物短暂缺失；构建完成后再验证，最终全部通过。

限制：本轮端到端范围是单工作区 Node Hub＋真实浏览器；Docker 项目只完成配置路径的
实现和测试，真实项目容器授权还需单独验收。原生桌面、桌面配对 Web、Electron 云端
窗口外部导航、真实 GitHub、物理手机、凭据加密配置和持久失败清理仍待完成。服务仓库
仍固定公开包 0.9.22，本轮没有发布软件包、更新生产部署或宣称全部四组合完成。

### 增量 31：Electron 云端窗口与配对 Web 的 Link 授权（2026-09-24）

完成：

- 云端窗口允许由原工作台发起的独立 Link PKCE 导航，精确校验 callback、state 和挑战格式。
  临时导航资格仅覆盖一个 Link origin、最长十分钟；回到工作台、窗口关闭或过期后清除。
  子框架不能开启流程；保留无 preload、禁弹窗／webview、云端专属权限与下载边界。
  Link 页面标题显示实际域名，不继续冒充原云端工作台。
- Desktop 配对 Web 的共享 Link 服务接入受信配置。新增
  `CODE_SHELL_REMOTE_LINK_WEB_ORIGIN` 和精确 `/mobile/link/callback` 回调路径；普通 Hub
  仍使用 `/link/callback`。未设置配对 origin 时不启用，配置不来自浏览器请求。
- 移动入口先处理回调，再恢复工作台，避免先新建 HTTP 会话而改变授权 owner。
  临时记录固定原 workspace，回调立即移除 URL 中的 code、一次交换、随后返回原工作区。
  无效记录返回移动首页；不向另一个项目或新登录转交授权。
- 返回管理项目与当前聊天工作区不一致时，发送明确拒绝，保留草稿，需选择本项目会话
  或新建任务。桌面及配对 Panel Agent 的子进程环境移除可选 Link 客户端密钥。
- 实际 Electron 验证发现 OAuth 提交仍触发编辑器离页提示；提交保存状态后同步清除
  Link 编辑器自身 dirty 状态，再导航，保留其他草稿保护。

验证：

- 本增量相关 6 个单元／组件测试文件：34 pass、199 assertions，涵盖临时导航边界、
  过期、重复 state、跨域／子框架拒绝、移动回调路由、原 workspace 与错误聊天目标。
- 共享授权、配对 HTTP、CLI 和 managed-entry 回归 4 文件：31 pass、184 assertions。
- Server、Web、Desktop（含移动入口）构建通过；Web／Desktop TypeScript、变更文件
  ESLint 和 diff 检查通过。未在清理依赖产物时并发运行读取这些产物的测试。
- 扩展 `scripts/smoke-remote-link-web.mjs`，显式传独立 Link 的入口，支持 `web`、
  `electron`、`paired`。三个模式使用真实独立 Link HTTP／SQLite，GitHub 上游受控。
  Electron 通过生产桌面 IPC 打开隔离云端窗口，实际完成登录、同意、回调、返回、
  断开与拒绝，检查无本地 preload、实际 Link 域名标题和外部导航拦截。
- 配对模式启动实际 Desktop，使用既有回环回退和正式配对协议，在 390px 浏览器
  完成相同流程；另一已授权项目提交原 attempt 得到 404，未授权路径得到 403。
  在 Link 同意前撤销配对设备，返回原 callback 得到登录失效提示，没有新增本地凭据。
  测试将隔离进程网络接口枚举置空，未改变真实系统网络设置；不等同真实 LAN／公网手机测试。
- 原 `e2e-cloud-workbench.mjs` 回归通过：桌面打开云端、登录、创建项目、不改变本地
  项目注册表，关闭重开保留云端登录和项目。
- 回调截图已检查：桌面与 390px 无横向溢出，结果及返回入口可见。
  本轮日志位于 `/tmp/codeshell-link-cross-device-*`。

测试过程中修正了两处验收器问题：macOS 临时目录需比较 realpath；跨域导航后 CDP 可能
已丢弃创建授权响应正文，配对验收改为在真实响应交给页面前读取 ID，不伪造服务响应。

未完成：原生桌面 Link 管理入口、稳定 HTTPS 远程地址／可视化配置、真实 Docker 项目
OAuth、真实第三方账号、物理手机、旧 grant 清理的持久重试、通知、全部 Panel 流程及
公网部署和三仓兼容发布。本增量没有发布版本，也不将上述范围记为完成。
