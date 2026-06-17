/**
 * UI translation dictionary (中文 / English).
 *
 * Structure: `messages.<lang>.<...nested keys>`. The **zh** tree is the source
 * of truth — its shape drives the `TranslationKey` type, so every key is
 * statically checked at the call site (`t("...")`). The `en` tree is typed as
 * a *partial* mirror: missing English entries are allowed and fall back to zh
 * at runtime (see `translate.ts`), so you can add zh keys first and translate
 * later without breaking the build.
 *
 * --- How to add a key ---
 * 1. Add it to the `zh` tree below (any depth of nesting is fine).
 * 2. Optionally add the same path to `en`. If you skip it, the zh text is used.
 * 3. Use it at a call site: `const { t } = useT(); t("common.cancel")`.
 *    Interpolate with `t("greeting.hello", { name: "Ada" })` for `{name}`.
 *
 * Keep keys grouped by feature/area (e.g. `settings.*`, `chat.*`). Only a few
 * sample keys live here now — translating the ~1100 scattered strings is a
 * separate effort.
 */

export const messages = {
  zh: {
    common: {
      cancel: "取消",
      confirm: "确认",
      save: "保存",
      delete: "删除",
      archive: "归档",
      restore: "恢复",
      remove: "移除",
      more: "更多",
      expand: "展开显示",
    },
    language: {
      label: "界面语言",
      zh: "中文",
      en: "English",
    },
    greeting: {
      hello: "你好,{name}",
    },
    topbar: {
      expandSidebar: "展开侧栏",
      collapseSidebar: "折叠侧栏",
      openPanel: "打开面板",
      closePanel: "关闭面板",
      hasActiveGoal: "有活跃目标",
    },
    sidebar: {
      newConversation: "新对话",
      search: "搜索",
      extensions: "扩展",
      automation: "自动化",
      credentials: "凭证",
      projects: "项目",
      conversations: "对话",
      addProject: "添加项目",
      emptyHint: "点 + 添加你的第一个 repo",
      pinned: "已置顶",
      newChatIn: "在 {name} 中开始新对话",
      pinProject: "置顶项目",
      unpinProject: "取消置顶",
      revealInFinder: "在「访达」中打开",
      renameProject: "重命名项目…",
      renameProjectTitle: "重命名项目",
      renameProjectMessage: "项目显示名称",
      archiveConversations: "归档对话",
      archiveConversationsTitle: "归档项目对话",
      archiveConversationsMessage: "归档「{name}」下所有 {count} 条未归档会话？",
      removeProject: "移除",
      removeProjectTitle: "从侧栏移除项目",
      removeProjectMessage: "确定从侧栏移除「{name}」吗？",
      removeProjectDetail: "本地会话保留 — 重新添加同一目录可恢复。",
      renameSession: "重命名…",
      renameSessionTitle: "重命名会话",
      renameSessionMessage: "会话标题",
      copySessionId: "复制 session ID",
      deleteSession: "删除",
      deleteSessionTitle: "删除会话",
      deleteSessionMessage: "确定删除会话「{name}」吗？",
      confirmArchive: "确认归档",
      sessionRunning: "运行中",
      sessionAsking: "待输入",
      sessionUnread: "未读",
      automationLabel: "自动化",
    },
    settings: {
      general: {
        languageTitle: "语言",
        languageDescription: "应用界面语言。实际文案翻译仍在逐步完善中。",
        langZhDescription: "界面使用中文",
        langEnDescription: "Use English for the interface",
      },
    },
  },
  en: {
    common: {
      cancel: "Cancel",
      confirm: "Confirm",
      save: "Save",
      delete: "Delete",
      archive: "Archive",
      restore: "Restore",
      remove: "Remove",
      more: "More",
      expand: "Show more",
    },
    language: {
      label: "UI Language",
      zh: "中文",
      en: "English",
    },
    greeting: {
      hello: "Hello, {name}",
    },
    topbar: {
      expandSidebar: "Expand sidebar",
      collapseSidebar: "Collapse sidebar",
      openPanel: "Open panel",
      closePanel: "Close panel",
      hasActiveGoal: "Active goal",
    },
    sidebar: {
      newConversation: "New chat",
      search: "Search",
      extensions: "Extensions",
      automation: "Automation",
      credentials: "Credentials",
      projects: "Projects",
      conversations: "Conversations",
      addProject: "Add project",
      emptyHint: "Click + to add your first repo",
      pinned: "Pinned",
      newChatIn: "Start a new chat in {name}",
      pinProject: "Pin project",
      unpinProject: "Unpin",
      revealInFinder: "Reveal in Finder",
      renameProject: "Rename project…",
      renameProjectTitle: "Rename project",
      renameProjectMessage: "Project display name",
      archiveConversations: "Archive conversations",
      archiveConversationsTitle: "Archive project conversations",
      archiveConversationsMessage: "Archive all {count} unarchived sessions under “{name}”?",
      removeProject: "Remove",
      removeProjectTitle: "Remove project from sidebar",
      removeProjectMessage: "Remove “{name}” from the sidebar?",
      removeProjectDetail: "Local sessions are kept — re-add the same directory to restore them.",
      renameSession: "Rename…",
      renameSessionTitle: "Rename session",
      renameSessionMessage: "Session title",
      copySessionId: "Copy session ID",
      deleteSession: "Delete",
      deleteSessionTitle: "Delete session",
      deleteSessionMessage: "Delete the session “{name}”?",
      confirmArchive: "Confirm archive",
      sessionRunning: "Running",
      sessionAsking: "Awaiting input",
      sessionUnread: "Unread",
      automationLabel: "Automation",
    },
    settings: {
      general: {
        languageTitle: "Language",
        languageDescription: "Application interface language. String translation is still being filled in.",
        langZhDescription: "界面使用中文",
        langEnDescription: "Use English for the interface",
      },
    },
  },
} as const;

/**
 * Recursively flattens the nested zh tree into dotted key paths,
 * e.g. `{ common: { cancel: string } }` → `"common.cancel"`.
 */
type Dict = Record<string, unknown>;
type DottedKeys<T extends Dict, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends Dict
    ? DottedKeys<T[K], `${Prefix}${K}.`>
    : `${Prefix}${K}`;
}[keyof T & string];

/** Type-safe union of every translation key, derived from the zh tree. */
export type TranslationKey = DottedKeys<typeof messages.zh>;

export type Messages = typeof messages;
