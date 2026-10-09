# Link 目录能力协商

公开 Host 0.9.28/0.9.29 的目录解析器会拒绝含未知动作的整个 provider。
Services 新增 GitHub `update_issue` 后，直接返回 12 个动作会使旧客户端丢失整个
GitHub 入口；已有连接或旧目录缓存不能修复这次合法但空的发现结果。

Host 现在通过 `X-CodeShell-Link-Capabilities` 发送编译时 adapter 的 scope 集合：
`{"version":1,"scopes":[...]}`。Services 仅在公开 provider 目录响应上求交；无 header
返回固定已发布基线（十家全配置时共 29 动作，GitHub 11 动作），新旧双方均支持时才显示
新增动作。新 Host 仍可消费忽略 header 的旧 Services。协议与限制见
[Services 目录契约](https://github.com/cjhyy/codeshell-services/blob/main/docs/link-catalog-negotiation.md)。

无 header 与显式空集合不同；后者返回空目录。坏 JSON、错误版本／结构、重复 scope、
超过 128 项或 4,096 UTF-8 字节返回 400，不降级为默认目录。Host 仅对原有 404/501
使用受约束的旧服务 fallback；400、重定向及非法目录均不扩大可执行能力。

该协商只控制发现。内部执行 policy、OAuth scope metadata、同意页、连接和 grant
保留独立权限校验；既有 grant 不会新增 `update_issue`。没有新增 UI、侧栏入口或隐式授权。

验收分别覆盖实际公开旧 reader 对未修复 Services 的失败对照，以及旧／新 Host ×
旧／新 Services 四组合。Node 原生进程在 Core 导入前设置私有 HOME 和精确本地 origin
guard，并记录负探针、PID/PPID 与 HOME hash。源码、目录发现及本地协议验证不等同于
生产部署、真实第三方账号、实体手机或真实写操作验收；当前发布的 0.9.29 tag 不改写。

实际旧 reader 使用已安装的公开 0.9.28 编译包；0.9.29 的解析器源码与其相同已另行
核对，不声称另外执行了 0.9.29 包。旧 Services 使用 `d67e62c` 的完整 git archive，
未修复失败对照为 `4bec9da`；新 Services 使用本次真实 HTTP 入口。
失败对照返回 12 动作却被旧 reader 解析为空；四组合依次得到 11／11／11／12 动作，
另外八个真实 HTTP 边界检查通过。六个 Node 22.16 进程的 30 次导入前负探针均拒绝，
13 个业务请求仅为自有本地 catalog GET，没有 provider 回调或授权状态写入。
Services 全套 287 项测试、21 项浏览器验收和完整格式检查通过。
