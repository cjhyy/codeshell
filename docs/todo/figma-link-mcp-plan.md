# Figma Link：MCP 与 REST 能力规划

状态：2026-10-15 重新规划。现有 REST 读取已实现；本文新增的官方 MCP 接入、Make
资源读取及统一入口尚未实现或通过正式产品验收。16:20–16:29（Asia/Singapore）以
CodeShell 名称注册收到 HTTP 403；17:00–17:06 的隔离名称对照证明仅把注册名称改为
Codex 就可通过注册，并经用户授权完成真实 MCP 连接和文件节点 metadata 读取。
该实验未修改产品代码或安装应用配置，不代表 CodeShell 已获得官方准入。

## 官方 OAuth 实际试连

2026-10-15 在已安装的 CodeShell 0.9.42 中，通过 MCP 设置的新连接表单使用官方
URL、独立 OAuth、空 Client ID 与端点启动自动发现/动态注册。测试未复用已有 REST
或其他客户端凭证，本次操作未提交服务器表单。应用在浏览器打开前失败，Host 日志记录
`discovery_registration / protocol_error / 403`。

随后用隔离 HOME、仅内存 CredentialStore 和实际 `McpOAuthService`、SDK 1.31.0
复现相同握手，记录了以下真实网络结果。探针配置的 authenticated fetch 与 SDK
Client 未执行到，不能算作已验证连接或内容读取。

| 阶段                                             | 请求                                                                 | 实测结果       |
| ------------------------------------------------ | -------------------------------------------------------------------- | -------------- |
| MCP 资源授权元数据                               | `GET https://mcp.figma.com/.well-known/oauth-protected-resource/mcp` | 200            |
| OAuth 授权服务器元数据                           | `GET https://api.figma.com/.well-known/oauth-authorization-server`   | 200            |
| 动态客户端注册                                   | `POST https://api.figma.com/v1/oauth/mcp/register`                   | 403            |
| 用户授权、令牌交换、MCP 工具发现、内容读取和刷新 | 未到达                                                               | 未通过真实验收 |

结论是当前 CodeShell 请求被官方注册端点拒绝；本次没有取得 token，也没有读取到
Figma 内容。403 的具体策略原因未从响应证据中取得，不能直接断言 Catalog 白名单
就是此次拒绝原因。官方准入要求是独立的已知条件。探针正常退出仅表示诊断完成，
不表示 OAuth 成功。[脱敏试连回执](figma-mcp-live-validation-2026-10-15.json)

这份回执保留当时的失败事实。随后按用户明确要求做了以下隔离名称对照；正式产品
方案仍应取得 Figma 认可的 CodeShell 客户端注册/配置，不以已有 REST 授权替代
MCP 授权，也不复制其他客户端的已有凭证。

### 注册名称对照与实际读取

2026-10-15 17:00（Asia/Singapore），使用同一次生产 `McpOAuthService` 登录的同一
loopback 回调地址、scope 与注册请求体，先以 `client_name: CodeShell` 发送注册请求，
得到 HTTP 403、纯文本 `Forbidden`；只把 `client_name` 改为 `Codex` 后得到 HTTP 200，
SDK 随即生成官方账号授权流程。第一次因 120 秒内没有完成浏览器授权而超时，未取得
token。此对照可以确认注册名称影响本次准入结果；不能据此声称服务端只检查名称。

17:04 的后续尝试只以 Codex 名称注册一次，不重复对照。隔离构建把生产代码的回调
等待时间从 120 秒延长至 600 秒，其余 OAuth 逻辑不变。在 Chrome 的 Figma 官方
页面完成授权后，实测结果如下；代理没有点击授权按钮：

