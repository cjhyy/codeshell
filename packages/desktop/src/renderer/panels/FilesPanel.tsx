import React, { useEffect, useMemo, useState } from "react";
import { ChevronRight, ChevronDown, File as FileIcon, Folder, MessageSquarePlus, PanelLeftClose } from "lucide-react";
import type { FsEntry, FileContent } from "../../preload/types";
import { Input } from "@/components/ui/input";
import { Markdown } from "../Markdown";
import { CommentBox } from "../chat/CommentBox";
import { addAnchor } from "../chat/addAnchor";
import { OpenWithMenu } from "../chat/OpenWithMenu";
import { MoreHorizontal, Paperclip } from "lucide-react";
import { CODESHELL_PATH_DND_MIME } from "../chat/attachments";

/** Image extensions we render as an inline preview (via data URL). */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);
/** SVG is text but we can render it directly as an image too. */
const SVG_EXT = "svg";

interface Props {
  /** Workspace root; null when no project is active. */
  cwd: string | null;
  /** Attach an image file to the composer by absolute path (TODO 2.1). */
  onAttachImage?: (absPath: string) => void;
}

/**
 * File-browser panel, modeled on Codex's fs RPC tree: lazy directory
 * expansion (fs:readDir per level) + a capped text preview (fs:readFile).
 */
