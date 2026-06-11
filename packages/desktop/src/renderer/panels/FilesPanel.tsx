import React, { useEffect, useMemo, useState } from "react";
import { ChevronRight, ChevronDown, File as FileIcon, Folder, MessageSquarePlus, PanelLeftClose, RefreshCw } from "lucide-react";
import type { FsEntry, FileContent } from "../../preload/types";
import { Input } from "@/components/ui/input";
import { Markdown } from "../Markdown";
import { CommentBox } from "../chat/CommentBox";
import { addAnchor } from "../chat/addAnchor";
import { OpenWithMenu } from "../chat/OpenWithMenu";
import { MoreHorizontal, Paperclip } from "lucide-react";
import { CODESHELL_PATH_DND_MIME } from "../chat/attachments";

/** localStorage key persisting whether the file tree is shown ("1") or hidden ("0"). */
const TREE_OPEN_KEY = "codeshell.filesPanel.treeOpen";

/** Image extensions we render as an inline preview (via data URL). */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);
/** SVG is text but we can render it directly as an image too. */
const SVG_EXT = "svg";

/** Strip a trailing slash (but keep the root "/"). */
function noTrailingSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/**
 * Resolve a path from a chat link to an absolute path inside `root`. Accepts
 * either an already-absolute path or one relative to root. Returns null if the
 * result escapes the workspace root — those open in the OS editor instead, since
 * the lazy tree can only reach files under root. POSIX-only (desktop targets
 * macOS/Linux); no `..` normalization beyond the containment check, mirroring
 * the main-side resolveWithin guard.
 */
function resolveUnderRoot(root: string, path: string): string | null {
  const r = noTrailingSlash(root);
  const abs = path.startsWith("/") ? noTrailingSlash(path) : `${r}/${path.replace(/^\.\//, "")}`;
  if (abs !== r && !abs.startsWith(`${r}/`)) return null;
  if (abs.includes("/../") || abs.endsWith("/..")) return null;
  return abs;
}

/** Every ancestor directory of `file` between `root` and the file (inclusive of
 *  root, exclusive of the file itself) — the dirs a lazy tree must open to
 *  reveal the file. */
function ancestorDirs(root: string, file: string): Set<string> {
  const r = noTrailingSlash(root);
  const rel = noTrailingSlash(file).slice(r.length + 1); // path under root
  const parts = rel.split("/").slice(0, -1); // drop the filename
  const dirs = new Set<string>([r]);
  let acc = r;
  for (const part of parts) {
    acc = `${acc}/${part}`;
    dirs.add(acc);
  }
  return dirs;
}

interface Props {
  /** Workspace root; null when no project is active. */
  cwd: string | null;
  /** Attach an image file to the composer by absolute path (TODO 2.1). */
  onAttachImage?: (absPath: string) => void;
  /** A chat path-link asked to reveal this file; nonce re-fires on re-click. */
  revealFile?: { path: string; cwd: string | null; nonce: number };
}

/**
 * File-browser panel, modeled on Codex's fs RPC tree: lazy directory
 * expansion (fs:readDir per level) + a capped text preview (fs:readFile).
 */
