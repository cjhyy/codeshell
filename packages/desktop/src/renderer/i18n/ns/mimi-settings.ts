/** The Mimi settings page shell, its new sections, and its settings-center entry. */
export const mimiSettings = {
  zh: {
    mimiSettings: {
      navLabel: "Mimi 设置分区",
      sectionPicker: "选择设置分区",
      back: {
        pet: "返回 Mimi",
        settings: "返回设置",
        credentials: "返回凭证",
        other: "返回",
      },
      section: {
        appearance: {
          title: "形象与显示",
          description: "显示开关、角色，以及停靠或移动模式。",
        },
        conversation: {
          title: "对话",
          description: "Mimi 管理对话用的模型，以及它怎么称呼你、怎么说话。",
        },
        notifications: {
          title: "通知与主动",
          description: "Mimi 什么时候、通过哪里告诉你会话的进展。",
        },
        rules: {
          title: "规则与跟进",
          description: "Mimi 正在按哪些规则提醒你。",
        },
        memory: {
          title: "记忆",
          description: "Mimi 长期记住的事和已归档的对话。",
        },
        connections: {
          title: "消息连接",
          description: "绑定微信、飞书、Telegram 等渠道，你不在电脑前时 Mimi 也能联系你。",
        },
      },
      appearance: {
        presenceFailed: "设置没有生效：{error}",
        dismiss: "知道了",
        sizeNamed: "{size}（{name}）",
        sizeHint: "角色高度，单位是逻辑像素。只影响移动模式。",
      },
      rules: {
        systemTitle: "全部会话",
        active: "已开启",
        paused: "已暂停",
        events: "提醒：{events}",
        eventSeparator: "、",
        event: { done: "完成", failed: "失败", blocked: "卡住" },
        channelAuto: "不在电脑前时推到消息渠道",
        channelDesktop: "只在桌面",
        channelIm: "推到 {channel}",
        toggleHint: "在“通知与主动”里开关。",
        openNotifications: "去开关",
        sessionNote:
          "单个会话的提醒在会话里的铃铛上设置，Mimi 派出的工作完成或卡住时会自动告诉你。",
      },
      memory: {
        memoriesCount: "长期记忆",
        autoCount: "其中自动提取",
        journalCount: "事件档案",
        loadFailed: "记忆读取失败：{error}",
        saveFailed: "开关没有保存：{error}",
      },
      entry: {
        label: "Mimi",
        keywords: "Mimi 宠物 桌宠 角色 通知 提醒 免打扰 微信 飞书 Telegram 钉钉 消息连接 记忆",
        description: "Mimi 有自己的设置页：形象、对话、通知、提醒规则、记忆和消息连接都在那里。",
        open: "打开 Mimi 设置",
      },
    },
  },
  en: {
    mimiSettings: {
      navLabel: "Mimi settings sections",
      sectionPicker: "Choose a settings section",
      back: {
        pet: "Back to Mimi",
        settings: "Back to Settings",
        credentials: "Back to Credentials",
        other: "Back",
      },
      section: {
        appearance: {
          title: "Look & display",
          description: "Show or hide Mimi, pick a character, and choose docked or moving mode.",
        },
        conversation: {
          title: "Conversation",
          description:
            "The model for Mimi's manager chat, and how Mimi addresses and talks to you.",
        },
        notifications: {
          title: "Notifications & proactivity",
          description: "When, and where, Mimi tells you how your Sessions are going.",
        },
        rules: {
          title: "Rules & follow-ups",
          description: "The rules Mimi uses to notify you.",
        },
        memory: {
          title: "Memory",
          description: "What Mimi remembers long-term, and archived conversations.",
        },
        connections: {
          title: "Messaging connections",
          description:
            "Connect WeChat, Lark, Telegram and other channels so Mimi can reach you away from the computer.",
        },
      },
      appearance: {
        presenceFailed: "The change did not apply: {error}",
        dismiss: "Dismiss",
        sizeNamed: "{size} ({name})",
        sizeHint: "Character height in logical pixels. Applies to moving mode only.",
      },
      rules: {
        systemTitle: "Every Session",
        active: "On",
        paused: "Paused",
        events: "Notifies on: {events}",
        eventSeparator: ", ",
        event: { done: "finished", failed: "failed", blocked: "stuck" },
        channelAuto: "Pushed to a messaging channel when you are away",
        channelDesktop: "Desktop only",
        channelIm: "Pushed to {channel}",
        toggleHint: "Switch it in Notifications & proactivity.",
        openNotifications: "Change",
        sessionNote:
          "Reminders for a single Session are set with the bell in that Session; work Mimi delegates tells you when it finishes or gets stuck.",
      },
      memory: {
        memoriesCount: "Durable memories",
        autoCount: "Auto-extracted",
        journalCount: "Archived events",
        loadFailed: "Could not read memory: {error}",
        saveFailed: "The switch was not saved: {error}",
      },
      entry: {
        label: "Mimi",
        keywords:
          "Mimi pet companion character notifications reminders quiet hours WeChat Lark Telegram DingTalk messaging connections memory",
        description:
          "Mimi has its own settings page: look, conversation, notifications, reminder rules, memory and messaging connections.",
        open: "Open Mimi settings",
      },
    },
  },
} as const;
