/**
 * English translations for core UI surfaces.
 *
 * Keys are the original Chinese strings — this lets us migrate
 * incrementally: a `t("新对话")` call returns "New Chat" in English
 * mode, and "新对话" in Chinese mode (the key itself). Components
 * that haven't been migrated just keep their hardcoded Chinese and
 * are unaffected.
 *
 * Only add entries for strings that have been migrated to `t()`.
 */
export const en: Record<string, string> = {
  // ── Sidebar ──────────────────────────────────────────────────────
  "新对话": "New Chat",
  "搜索": "Search",
  "扩展": "Extensions",
  "自动化": "Automations",
  "凭证": "Credentials",
  "项目": "Projects",
  "对话": "Chats",
  "添加项目": "Add Project",
  "展开显示": "Show more",
  "点 + 添加你的第一个 repo": "Click + to add your first repo",
  "已置顶": "Pinned",
  "更多": "More",
  "确认归档": "Confirm archive",
  "确认": "Confirm",
  "归档": "Archive",
  "运行中": "Running",
  "待输入": "Awaiting input",
  "未读": "Unread",

  // ── Sidebar context menus ───────────────────────────────────────
  "取消置顶": "Unpin project",
  "置顶项目": "Pin project",
  "在「访达」中打开": "Reveal in Explorer",
  "重命名项目…": "Rename project…",
  "重命名项目": "Rename project",
  "项目显示名称": "Project display name",
  "归档对话": "Archive chats",
  "归档项目对话": "Archive project chats",
  "移除": "Remove",
  "从侧栏移除项目": "Remove project from sidebar",
  "本地会话保留 — 重新添加同一目录可恢复。": "Local sessions are kept — re-adding the same folder restores them.",
  "重命名…": "Rename…",
  "重命名会话": "Rename chat",
  "会话标题": "Chat title",
  "复制 session ID": "Copy session ID",
  "恢复": "Restore",
  "删除": "Delete",
  "删除会话": "Delete chat",
  "条未归档会话？": "unarchived chats?",
  "确定删除会话": "Delete chat",
  "吗？": "?",
  "在 ${0} 中开始新对话": "Start new chat in ${0}",

  // ── SidebarNav ──────────────────────────────────────────────────
  "会话": "Sessions",
  "审批": "Approvals",
  "运行": "Runs",
  "日志": "Logs",
  "设置": "Settings",

  // ── SettingsMenu ────────────────────────────────────────────────
  "打开设置…": "Open Settings…",
  "切换语言": "Switch Language",

  // ── GeneralSection ──────────────────────────────────────────────
  "语言": "Language",
  "应用界面语言。实际文案翻译仍在逐步完善中。": "Interface language. Translation is still a work in progress.",
  "界面使用中文": "Display in Chinese",
  "Use English for the interface": "Use English for the interface",

  // ── ChatView (input area) ───────────────────────────────────────
  "可向 agent 询问任何事。输入 @ 使用插件或提及文件": "Ask anything. Type @ to use plugins or mention files",
  "要求后续变更": "Queue a follow-up change",
  "正在思考…": "Thinking…",
  "发送": "Send",
  "停止": "Stop",
  "引导": "Guide",
  "语音输入": "Voice input",
  "语音输入 (尚未实现)": "Voice input (not yet implemented)",
  "添加图片": "Add image",
  "添加图片（也支持拖拽 / 粘贴）": "Add image (drag & drop / paste also works)",
  "当前模型不支持图片；切换模型后即可上传": "Current model doesn't support images; switch model to upload",
  "打断当前轮，并把全部后续变更合并发送": "Interrupt and merge all pending changes into one message",
  "打断当前轮，并把全部后续变更合并成一条立即发送": "Interrupt and merge all pending changes into one message sent immediately",
  "打断当前轮，并发送这条输入": "Interrupt current turn and send this input",
  "全部引导": "Guide all",
  "清除后续变更": "Clear pending changes",
  "已缓存": "Queued",
  "条，将在本轮结束后发送": "queued — sent after the current turn ends",

  // ── Empty state ─────────────────────────────────────────────────
  "要在 ${0} 中构建什么?": "What would you like to build in ${0}?",
  "开始一个无项目对话": "Start a conversation without a project",
  "在下方选择一个项目，或直接在「不使用项目」模式开始": "Select a project below, or start without one",
};
