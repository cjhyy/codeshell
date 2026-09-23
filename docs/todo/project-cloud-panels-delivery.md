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