| 阶段             | 实测结果                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| OAuth token 交换 | HTTP 200，取得本次新签发 token                                                                                      |
| MCP initialize   | 成功；实际 MCP 客户端名称仍为 CodeShell                                                                             |
| 工具发现         | 成功，列出 45 项工具；没有执行其中的写入工具                                                                        |
| 文件读取         | `get_metadata` 读取用户原先提供的 Design 文件 `0:1` 节点，返回 138,003 UTF-8 字节，含真实节点标记，`isError: false` |
| 清理             | 诊断正常退出，本地退出并清空内存凭证；没有写入安装应用配置                                                          |

测试全程使用隔离 HOME、内存 CredentialStore、生产 authenticated fetch 和 SDK
Streamable HTTP transport，没有复用其他客户端的 token 或 client ID。证据只保存
字节数、节点标记判定和内容 hash，不保存读取内容或凭据。授权服务器未公布吊销
端点，也没有观察到吊销请求，因此本地清理不能宣称上游 token 已被吊销。

本次明确验证了“覆盖注册名称后可以完成 OAuth、MCP 连接与真实 metadata 读取”。
尚未验证设计上下文、截图、Make resources、其他工具、刷新或安装应用中的完整配置。
P0 的正式 CodeShell 身份接入验收继续保留未完成；不把隔离诊断自动变成正式产品默认。
[脱敏对照与读取回执](figma-mcp-name-comparison-2026-10-15.json)

