export const activity = {
  zh: {
    activity: {
      backgroundWork: "后台工作",
      backgroundDescription:
        "委派任务、子 Agent 和后台进程，以及需要处理的操作。普通会话请在会话管理中查看。",
      conversations: "会话管理",
      diagnostics: "诊断日志",
      legacyRuns: "旧版运行记录",
      legacyRunHint:
        "查看旧版运行状态与产物。这里的任务文本并非完整模型 Prompt；新的调用输入与输出请在执行观测查看。",
      inspectSession: "查看当前会话的模型调用",
      viewTrace: "查看模型调用",
      clearFilters: "清除所有筛选",
      retry: "重试读取",
      unavailable: "任务暂时无法读取，请重试。",
      taskSearch: "搜索任务、内容或 ID…",
      summary: "完整摘要",
      taskError: "完整错误信息",
      logLatest: "跳到最新日志",
      logCopy: "复制显示的日志",
      logCopied: "已复制日志",
      logCopyFailed: "无法写入剪贴板，请重试。",
      logLimit: "读取行数",
    },
  },
  en: {
    activity: {
      backgroundWork: "Background work",
      backgroundDescription:
        "Delegated tasks, subagents, background processes and operations requiring attention. Browse ordinary conversations in conversation management.",
      conversations: "Conversations",
      diagnostics: "Diagnostic logs",
      legacyRuns: "Legacy runs",
      legacyRunHint:
        "Browse legacy run status and artifacts. Task text is not a complete model prompt; inspect new model inputs and outputs in Execution traces.",
      inspectSession: "Inspect current conversation’s model calls",
      viewTrace: "Inspect model calls",
      clearFilters: "Clear all filters",
      retry: "Retry loading",
      unavailable: "Tasks are temporarily unavailable. Please retry.",
      taskSearch: "Search tasks, content or IDs…",
      summary: "Full summary",
      taskError: "Full error details",
      logLatest: "Jump to latest logs",
      logCopy: "Copy displayed logs",
      logCopied: "Logs copied",
      logCopyFailed: "Could not write to the clipboard. Please retry.",
      logLimit: "Lines to read",
    },
  },
} as const;
