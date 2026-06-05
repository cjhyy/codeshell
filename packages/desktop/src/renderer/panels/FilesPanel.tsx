import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, ChevronDown, File as FileIcon, Folder } from "lucide-react";
import type { FsEntry, FileContent } from "../../preload/types";
import { Input } from "@/components/ui/input";

interface Props {
  /** Workspace root; null when no project is active. */
  cwd: string | null;
}

/**
 * File-browser panel, modeled on Codex's fs RPC tree: lazy directory
 * expansion (fs:readDir per level) + a capped text preview (fs:readFile).
 */
export function FilesPanel({ cwd }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  if (!cwd) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        请先选择一个项目
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
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
          <DirNode root={cwd} dir={cwd} depth={0} selected={selected} onSelect={setSelected} filter={filter.trim().toLowerCase()} />
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1">
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
  );
}

function DirNode({
  root,
  dir,
  depth,
  selected,
  onSelect,
  filter,
}: {
  root: string;
  dir: string;
  depth: number;
  selected: string | null;
  onSelect: (p: string) => void;
  filter: string;
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
                />
              )}
            </div>
          );
        }
        return (
          <button
            key={e.path}
            type="button"
            style={pad}
            className={`flex w-full items-center gap-1 py-1 pr-2 text-left text-sm hover:bg-accent ${
              selected === e.path ? "bg-accent text-accent-foreground" : "text-foreground"
            }`}
            onClick={() => onSelect(e.path)}
          >
            <span className="w-3.5 shrink-0" />
            <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{e.name}</span>
          </button>
        );
      })}
    </>
  );
}

function FileViewer({ root, path }: { root: string; path: string }) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
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

  useEffect(() => load(), [load]);

  const name = useMemo(() => path.split("/").pop() ?? path, [path]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <FileIcon className="h-4 w-4 text-muted-foreground" />
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        <span className="truncate text-xs text-muted-foreground">{path}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-4 text-sm text-status-err">读取失败:{error}</div>
        ) : !content ? (
          <div className="p-4 text-sm text-muted-foreground">加载中…</div>
        ) : content.text === null ? (
          <div className="p-4 text-sm text-muted-foreground">
            {content.reason === "too-large" ? "文件过大,无法预览" : "二进制文件,无法预览"}
          </div>
        ) : (
          <pre className="m-0 whitespace-pre overflow-auto p-3 text-xs leading-relaxed text-foreground">
            <code>{content.text}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
