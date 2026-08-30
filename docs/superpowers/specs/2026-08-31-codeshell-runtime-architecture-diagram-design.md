# CodeShell 整体运行时架构图设计

## 目标

使用 Archify 为当前 CodeShell 仓库生成一张源码可核验、适合首次理解系统的高层运行时架构图。交付强类型 JSON IR、可交互 standalone HTML，以及视觉检查证据。

## 图形类型与风格

- 类型：`architecture`
- 质量档：`showcase`
- 主语言：中文（保留 package、协议、命令和产品名原文）
- 风格：默认 Classic，支持 Viewer 内置明暗主题切换
- 动画：关闭
- 规模：10–12 个主要节点

## 信息结构

采用自上而下的分层运行时视图，而非平铺全部 workspace package：

1. **用户入口层**：Desktop、TUI、Web / Remote。
2. **宿主与传输层**：Desktop Host、Server / Web transport、Chat gateway。
3. **核心编排层**：Core Engine，突出 Session、Prompt、LLM、Tool、Protocol 的统一编排职责。
4. **能力扩展层**：Coding、Arena、Pet，经 `@cjhyy/code-shell-core/extension` 装配。
5. **执行与集成层**：Link / Credentials、CDP Browser、外部 MCP / CLI Agent。
6. **模型层**：LLM Providers。

主路径为：用户从入口发起请求 → Host 创建/恢复运行 → Core Engine 组装上下文并驱动模型 → 模型请求工具 → 能力或外部集成执行 → Protocol 流式事件回到 UI。

## 边界原则

- Core 保持 UI 无关、领域无关。
- Coding、Arena、Pet 作为可选能力包，不画成 Core 内建模块。
- Desktop / TUI 使用 `/internal` 宿主表面；能力包只依赖 `/extension`。
- Web 是浏览器客户端逻辑层，不误画成当前独立完整 UI。
- Server 是纯 Node 远程传输层，不误画成已完成的账号网关。
- 图中只表达当前已实现结构，不混入未来服务端账号体系。

## 证据与验收

结构事实以 `CODESHELL.md`、根 `package.json`、`docs/architecture/00-overview.md`、`docs/architecture/12-package-boundaries-and-release-units.md` 及对应 package manifest 为依据。

验收标准：

- Archify showcase 校验包含 9 项 artifact checks，0 composition errors、0 warnings。
- `deliver` 成功并返回 JSON/spec 与 HTML 的 SHA-256 收据。
- `visual-check` 在 1440×900、1600×1000、1920×1080、2048×1320 无横向或纵向溢出。
- 人工检查最小和最大尺寸的明暗主题截图，确认结构清晰、标签可读、主路径明确。