Figma 员工在官方论坛明确说明注册时会按 `client_name` 做白名单检查，这补充了之前
仅凭 HTTP 403 无法定位原因的证据。[官方说明](https://forum.figma.com/report-a-problem-6/figma-s-approach-breaks-the-core-promise-of-mcp-52507)

## 决策与当前授权

Figma Link 提供一个产品入口，内部按能力选择官方 MCP 或 REST。设计理解与复刻优先
使用可用的官方 MCP；原始节点、精确导出和评论保留 REST。两种通道分别保存授权和
连接状态，不能用一个“已连接”标签推断所有能力都可用。

OAuth 是授权机制，MCP 与 REST 是不同的调用接口。当前远端 Link 链路是：

`CodeShell → 自有 Link 服务的 downstream grant → 服务托管的 Figma OAuth → REST API`

Host 保存的是 CodeShell Link grant，实际 Figma 上游 token 留在独立服务。它既不是
可导出的 Figma PAT，也不是官方 MCP 凭证。Figma 官方说明 MCP 使用独立 OAuth，
不配置 REST scopes；接入官方 MCP 必须新建对应的 MCP 授权，不能把当前 Link secret
作为 `mcp.figma.com` 的 Bearer 使用。[Figma scopes](https://developers.figma.com/docs/rest-api/scopes/)

自建一个 MCP 包装现有 LinkAction 可以沿用自有服务的授权，但它只增加 MCP 协议
入口，不会获得官方 MCP 的设计上下文、Make 资源或画布写入能力，不作为本方案主线。

## 官方 MCP 接入条件

官方远端地址是 `https://mcp.figma.com/mcp`。Figma 当前要求客户端在 MCP Catalog
中；新客户端需申请接入。仓库尚无经过真实验证的 CodeShell/Figma MCP client
配置，因此先验证合法准入与真实 OAuth 握手，再将官方 MCP 标记为可用，不能仅凭
通用 HTTP transport 已实现就宣称接入完成。[远端安装](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)

Figma 桌面 MCP 可作为可选本地通道，依赖用户的 Figma 桌面应用及当前会话；其
tools/resources 能力需单独发现和验收，不假定与远端完全一致。使用 Codex、Claude
等外部运行时的官方 MCP 时，授权由该运行时持有，不读取或复制它们的凭证文件。
[桌面安装](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/)

## 能力划分

以下是目标路由，不代表当前已支持 MCP。只发布实际连接已发现、Host 已审阅的能力。

| 用户任务                      | 首选通道                                                     | 读取策略与边界                                                                                  |
| ----------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 了解页面和节点结构            | MCP `get_metadata`；REST `get_file` 也可提供                 | 先目录与浅层结构，尊重链接中的 node-id                                                          |
| 理解、分析、复刻设计          | MCP `get_design_context` 与 `get_screenshot`                 | 获取目标节点的语义上下文和视觉参照，再交给工作台实现                                            |
| 获取原始布局、文字和向量节点  | REST `get_nodes` / `get_file`                                | `get_file` 默认两层；`get_nodes` 默认完整所选子树，可用 `depth` 缩小；整文件需显式 `full: true` |
| 获取设计变量与组件映射        | MCP `get_variable_defs` / `get_code_connect_map`             | 单独发现可用性，不把普通节点 JSON 宣称为完整设计系统                                            |
| 导出图片、SVG、PDF 或原始素材 | MCP `download_assets`；REST `get_images` / `get_image_fills` | 按目标节点导出，临时 URL 通过资源导入保存                                                       |
| 查看 FigJam 内容              | MCP `get_figjam`；REST 节点用于原始数据                      | 图表上下文与截图按任务读取                                                                      |
| 读取 Figma Make 项目代码      | 官方 MCP resources                                           | 先获取文件清单，再读取所需源码；不送入 Design REST 端点                                         |
| 读取评论与讨论定位            | REST `get_comments`                                          | 保留线程关系与定位，按需要调用                                                                  |
| 创建、编辑或写回画布          | 官方 MCP 的写入能力，后续阶段                                | 与只读能力分开启用，按明确用户写入意图授权并回读验证                                            |

工具依据：[官方工具列表](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)。
Make 依赖 MCP resources，客户端仅能执行 tools 不足以支持 Make；这也修正了之前
“Make 不支持”的表达：现有 REST 路径不支持，官方 MCP 提供项目资源读取路径。
[Make resources](https://developers.figma.com/docs/figma-mcp-server/bringing-make-context-to-your-agent/)

官方写入能力还有客户端、席位和文件编辑权限要求，不能由只读连接状态自动推导。
首阶段不启用通用 JavaScript 执行型 `use_figma`；不能仅因代码声称“只检查”就把它
归类为只读。[写入条件](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas/)

## 按需读取与统一入口

1. 识别用户本次提交的文件类型与 node-id：Design、FigJam、Make 分别路由。识别
   `/make/` 不代表给 REST 解析器放开未知文件类型。
2. 查看已选连接真实可用的能力。仅为用户当前任务所需的通道发起连接，不要求用户
   为普通 REST 读取同时连接 MCP。
3. 先结构，再按目标节点取上下文和截图。Make 先目录再源码；不因用户粘贴链接就
   自动读取整个项目。MCP 不可用时，只有同一明确选定账号的 REST 授权已满足当前
   文件与动作范围，才使用 REST 提供的实际能力；不自动换账号或扩大范围。
4. 结果记录实际 backend、connection、文件/节点、版本或观测时间、截断与持久化
   引用。缓存按连接、文件、节点、参数和版本隔离；不把 MCP 语义上下文伪装成原始
   完整节点树，也不把缓存命中误报为刚从 Figma 读取。
5. MCP 身份、授权、客户端准入、席位限制、限流、文件权限和内容超限分别显示，
   不统一提示“重新授权”。Figma 的 MCP 额度取决于账号计划和席位，不在产品中
   固定写死可能变化的次数。[访问与限流](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access/)

UI 保留一个 Figma 设置入口，内部显示“API 连接”和“MCP 连接”的实际账号、能力与
状态；首次需要另一个通道时解释新增授权用途。同邮箱不足以自动合并两个账号或
继承文件范围。成功或关闭的聊天卡片继续清理，同文件已在读取时不发重复请求。

文件访问不应反复触发上游 OAuth：MCP 在有效授权内按文件权限访问；REST 新文件
的资源范围更新，应后续通过可信账号 owner 与明确文件意图完成自有服务授权，
在上游 scopes 未变化时避免重走 Figma OAuth。当前 REST grant 不能自行扩展白名单；
需先补服务端 owner 绑定和资源授权协议，再改变现有流程。两类 token 始终独立。

## 可复用实现与必须补齐的基础能力

现有通用 MCP 已有 Streamable HTTP、SDK OAuth discovery/DCR/PKCE 登录、Host token
托管与刷新、连接 probe 和设置界面。运行阶段使用 Host authenticated fetch 注入
Bearer；新的授权及 scope step-up 仍需 Host UI/lifecycle，不能假设 transport 已会
自动弹出并完成授权。

代码入口：

- `packages/desktop/src/main/mcp-oauth-service.ts`：登录、凭证托管、刷新与退出。
- `packages/core/src/tool-system/mcp-manager.ts`：HTTP transport、authenticated fetch、
  工具结果和资源读取。
- `packages/desktop/src/renderer/settings/McpSection.tsx`：连接与授权管理。
- `packages/core/src/sources/adapters/mcp-resource.ts`：既有 MCP 数据源入口。
- `packages/core/src/links/figma.ts` 与独立 services 仓库的 Figma adapter：已有 REST
  参数、文件范围、响应预算与结果归一化。

接入前必须补齐：

- **每次发送的凭证绑定**：核验所选 credential 的 MCP server URL、resource/issuer
  绑定与实际目标，控制重定向及跨域 Header；设置中仅提供匹配该目标的 OAuth。
  现有登录阶段检查不能替代运行阶段检查。
- **完整资源协议**：`resources/list` 分页与 `resources/templates/list`；保留
  `resource_link`、embedded resource、`structuredContent` 和 resource 的 URI、
  MIME、text/blob。当前 manager 仅列第一页、读取时拼接 text，工具输出仅处理
  text/image，不能直接宣称 Make 资源已完整可用。
- **可诊断的资源错误**：不再将所有 list 异常吞成“没有资源”；区分不支持、需
  授权、权限拒绝、限流与网络错误。
- **范围及预算**：资源链接绑定真实连接、用户选择的文件及实际读取计划；无从
  验证归属时不自动读取。文本、二进制、图片和持久化输出各自有界，超限明确说明，
  不静默丢资源后声称完整。取消、断开和会话切换撤销未完成读取。

通用 auth/resource/权限机制留在 Core/Host；Figma URL、语义动作和 backend 路由
属于 connector/plugin。复刻、代码转换、素材落地及画布工作流由设计工作台负责。
不将 Figma 专用 MCP 工作流塞入通用 MCPManager，也不在薄云端建立常驻设计工作台。

## 实施顺序与验收

| 阶段               | 交付                                                      | 完成条件                                                                                                        |
| ------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| P0 接入验证        | 确认官方客户端准入；补运行时 endpoint/credential 绑定     | 合法真实 OAuth、身份探测、断开/刷新通过；不匹配目标在发 token 前拒绝                                            |
| P1 MCP 只读与资源  | Design 上下文/截图、FigJam、Make 文件清单及按需读取       | 分页、模板、结构化/二进制内容、限流、超限和取消受控测试通过，并完成真实 Design/Make 验收                        |
| P2 统一 Figma Link | 能力路由、两种连接状态、用户链接范围、REST 新文件授权优化 | 无额外全文读取、无跨账号回退、无重复续读；新文件无须在 scopes 不变时重走上游 OAuth，且不能由 read bearer 自扩权 |
| P3 写入扩展        | 需要时接入原生画布写入与独立结果核查                      | 客户端/席位与编辑权限满足、用户明确写入意图、未知终态不自动重放、真实文件验收                                   |

P0 未满足时，REST 已有功能继续可用；MCP-only 能力明确显示尚不可用，不用摘要
模拟成功。任何受控 fixture 都不替代客户端准入、真实账号和正式部署验收。无需
新增旧版摘要兼容分支。
