# Panel App Starter

这是最小可运行的 CodeShell Panel App 模板，适合直接复制到你的 repo 中维护。

## 创建自己的面板

1. 复制整个 `starter` 文件夹。
2. 修改 `.codeshell-panel/panel.json` 中的 `id`、`title`、`version` 和权限。
3. 在 `app/` 中维护 HTML、JavaScript、CSS 和静态资源。
4. 打开 CodeShell 的 **扩展 → Panel Apps → 选择源码文件夹**，选择复制后的目录。
5. 审查权限并安装。安装后，从右侧面板的 `+` 菜单打开它。

也可以将目录推送到公开 GitHub 仓库，然后使用 **从 GitHub**。如果 Panel App
位于 monorepo 中，同时填写分支/标签和面板子目录；CodeShell 会先临时拉取，
再显示同一套权限及文件审查。

开发过程中继续修改原始文件夹。需要加载新版本时，回到 Panel Apps 管理页，
在应用卡片上点击 **从源码更新**，审查变更后应用；不需要再次选择目录。

Panel App 包不能包含 Skills、Agents、Commands、Hooks、MCP 或普通 Plugin
manifest。完整格式和 Host API 见 [`docs/panel-apps.md`](../../../docs/panel-apps.md)。
