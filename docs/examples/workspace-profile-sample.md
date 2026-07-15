# WorkspaceProfile（数字人）样例

全局库位置：`~/.code-shell/profiles/<name>/profile.json`。core 不内置任何领域 profile；
下面是一个 seedance 形态的完整样例。创建后在 Desktop 设置页「数字人」区块激活，
或在代码里调用 `activateWorkspaceProfile(sm, "seedance", cwd)`。

```json
{
  "name": "seedance",
  "label": "Seedance 分镜制片人",
  "description": "把剧本拆成 Seedance 提示词的制片人团队",
  "basePreset": "general",
  "plugins": ["seedance-pack"],
  "skills": [],
  "mcp": [],
  "agents": ["director", "art-designer", "storyboard-artist"],
  "mainInstruction": "你是制片人。收到剧本任务时按三阶段调度：先调 director 分析剧本结构，再调 art-designer 出服化道设定，最后调 storyboard-artist 生成分镜提示词。每阶段产出确认后再进入下一阶段。",
  "portableMemory": true,
  "version": "0.1.0"
}
```

要点：

- `plugins`/`skills`/`mcp`/`agents` 里的名字必须是已安装能力的名字；激活只是 force-enable，不负责安装。
- `portableMemory: true` → `~/.code-shell/profiles/seedance/` 下会累积这个数字人的可移植经验，跨 workspace 复用。
- 项目差异（品牌色、路径、技术栈）不写进 profile，写进各 workspace 的 `CLAUDE.md`（优先级高于 mainInstruction）。
- 优先级：本地 CLAUDE.md > mainInstruction > basePreset prompt sections；用户手写 capabilityOverrides > profile 展开的 overrides。
