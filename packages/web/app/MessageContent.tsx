import React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatItem } from "../src/lib/streamReducer.js";
import "./message-content.css";

/** Markdown is untrusted display content. Network images are deliberately
 * represented as links so rendering a reply never sends a tracking request. */
export function safeMessageLink(value: string): string | undefined {
  const candidate = value.trim();
  if (!candidate || /[\u0000-\u0020\u007f]/.test(candidate)) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:") {
      return candidate;
    }
  } catch {
    // Workspace paths are presented as text until a host supplies file access.
  }
  return undefined;
}

function isFileReference(value: string): boolean {
  return (
    !!value &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !/^[a-z][a-z\d+.-]*:/i.test(value) &&
    !value.startsWith("//")
  );
}

/** Markdown destinations are URL-encoded; filesystem paths cross the host boundary decoded once. */
export function messageFilePath(value: string): string | undefined {
  if (!isFileReference(value)) return undefined;
  const destination = value.split(/[?#]/, 1)[0];
  if (!destination) return undefined;
  try {
    const path = decodeURIComponent(destination);
    return isFileReference(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const previous = document.activeElement;
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("aria-label", "复制内容");
  input.style.cssText = "position:fixed;left:-10000px;top:0";
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand("copy")) throw new Error("复制不可用");
  } finally {
    input.remove();
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
  }
}

export function MessageCopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [status, setStatus] = React.useState<"idle" | "copied" | "error">("idle");
  const mounted = React.useRef(true);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await copyText(text);
      if (mounted.current) setStatus("copied");
    } catch {
      if (mounted.current) setStatus("error");
    }
    if (mounted.current) timer.current = setTimeout(() => setStatus("idle"), 2_500);
  };
  return (
    <button className="message-copy" onClick={() => void copy()} aria-label={label} title={label}>
      {status === "copied" ? "已复制" : status === "error" ? "复制失败" : label}
    </button>
  );
}

function nodeText(value: React.ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(nodeText).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(value))
    return nodeText(value.props.children);
  return "";
}

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const code = React.Children.toArray(children).find((child) => React.isValidElement(child));
  const className = React.isValidElement<{ className?: string }>(code)
    ? (code.props.className ?? "")
    : "";
  const language = className.match(/(?:^|\s)language-([\w+-]+)/)?.[1] ?? "代码";
  const source = nodeText(children).replace(/\n$/, "");
  return (
    <div className="message-code-block">
      <div className="message-code-heading">
        <span>{language}</span>
        <MessageCopyButton text={source} label="复制代码" />
      </div>
      <pre tabIndex={0}>{children}</pre>
    </div>
  );
}

function markdownComponents(onOpenFile?: (path: string) => void): Components {
  return {
    a: ({ href, children, title }) => {
      const safe = safeMessageLink(href ?? "");
      if (safe)
        return (
          <a
            href={safe}
            title={title}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            {children}
          </a>
        );
      const file = href ? messageFilePath(href) : undefined;
      if (file)
        return (
          <span className="message-file-reference" title={file}>
            {onOpenFile ? (
              <button className="message-file-open" onClick={() => onOpenFile(file)}>
                {children}
              </button>
            ) : (
              children
            )}
            <MessageCopyButton text={file} label="复制路径" />
          </span>
        );
      return <span>{children}</span>;
    },
    img: ({ src, alt }) => {
      const safe = safeMessageLink(typeof src === "string" ? src : "");
      const file = typeof src === "string" ? messageFilePath(src) : undefined;
      return safe ? (
        <a
          className="message-image-reference"
          href={safe}
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
        >
          {alt || "图片"}
          <span>打开图片 ↗</span>
        </a>
      ) : file && onOpenFile ? (
        <button className="message-image-reference" title={file} onClick={() => onOpenFile(file)}>
          {alt || "图片"}
          <span>查看图片</span>
        </button>
      ) : (
        <span className="message-image-reference">
          {alt || "图片"}
          <span>图片路径不可直接访问</span>
        </span>
      );
    },
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    table: ({ children }) => (
      <div className="message-table-scroll" role="region" aria-label="表格" tabIndex={0}>
        <table>{children}</table>
      </div>
    ),
  };
}

/** Match Desktop's fast streaming path; parse Markdown only for settled text. */
export const MessageContent = React.memo(function MessageContent({
  text,
  reasoning = "",
  streaming = false,
  onOpenFile,
}: {
  text: string;
  reasoning?: string;
  streaming?: boolean;
  onOpenFile?: (path: string) => void;
}) {
  const components = React.useMemo(() => markdownComponents(onOpenFile), [onOpenFile]);
  return (
    <div className="message-content">
      {reasoning ? (
        <details className="message-reasoning">
          <summary>{streaming && !text ? "思考中…" : "思考过程"}</summary>
          <pre>{reasoning}</pre>
        </details>
      ) : null}
      {streaming ? (
        <div className="message-streaming">
          {text || (!reasoning ? "正在思考…" : "")}
          <span className="cursor" aria-hidden="true">
            ▍
          </span>
        </div>
      ) : text ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          urlTransform={(value) => safeMessageLink(value) ?? (isFileReference(value) ? value : "")}
          components={components}
        >
          {text}
        </ReactMarkdown>
      ) : null}
      {!streaming && text ? (
        <div className="message-actions">
          <MessageCopyButton text={text} label="复制回复" />
        </div>
      ) : null}
    </div>
  );
});

export function toolDisplaySummary(item: Extract<ChatItem, { kind: "tool" }>): string {
  const args = item.args ?? {};
  const summary =
    item.summary ||
    [args.description, args.command, args.file_path, args.path, args.query, args.url].find(
      (value) => typeof value === "string" && value.trim(),
    );
  return typeof summary === "string" ? summary.replace(/\s+/g, " ").slice(0, 180) : "";
}

export const ToolMessage = React.memo(function ToolMessage({
  item,
  running,
}: {
  item: Extract<ChatItem, { kind: "tool" }>;
  running: boolean;
}) {
  const summary = toolDisplaySummary(item);
  const status = item.done ? (item.error ? "失败" : "已完成") : running ? "执行中" : "未完成";
  return (
    <details className={`message-tool-card${item.error ? " message-tool-error" : ""}`}>
      <summary>
        <span className="message-tool-indicator" aria-hidden="true">
          {item.done ? (item.error ? "!" : "✓") : "·"}
        </span>
        <span className="message-tool-name">{item.name}</span>
        <span className="message-tool-summary">{summary}</span>
        <span className="message-tool-status">{status}</span>
      </summary>
      {item.args && Object.keys(item.args).length ? (
        <div className="message-tool-section">
          <strong>参数</strong>
          <pre tabIndex={0}>{JSON.stringify(item.args, null, 2)}</pre>
        </div>
      ) : null}
      <div className="message-tool-section">
        <div className="message-tool-result-heading">
          <strong>结果</strong>
          {item.result ? <MessageCopyButton text={item.result} label="复制结果" /> : null}
        </div>
        <pre tabIndex={0}>
          {item.result ??
            (item.done
              ? "工具没有返回文本内容。"
              : running
                ? "等待工具返回结果…"
                : "这次工具调用没有保存结果。")}
        </pre>
      </div>
    </details>
  );
});

export function subagentStatusLabel(status: string): string {
  return (
    (
      { running: "运行中", completed: "已完成", error: "失败", recorded: "历史记录" } as Record<
        string,
        string
      >
    )[status] ?? status
  );
}
