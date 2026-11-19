import React from "react";

export function sessionStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "进行中";
    case "waiting":
    case "waiting_approval":
      return "等待确认";
    case "completed":
      return "已完成";
    case "cancelled":
    case "canceled":
      return "已停止";
    case "failed":
    case "error":
      return "发生错误";
    case "idle":
      return "可继续";
    default:
      return "对话";
  }
}

export type WorkbenchIconName =
  | "camera"
  | "panels"
  | "links"
  | "brand"
  | "sidebar"
  | "plus"
  | "chat"
  | "history"
  | "skills"
  | "settings"
  | "folder"
  | "chevron"
  | "attachment"
  | "send"
  | "queue"
  | "stop";

export function WorkbenchIcon({ name }: { name: WorkbenchIconName }) {
  const paths: Record<WorkbenchIconName, React.ReactNode> = {
    panels: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M15 3v18M15 10h6" />
      </>
    ),
    camera: (
      <>
        <path d="M3 7h4l2-3h6l2 3h4v13H3Z" />
        <circle cx="12" cy="13" r="4" />
      </>
    ),
    links: (
      <>
        <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2" />
        <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2" />
      </>
    ),
    brand: (
      <>
        <path d="m5 7 5 5-5 5M13 17h6" />
      </>
    ),
    sidebar: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    chat: (
      <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" />
    ),
    history: (
      <>
        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
        <path d="M3 3v5h5M12 7v5l3 2" />
      </>
    ),
    skills: (
      <>
        <path d="m12 3 2.7 5.5L21 9.4l-4.5 4.4 1.1 6.2L12 17.1 6.4 20l1.1-6.2L3 9.4l6.3-.9L12 3Z" />
      </>
    ),
    settings: (
      <>
        <path d="m9 3-.7 3-2.6 1-2.6 2 1.4 3-1.4 3 2.6 2 2.6 1 .7 3h6l.7-3 2.6-1 2.6-2-1.4-3 1.4-3-2.6-2-2.6-1L15 3H9Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    folder: (
      <path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" />
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    attachment: (
      <path d="m21 11-8 8a6 6 0 0 1-8.5-8.5l9-9A4 4 0 0 1 19 7l-9 9a2 2 0 0 1-2.8-2.8l8-8" />
    ),
    send: <path d="M12 19V5m-6 6 6-6 6 6" />,
    queue: <path d="M4 6h12M4 11h12M4 16h7M17 14v6M14 17h6" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
