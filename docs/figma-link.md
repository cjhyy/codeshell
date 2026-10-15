# Figma Link 完整读取

Figma Link 通过本地 PAT/OAuth 或独立 Link 服务读取已授权的 Design／FigJam 文件。
`get_file` 默认读取页面和顶层节点（`depth=2`），需要时再读取目标节点子树或全文。
读取范围内的文字、尺寸、布局、颜色、字体、效果、组件属性、样式和向量路径
保留在原始节点结构中。客户端和远端服务采用同一新契约，不提供旧版摘要回退。

## 动作与参数

所有动作都接收 `file_url_or_key`，也支持 `file_key`，两者不能同时指定。远端连接还必须
明确提供 `connectionId`，文件 key 必须已经包含在该连接的文件授权范围内。

| 动作              | 返回                                                                                          | 可选参数                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `get_file`        | 指定范围的 `document`、`components`、`componentSets`、`styles`、文件元数据和 `pages` 名称列表 | `ids`、`depth`、`full`、`version`、`geometry`、`plugin_data`、`branch_data` |
| `get_nodes`       | 指定节点的完整子树及各节点关联的组件、样式元数据                                              | 必须有 `ids`；可带 `depth`、`version`、`geometry`、`plugin_data`            |
| `get_images`      | 节点渲染图的 URL 映射，保留失败节点的 `null`                                                  | 必须有 `ids`；可带 `scale`、`format`、`version` 和 SVG／边界选项            |
| `get_image_fills` | `meta.images` 中图片填充引用到素材 URL 的映射                                                 | 无                                                                          |
| `get_comments`    | 评论、作者及定位信息                                                                          | 无                                                                          |

`ids` 支持逗号分隔字符串或数组，也支持 `node_ids`；一次最多 50 个，不能同时使用两种
参数。节点链接的 `node-id=1-2` 可以推导为 API 的 `1:2`。`depth` 是 1–100 的整数，
`get_file` 省略时默认 2，只有显式 `full: true` 才不限制深度，且 `full` 与 `depth`
不能同时指定。`full: false` 使用默认深度。`get_nodes` 已明确目标 IDs，省略 `depth`
时读取这些节点的完整子树；`get_file` 从文件根计算深度，`get_nodes` 从目标节点计算。
`geometry` 仅接受 `paths`。`plugin_data` 接收插件 ID 或 `shared` 的列表。

渲染格式支持 `png`、`jpg`、`svg`、`pdf`，`scale` 范围为 0.01–4。布尔选项包括
`svg_outline_text`、`svg_include_id`、`svg_include_node_id`、`svg_simplify_stroke`、
`contents_only` 和 `use_absolute_bounds`。返回 URL 由 Figma 生成，可能到期；需要长期
保留时通过已有的授权文件／Panel 资源导入流程保存，不把临时 URL 当成永久素材。

## 读取设计稿

先调用 `LinkAction({ provider: "figma" })` 检查实际连接和动作，选择正确账号。
例如先读取页面与顶层画板：

```json
{
  "provider": "figma",
  "action": "get_file",
  "connectionId": "已保存的连接 ID",
  "params": { "file_url_or_key": "Figma 文件链接", "depth": 2 }
}
```

根据原任务需要，再用 `get_nodes` 批量读取目标页面或画板子树；只有确实需要整个
文件时使用 `get_file` 加 `full: true`。需要向量数据时传
`geometry: "paths"`。使用 `get_images` 获取视觉参照，使用 `get_image_fills` 获取
`imageRef` 对应素材。复刻流程和设计格式转换仍属于设计工作台，不放进 Link Host。

每次 Figma JSON 读取最多 8 MiB。超过上限会明确报错，提示使用 `depth`、`ids` 或
`get_nodes` 缩小范围；不截断节点树后声称全文完整。范围参数通过 `requestedDepth`／
`requestedFull`／`requestedNodeIds` 标明，正常响应不伪造 `truncated: false`。模型工具输出的展示预览
可能另有省略；此时应读取持久化的完整工具结果，不重复授权或重复抓取全文。

## 授权与交互

- 初次连接可以在同一次 OAuth 流程中选择用户发送的那个文件；不必先连接空账号再
  发起第二次文件授权。只允许服务端回调返回明确请求的文件集合。
- 已授权文件沿用原用户请求读取，不额外发送一条摘要请求。补权完成后等待当前
  会话可以继续，再读取必要结构并按原任务需要继续；成功、关闭和会话切换受原提交身份约束。
- 新增文件仍需真实的远端文件授权。聊天中的 URL 是具体文件意图，不允许模型、
  历史记录或第三方正文中的链接自行扩大授权范围。
- 每个动作参与目录发现和独立 scope 检查。已有 grant 不会自动获得新的动作 scope。
  缺少新动作权限时，应重新授权该连接，不能绕到另一个账号执行。
- 远端 Link 的第三方凭证保存在独立服务，`UseCredential` 不导出它。读取设计内容
  应继续使用 `LinkAction`，本地凭证为空不等于远端 Link 没有文件权限。
- `/make/` 链接明确返回不支持的文件类型，不能把它误报为 Design 文件授权失败。
  当前实现不声称能够读取 Make 源码，也不提供修改 Figma 设计稿的能力。

接口依据：[Figma Files endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/)
和 [Figma OAuth scopes](https://developers.figma.com/docs/rest-api/scopes/)。实现测试覆盖
本地和远端按需读取、目录发现、scope 检查、跨文件拒绝、大响应及聊天续读；这些受控测试
不能替代真实账号和生产部署的验收。