export function FilesPanel({ cwd, onAttachImage, revealFile }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // Show/hide the file tree — persisted so hiding it sticks across panel
  // switches, session changes, and app restarts (it used to reset to shown
  // every remount). Default shown when no preference is stored.
  const [treeOpen, setTreeOpen] = useState<boolean>(
    () => localStorage.getItem(TREE_OPEN_KEY) !== "0",
  );
  useEffect(() => {
    localStorage.setItem(TREE_OPEN_KEY, treeOpen ? "1" : "0");
  }, [treeOpen]);
  // Set of directory paths the tree should force-open so a deep file revealed
  // by a chat path-link is visible. Replaced each request; DirNode reads it.
  const [revealDirs, setRevealDirs] = useState<Set<string>>(() => new Set());
  // Bumped to force a re-read of the previewed file + the tree. Driven by the
  // manual refresh button and by `codeshell:files-changed` (fired when an AI
  // turn completes), so an edit to the open file shows without re-selecting.
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    const onChanged = (): void => setReloadNonce((n) => n + 1);
    window.addEventListener("codeshell:files-changed", onChanged);
    return () => window.removeEventListener("codeshell:files-changed", onChanged);
  }, []);

  // A chat answer's path link was clicked: App focused this panel and handed us
  // the file. Resolve to an absolute path under cwd, select it, and force every
  // ancestor directory open so the tree reveals + scrolls to it. Keyed on the
  // nonce so re-clicking the same file re-reveals, and so a freshly-created
  // Files tab picks up a request that fired before it mounted. Paths that escape
  // cwd can't live in this tree — App's openPath fallback handled those.
  useEffect(() => {
    if (!revealFile || !cwd) return;
    const abs = resolveUnderRoot(cwd, revealFile.path);
    if (!abs) return;
    setSelected(abs);
    setRevealDirs(ancestorDirs(cwd, abs));
  }, [revealFile?.nonce, cwd]);

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
            <DirNode root={cwd} dir={cwd} depth={0} selected={selected} onSelect={setSelected} filter={filter.trim().toLowerCase()} onAttachImage={onAttachImage} revealDirs={revealDirs} reloadNonce={reloadNonce} />
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
          <div className="flex-1" />
          <button
            type="button"
            aria-label="刷新"
            title="刷新(重新读取文件与目录)"
            className="rounded-md p-1 text-muted-foreground hover:bg-accent"
            onClick={() => setReloadNonce((n) => n + 1)}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {selected ? (
            <FileViewer root={cwd} path={selected} reloadNonce={reloadNonce} />
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
  revealDirs,
  reloadNonce,
}: {
  root: string;
  dir: string;
  depth: number;
  selected: string | null;
  onSelect: (p: string) => void;
  filter: string;
  onAttachImage?: (absPath: string) => void;
  /** Directories to force-open (so a chat-linked deep file is revealed). */
  revealDirs: Set<string>;
  /** Bumped to re-read this directory (AI added/removed files, manual refresh). */
  reloadNonce: number;
}) {
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  // Top level auto-expands; deeper levels expand on click.
  const [open, setOpen] = useState<Set<string>>(new Set());

  // Force-open child dirs on the path to a revealed file. Merges (never closes
  // what the user opened by hand) and re-runs whenever a new reveal request
  // arrives — the recursion then propagates down to the target's folder.
  useEffect(() => {
    if (revealDirs.size === 0) return;
    setOpen((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const d of revealDirs) {
        // Only open dirs that are direct children of THIS node's dir.
        if (d.startsWith(`${dir}/`) && d.slice(dir.length + 1).indexOf("/") === -1 && !next.has(d)) {
          next.add(d);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [revealDirs, dir]);

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
  }, [root, dir, reloadNonce]);

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
                  revealDirs={revealDirs}
                  reloadNonce={reloadNonce}
                />
              )}
            </div>
          );
        }
        const fileExt = (e.name.split(".").pop() ?? "").toLowerCase();
        const isImageFile = IMAGE_EXT.has(fileExt);
        const isSelected = selected === e.path;
        return (
          <div key={e.path} className="group/file relative flex items-center">
            <button
              type="button"
              // Scroll the row into view when it becomes selected from a chat
              // path-link (the user can't see a deep file otherwise).
              ref={isSelected ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
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
                isSelected ? "bg-accent text-accent-foreground" : "text-foreground"
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

function FileViewer({ root, path, reloadNonce }: { root: string; path: string; reloadNonce: number }) {
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
          <ImagePreview path={path} reloadNonce={reloadNonce} />
        ) : (
          // Markdown in preview mode renders rich; everything else (and md in
          // source mode) uses the line-numbered, per-line-commentable view.
          <TextPreview root={root} path={path} markdown={isMarkdown && !mdSource} reloadNonce={reloadNonce} />
        )}
      </div>
    </div>
  );
}

/** Render an image file by reading it as a data URL through main. */
function ImagePreview({ path, reloadNonce }: { path: string; reloadNonce: number }) {
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
  }, [path, reloadNonce]);

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
/**
 * Absolute directory of a previewed file, used as `cwd` for the Markdown
 * renderer so relative image paths in the doc resolve. `path` may be absolute
 * or relative to `root` (mirrors fs:readFile's `path.startsWith("/") ? path :
 * join(root, path)`); strip the last segment to get the containing dir.
 */
function mdBaseDir(root: string, path: string): string {
  const abs = path.startsWith("/") ? path : `${root.replace(/\/$/, "")}/${path}`;
  const slash = abs.lastIndexOf("/");
  return slash > 0 ? abs.slice(0, slash) : abs;
}

function TextPreview({ root, path, markdown, reloadNonce }: { root: string; path: string; markdown: boolean; reloadNonce: number }) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Blank to "加载中…" only when the FILE changes, not on a same-file reload
  // (turn-complete / refresh) — otherwise the preview would flash empty on
  // every AI turn. A reload swaps content in place once the read resolves.
  useEffect(() => {
    setContent(null);
    setError(null);
  }, [root, path]);
  useEffect(() => {
    let cancelled = false;
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
  }, [root, path, reloadNonce]);

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
    // Pass the file's OWN directory as cwd so relative image paths in the doc
    // (e.g. a README's `docs/images/x.png`) resolve and load as data: URLs —
    // without it the images can't load (webSecurity + CSP block file://).
    const fileDir = mdBaseDir(root, path);
    return (
      <div className="p-4">
        <Markdown text={content.text} cwd={fileDir} />
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
            <div className="group flex items-start gap-1 px-1 hover:bg-accent/40">
              {/* Gutter comment button (left): a clear blue + that appears on
                  row hover, GitHub-style. Click pins this line + your comment
                  into the composer as an anchor. Replaces the old tiny,
                  near-invisible right-side icon. */}
              <button
                type="button"
                aria-label="评论此行"
                title="评论此行(加入输入框)"
                className={`shrink-0 mt-px flex h-4 w-4 items-center justify-center rounded bg-primary text-primary-foreground transition-opacity hover:bg-primary/90 ${
                  commenting === no ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                }`}
                onClick={() => setCommenting(commenting === no ? null : no)}
              >
                <MessageSquarePlus size={11} />
              </button>
              <span className="w-9 shrink-0 select-none pr-2 text-right text-muted-foreground">{no}</span>
              <pre className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">{line || " "}</pre>
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
