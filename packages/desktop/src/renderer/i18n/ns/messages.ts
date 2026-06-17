/** messages/* (stream cards, agent/turn views, goal progress) + MessageStream. Owns `msg`. */
export const messagesNs = {
  zh: {
    msg: {
      // user message bubble
      user: {
        goal: "目标",
      },
      // assistant message footer
      assistant: {
        copy: "复制",
        copied: "已复制",
        copyAria: "将回答复制为纯文本",
      },
      // collapsible long content toggle
      collapsible: {
        expand: "展开",
        collapse: "收起",
      },
      // sub-agent card
      agent: {
        fallbackName: "agent",
        toolCount: "{count} tools",
      },
      // agent fan-out group card
      agentGroup: {
        count: "{count} 个子代理",
        running: "{count} 运行中",
        toolCount: "{count} tools",
      },
      // ask-user inline card
      ask: {
        other: "其它…",
        otherDesc: "输入自定义回答",
        otherPlaceholder: "输入自定义回答…",
        answerPlaceholder: "输入你的回答…",
        submit: "提交",
        answer: "回答",
      },
      // turn-end marker line
      turnEnd: {
        stoppedAt: "你在 {time} 后停止了",
        stopped: "你停止了本轮",
        timeoutAt: "本轮在 {time} 后超时停止",
        timeout: "本轮超时停止",
        errorWithDetail: "本轮出错停止:{detail}",
        error: "本轮出错停止",
      },
      // goal progress markers
      goal: {
        extendTimes: "再续 {count} 次",
        extendTurns: "再续 {count} 轮",
        approachingStopLimit: "目标接近续跑上限",
        approachingTurnLimit: "目标接近轮次上限",
        remainingTimes: " · 还剩 {count} 次",
        remainingTurns: " · 还剩 {count} 轮",
        extended: "— 已{label}",
        metRounds: "目标已达成 · 共 {count} 轮",
        exhausted: "目标续跑已达上限({count} 轮) · 已停下",
        notMetRound: "目标未达成 · 第 {count} 轮",
        gap: "— 还差:{gaps}",
        keepGoing: "— 继续推进",
      },
      // process / tool group header labels
      process: {
        toolGroupCommands: "已处理 {count} 条命令",
        elapsedSec: "已处理 {sec}s",
        elapsedMin: "已处理 {min}m",
        elapsedMinSec: "已处理 {min}m {sec}s",
      },
      // files-changed summary card
      files: {
        editedCount: "已编辑 {count} 个文件",
        review: "审核",
        reviewAria: "审核改动",
        reviewTitle: "审核(在面板中查看 diff)",
        undo: "撤销",
        undoing: "撤销中…",
        undoAria: "撤销改动",
        undoTitle: "撤销这一轮的文件改动(回到该轮编辑前)",
        undoDisabledAria: "撤销改动(不可用)",
        undoDisabledTitle: "只能从最新一轮开始撤销",
        redo: "重新应用",
        redoing: "应用中…",
        redoAria: "重新应用改动",
        redoTitle: "重新应用这一轮的文件改动",
        showMore: "再显示 {count} 个文件 ▾",
        undoneFiles: "已撤销 {count} 个文件",
        redoneFiles: "已重新应用 {count} 个文件",
        partialFailure: "部分失败:{failed}/{total}({name})",
        undoFailed: "撤销失败:{error}",
        redoFailed: "重新应用失败:{error}",
        confirmTitle: "撤销 {count} 个文件的改动?",
        confirmBody: "这些文件会还原到该轮编辑前的内容,本轮新建的文件会被删除。撤销后可「重新应用」。",
        cancel: "取消",
        confirmUndo: "确认撤销",
        reviewModalTitle: "审核改动 — {count} 个文件",
        close: "关闭",
      },
      // markdown code block
      markdown: {
        copyCode: "复制代码",
        copyCodeAria: "复制代码",
        copy: "copy",
        copied: "copied",
        expandAll: "展开全部 ({count} 行)",
        collapse: "收起",
      },
      // file/attachment tool cards
      tool: {
        openWith: "打开方式",
      },
      // message timestamp prefix
      time: {
        yesterday: "昨天 {clock}",
      },
    },
  },
  en: {
    msg: {
      user: {
        goal: "Goal",
      },
      assistant: {
        copy: "Copy",
        copied: "Copied",
        copyAria: "Copy reply as plain text",
      },
      collapsible: {
        expand: "Expand",
        collapse: "Collapse",
      },
      agent: {
        fallbackName: "agent",
        toolCount: "{count} tools",
      },
      agentGroup: {
        count: "{count} sub-agents",
        running: "{count} running",
        toolCount: "{count} tools",
      },
      ask: {
        other: "Other…",
        otherDesc: "Type a custom answer",
        otherPlaceholder: "Type a custom answer…",
        answerPlaceholder: "Type your answer…",
        submit: "Submit",
        answer: "Answer",
      },
      turnEnd: {
        stoppedAt: "You stopped this turn after {time}",
        stopped: "You stopped this turn",
        timeoutAt: "This turn timed out after {time}",
        timeout: "This turn timed out",
        errorWithDetail: "This turn stopped on error: {detail}",
        error: "This turn stopped on error",
      },
      goal: {
        extendTimes: "Extend {count} more",
        extendTurns: "Extend {count} turns",
        approachingStopLimit: "Goal nearing its continuation limit",
        approachingTurnLimit: "Goal nearing its turn limit",
        remainingTimes: " · {count} left",
        remainingTurns: " · {count} turns left",
        extended: "— {label} done",
        metRounds: "Goal met · {count} turns total",
        exhausted: "Goal continuation limit reached ({count} turns) · stopped",
        notMetRound: "Goal not met · turn {count}",
        gap: "— Remaining: {gaps}",
        keepGoing: "— Keep going",
      },
      process: {
        toolGroupCommands: "Processed {count} commands",
        elapsedSec: "Processed {sec}s",
        elapsedMin: "Processed {min}m",
        elapsedMinSec: "Processed {min}m {sec}s",
      },
      files: {
        editedCount: "Edited {count} files",
        review: "Review",
        reviewAria: "Review changes",
        reviewTitle: "Review (view diff in panel)",
        undo: "Undo",
        undoing: "Undoing…",
        undoAria: "Undo changes",
        undoTitle: "Undo this turn's file changes (back to before this turn's edits)",
        undoDisabledAria: "Undo changes (unavailable)",
        undoDisabledTitle: "Can only undo starting from the latest turn",
        redo: "Reapply",
        redoing: "Applying…",
        redoAria: "Reapply changes",
        redoTitle: "Reapply this turn's file changes",
        showMore: "Show {count} more files ▾",
        undoneFiles: "Undid {count} files",
        redoneFiles: "Reapplied {count} files",
        partialFailure: "Partial failure: {failed}/{total} ({name})",
        undoFailed: "Undo failed: {error}",
        redoFailed: "Reapply failed: {error}",
        confirmTitle: "Undo changes to {count} files?",
        confirmBody:
          "These files revert to their contents before this turn's edits, and files this turn created are deleted. You can reapply afterward.",
        cancel: "Cancel",
        confirmUndo: "Confirm undo",
        reviewModalTitle: "Review changes — {count} files",
        close: "Close",
      },
      markdown: {
        copyCode: "Code copied",
        copyCodeAria: "Copy code",
        copy: "copy",
        copied: "copied",
        expandAll: "Expand all ({count} lines)",
        collapse: "Collapse",
      },
      tool: {
        openWith: "Open with",
      },
      time: {
        yesterday: "Yesterday {clock}",
      },
    },
  },
} as const;