export function FilesPanel({ cwd, onAttachImage }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [treeOpen, setTreeOpen] = useState(true);

  if (!cwd) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        请先选择一个项目
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      {treeOpen && (
        <div className="flex w-72 shrink-0 flex-col border-r border-border">
          <div className="shrink-0 border-b border-border p-2">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="筛选文件…"
              className="h-8"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto py-1">
            <DirNode root={cwd} dir={cwd} depth={0} selected={selected} onSelect={setSelected} filter={filter.trim().toLowerCase()} onAttachImage={onAttachImage} />
          </div>
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center border-b border-border px-1 py-1">
          <button
            type="button"
            aria-label={treeOpen ? "隐藏文件树" : "显示文件树"}
            title={treeOpen ? "隐藏文件树" : "显示文件树"}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent"
            onClick={() => setTreeOpen((v) => !v)}
          >
            <PanelLeftClose className={treeOpen ? "h-4 w-4" : "h-4 w-4 rotate-180"} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {selected ? (
            <FileViewer root={cwd} path={selected} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
              <Folder className="h-7 w-7" />
              <div className="text-sm font-medium text-foreground">打开文件</div>
              <div className="text-xs">从工作区目录树中选择文件</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DirNode({
  root,
  dir,
  depth,
  selected,
  onSelect,
  filter,
  onAttachImage,
}: {
  root: string;
  dir: string;
  depth: number;
  selected: string | null;
  onSelect: (p: string) => void;
  filter: string;
  onAttachImage?: (absPath: string) => void;
}) {
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  // Top level auto-expands; deeper levels expand on click.
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void window.codeshell
      .readDir(root, dir)
      .then((e) => {
        if (!cancelled) setEntries(e);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [root, dir]);

  if (!entries) return <div className="px-3 py-1 text-xs text-muted-foreground">加载中…</div>;

  // When filtering, match by name on BOTH files and directories. We can't do
  // ancestor-aware filtering with lazy per-level loads, so a directory only
  // survives if its own name matches — this keeps the filter meaningful
  // instead of showing every directory regardless of the query.
  const visible = filter
    ? entries.filter((e) => e.name.toLowerCase().includes(filter))
    : entries;

  return (
    <>
      {visible.map((e) => {
        const isOpen = open.has(e.path);
        const pad = { paddingLeft: `${8 + depth * 14}px` };
        if (e.isDirectory) {
          return (
            <div key={e.path}>
              <button
                type="button"
                style={pad}
                // Folders are draggable too — dropping one inserts an `@dir`
                // reference so the model knows to look at that directory (TODO
                // 2.1). Folders can't be image attachments, only path refs.
                draggable={!!onAttachImage}
                onDragStart={(ev) => {
                  ev.dataTransfer.setData(CODESHELL_PATH_DND_MIME, e.path);
                  ev.dataTransfer.effectAllowed = "copy";
                }}
                className="flex w-full items-center gap-1 py-1 pr-2 text-left text-sm text-foreground hover:bg-accent"
                onClick={() =>
                  setOpen((prev) => {
                    const next = new Set(prev);
                    if (next.has(e.path)) next.delete(e.path);
                    else next.add(e.path);
                    return next;
                  })
                }
              >
                {isOpen ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{e.name}</span>
              </button>
              {isOpen && (
                <DirNode
                  root={root}
                  dir={e.path}
                  depth={depth + 1}
                  selected={selected}
                  onSelect={onSelect}
                  filter={filter}
                  onAttachImage={onAttachImage}
                />
              )}
            </div>
          );
        }
        const fileExt = (e.name.split(".").pop() ?? "").toLowerCase();
        const isImageFile = IMAGE_EXT.has(fileExt);
        return (
          <div key={e.path} className="group/file relative flex items-center">
            <button
              type="button"
              style={pad}
              // Every file row is draggable onto the composer (TODO 2.1). The
              // drag payload is the absolute path under a custom MIME so the
              // composer can tell an internal file-panel drag from an OS file
              // drop. The composer decides what to do: image → attach as image,
              // any other file → insert an `@path` reference into the draft.
              draggable={!!onAttachImage}
              onDragStart={(ev) => {
                ev.dataTransfer.setData(CODESHELL_PATH_DND_MIME, e.path);
                ev.dataTransfer.effectAllowed = "copy";
              }}
              className={`flex w-full items-center gap-1 py-1 ${
                isImageFile && onAttachImage ? "pr-12" : "pr-7"
              } text-left text-sm hover:bg-accent ${
                selected === e.path ? "bg-accent text-accent-foreground" : "text-foreground"
              }`}
              onClick={() => onSelect(e.path)}
            >
              <span className="w-3.5 shrink-0" />
              <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{e.name}</span>
            </button>
            {/* Image files: one-click attach to the composer (TODO 2.1). Carries
                the absolute path so the chip + wire payload reference the file. */}
            {isImageFile && onAttachImage && (
              <button
                type="button"
                title="添加到输入框"
                aria-label="添加到输入框"
                className="absolute right-7 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover/file:opacity-100"
                onClick={() => onAttachImage(e.path)}
              >
                <Paperclip className="h-3.5 w-3.5" />
              </button>
            )}
            {/* e.path is absolute; cwd not needed but harmless. */}
            <OpenWithMenu path={e.path} cwd={root} align="end">
              <button
                type="button"
                title="打开方式"
                aria-label="打开方式"
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover/file:opacity-100 data-[state=open]:opacity-100"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </OpenWithMenu>
          </div>
        );
      })}
    </>
  );
}

function FileViewer({ root, path }: { root: string; path: string }) {
  const ext = useMemo(() => (path.split(".").pop() ?? "").toLowerCase(), [path]);
  const name = useMemo(() => path.split("/").pop() ?? path, [path]);
  const isImage = IMAGE_EXT.has(ext) || ext === SVG_EXT;
  const isMarkdown = ext === "md" || ext === "markdown";
  // Markdown renders rich by default; switch to 源码 to get per-line comments.
  // (Rich preview has no addressable lines, so commenting needs source mode.)
  const [mdSource, setMdSource] = useState(false);
  // Reset to preview when switching to a different markdown file.
  useEffect(() => setMdSource(false), [path]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <FileIcon className="h-4 w-4 text-muted-foreground" />
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{path}</span>
        {isMarkdown && (
          <button
            type="button"
            className="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
            onClick={() => setMdSource((v) => !v)}
            title={mdSource ? "切换到预览" : "切换到源码(可逐行评论)"}
          >
            {mdSource ? "预览" : "源码"}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {isImage ? (
          <ImagePreview path={path} />
        ) : (
          // Markdown in preview mode renders rich; everything else (and md in
          // source mode) uses the line-numbered, per-line-commentable view.
          <TextPreview root={root} path={path} markdown={isMarkdown && !mdSource} />
        )}
      </div>
    </div>
  );
}

/** Render an image file by reading it as a data URL through main. */
function ImagePreview({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setFailed(false);
    void window.codeshell
      .readImageDataUrl(path)
      .then((url) => {
        if (cancelled) return;
        if (url) setSrc(url);
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (failed) return <div className="p-4 text-sm text-muted-foreground">无法预览此图片</div>;
  if (!src) return <div className="p-4 text-sm text-muted-foreground">加载中…</div>;
  return (
    <div className="flex h-full items-center justify-center p-4">
      {/* checkerboard-free neutral bg; image scaled to fit */}
      <img src={src} alt={path} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

/** Render a text file: markdown rendered, code syntax-highlighted, else plain. */
function TextPreview({ root, path, markdown }: { root: string; path: string; markdown: boolean }) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    void window.codeshell
      .readFileContent(root, path)
      .then((c) => {
        if (!cancelled) setContent(c);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e instanceof Error ? e.message : e));
      });
    return () => {
      cancelled = true;
    };
  }, [root, path]);

  if (error) return <div className="p-4 text-sm text-status-err">读取失败:{error}</div>;
  if (!content) return <div className="p-4 text-sm text-muted-foreground">加载中…</div>;
  if (content.text === null) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        {content.reason === "too-large" ? "文件过大,无法预览" : "二进制文件,无法预览"}
      </div>
    );
  }

  if (markdown) {
    // Render markdown with the shared renderer (gfm + highlighted code blocks).
    return (
      <div className="p-4">
        <Markdown text={content.text} />
      </div>
    );
  }

  // Code/text: line-numbered view with a per-line comment affordance so the
  // user can pin a precise location (file:line) to the composer.
  return <CodeWithComments path={path} text={content.text} />;
}

/** Line-numbered code view; hover a line to pin a comment anchor (file:line). */
function CodeWithComments({ path, text }: { path: string; text: string }) {
  const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
  const [commenting, setCommenting] = useState<number | null>(null);
  const name = path.split("/").pop() ?? path;

  return (
    <div className="p-2 font-mono text-xs leading-relaxed">
      {lines.map((line, i) => {
        const no = i + 1;
        return (
          <div key={i}>
            <div className="group flex items-start gap-2 px-1 hover:bg-accent/40">
              <span className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground">{no}</span>
              <pre className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">{line || " "}</pre>
              <button
                type="button"
                aria-label="评论此行"
                title="评论此行(加入输入框)"
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent group-hover:opacity-100"
                onClick={() => setCommenting(commenting === no ? null : no)}
              >
                <MessageSquarePlus size={12} />
              </button>
            </div>
            {commenting === no && (
              <div className="px-2">
                <CommentBox
                  title={`${name}:${no}`}
                  onCancel={() => setCommenting(null)}
                  onSubmit={(comment) => {
                    addAnchor({
                      kind: "file",
                      label: `${name}:${no}`,
                      locator: { 文件: path, 行号: String(no), 代码: line.trim().slice(0, 200) },
                      comment,
                    });
                    setCommenting(null);
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
