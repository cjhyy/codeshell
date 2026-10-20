# Figma Link：API 与官方 MCP

Figma 在「凭据 → Link → Figma」提供统一连接入口，分别显示 API 与 MCP 的账号和状态。
API 沿用本地 PAT 或独立 Link 服务的 OAuth；MCP 通过官方
`https://mcp.figma.com/mcp` 建立独立 OAuth。两种凭据和文件权限不互相替代，也不自动切换账号。
不新增旧版摘要兼容路径。

## 按能力选择通道

| 任务                                    | 通道                                                                       | 读取策略                                       |
| --------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------- |
| 页面结构、原始节点、布局、文字、向量    | API `get_file` / `get_nodes`                                               | 文件默认两层；按需要读取所选子树或显式全文     |
| PNG/JPG/SVG/PDF、原始填充素材、评论     | API `get_images` / `get_image_fills` / `get_comments`                      | 明确节点和格式；临时素材 URL 不视为永久文件    |
| 设计到代码的语义上下文                  | MCP `get_design_context`                                                   | Design 必须指定节点；Make 先返回文件清单       |
| Code Connect 组件映射、动画时间线       | MCP `get_code_connect_map` / `get_motion_context`                          | 指定节点，只有任务需要时读取                   |
| Make 项目源码                           | MCP `list_resources` / `read_resource`                                     | 先发现清单，再读取同账号、同文件返回的资源 URI |
| 设计库与设计系统搜索                    | MCP `get_libraries` / `search_design_system`                               | 显式请求，按实际发现的能力提供                 |
| 节点目录、视觉参照、变量、FigJam 上下文 | MCP `get_metadata` / `get_screenshot` / `get_variable_defs` / `get_figjam` | 作为按需补充，截图和变量不是 MCP 独有能力      |

MCP 补充官方语义上下文、Make 源码资源、Code Connect 和动画数据；REST 文件接口不直接
提供这些相同形态的结果。截图、变量及常规导出在两类接口中存在重叠。本次仅启用审阅过的
只读动作，未开放官方画布写入或通用脚本执行。
[官方工具说明](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)、
[Make resources](https://developers.figma.com/docs/figma-mcp-server/bringing-make-context-to-your-agent/)。

## 授权生命周期

MCP 使用 discovery、动态注册和 PKCE，在系统浏览器完成官方 OAuth。按用户认可的实测方案，
仅 Figma 动态注册的 `client_name` 使用 `Codex`，实际 MCP initialize 客户端仍为 `CodeShell`。
授权界面会显示该注册名称；这不是 CodeShell 已获得官方 Catalog 准入的声明。
注册策略变化仍可能影响连接。[实测回执](todo/figma-mcp-name-comparison-2026-10-15.json)

连接时仅发现工具并执行 `whoami` 验证账号，不读取设计或源码。验证成功后由 Host 原子保存
凭据；Desktop 沿用系统加密的 CredentialStore。重启后复用授权，临近到期时自动刷新，
refresh token 轮换也原子持久化。永久失效要求重连；网络故障不一律误报成权限失效。

API 与 MCP 分别重新授权、刷新和断开。断开清理本地连接，并在上游公布吊销端点时尝试吊销；
上游未公布端点时，不把本地清理声称为远端 token 已吊销。授权取消、账号替换、断开及旧回调
不能覆盖新连接或使旧连接复活。

MCP Link 凭据由 Host 持有，Worker/Renderer 不能导出 token，也不会在通用 MCP 凭据选择器中
作为可复用连接出现。每次网络请求核验固定 endpoint、resource/issuer、所选账号及动作授权，
拒绝重定向、项目同 ID 覆盖、跨文件 Make URI 和未经清单发现的资源。

## API 参数

所有动作支持 `file_url_or_key` 或 `file_key`，两者互斥。远端 API 连接还必须明确
`connectionId`，文件 key 必须在该连接的资源范围内。

| 动作                               | 主要参数                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `get_file`                         | `ids`、`depth`、`full`、`version`、`geometry`、`plugin_data`、`branch_data` |
| `get_nodes`                        | 必须 `ids`；可带 `depth`、`version`、`geometry`、`plugin_data`              |
| `get_images`                       | 必须 `ids`；可带 `scale`、`format`、`version`、SVG 与边界选项               |
| `get_image_fills` / `get_comments` | 文件标识                                                                    |

`ids` 可为逗号分隔字符串或数组（最多 50），也支持互斥的 `node_ids`。节点 URL 中的
`node-id=1-2` 会规范为 `1:2`。`depth` 为 1–100；`get_file` 默认 2，显式 `full:true`
才读取全文，与 `depth` 互斥。`get_nodes` 默认读取所选节点的完整子树。
`geometry` 只接受 `paths`；`plugin_data` 接收插件 ID 或 `shared` 列表。
渲染格式支持 `png/jpg/svg/pdf`，`scale` 为 0.01–4。

## MCP 参数与资源

使用 `LinkAction({ provider: "figma" })` 查看连接及动作；有多个同通道账号时必须指定
`connectionId`。示例：

```json
{
  "provider": "figma",
  "action": "get_design_context",
  "connectionId": "已保存的 MCP 连接 ID",
  "params": {
    "file_url_or_key": "https://www.figma.com/design/FILE/Design?node-id=1-2",
    "client_frameworks": "React"
  }
}
```

MCP 也支持 `file_key`，必要时带 `file_type`（`design/figjam/make/slides`）及 `node_id`。
详细 Design 读取必须提供节点；`get_metadata` 未指定节点时只请求页面目录。
工具选项包括 `client_languages`、`client_frameworks`、`force_code`、`disable_code_connect`、
`recursive`、`queries`，实际有效性由官方工具 schema 决定。

Make 先 `get_design_context` 或 `list_resources`；分页使用返回的 `nextCursor`。
随后 `read_resource` 带相同文件和清单返回的 `uri`。只接受该 Make 文件的官方 source/image
命名空间，不把 `file://` URI 解释成本地文件，不因清单返回一百个文件就自动逐个读取。
资源发现记录绑定连接、授权和文件，30 分钟到期后重新发现。

两种通道单次响应预算均为 8 MiB，超限明确报错并提示缩小节点或资源范围，不静默截断后
声称全文完整。MCP 保留结构化结果、资源 URI/MIME/text/blob、错误标记和分页信息；图片
通过已有受控落盘机制返回引用。上游内容是外部数据，不作为新的授权或代理指令。

聊天仅在真实 MCP 动作缺少授权时请求对应连接；授权成功后恢复同一提交的原动作、节点和
参数。单纯连接账号不附带读取。API 成功不会消费待恢复的 MCP 动作，关闭或切换会话不会
让旧卡片和旧回调重新触发读取。

## 验证边界

受控回归覆盖持久化、重启、refresh 轮换、永久失效、撤销竞争、Host token 隔离、账号选择、
Make 资源归属、分页、响应预算及聊天恢复。真实账号此前已验证官方 OAuth、45 项工具发现
和 Design metadata 读取。真实 Make 内容、其他账号计划/席位以及生产发布仍需对应账号验收，
不能从受控测试推断已全部通过。
