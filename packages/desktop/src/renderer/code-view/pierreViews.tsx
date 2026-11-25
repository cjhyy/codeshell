import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  CodeView,
  FileDiff,
  Virtualizer,
  WorkerPoolContextProvider,
  type CodeViewHandle,
  type CodeViewItem,
  type DiffLineAnnotation,
} from "@pierre/diffs/react";
import { i18n, type AnnotationSide, type DiffsMessages } from "@pierre/diffs";
import { MessageSquarePlus, Search, WrapText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CommentBox } from "../chat/CommentBox";
import { addAnchor } from "../chat/addAnchor";
import { useT } from "../i18n/I18nProvider";
import type { UILanguage } from "../uiLanguage";
import { diffLineText, type DiffSection } from "../diff/diffSections";
import type { DiffStyle } from "../diff/DiffFileBody";
import { PierreBoundary } from "./PierreBoundary";
import { toPierreFileDiff } from "./pierreDiffModel";
import {
  PIERRE_METRICS,
  PIERRE_THEMES,
  PIERRE_UNSAFE_CSS,
  fileNameOf,
  useDarkClass,
} from "./pierre";

/*
 * Everything that imports @pierre/diffs lives in this module. The renderer
 * loads it on first use (see ./lazy.tsx), so Pierre and Shiki stay out of the
 * startup bundle.
 */

interface CommentAnnotation {
  kind: "comment";
}

export interface FileCodeViewProps {
  /** Absolute or root-relative path; used for language inference and anchors. */
  path: string;
  text: string;
  /** Read-only views (e.g. a completion-time version) cannot pin comments. */
  commentable?: boolean;
  /** Distinguishes two versions of one path in Pierre's highlight cache. */
  cacheKey?: string;
  className?: string;
}

export interface PierreFileDiffBodyProps {
  section: DiffSection;
  /** Stable per-file identity; also keys Pierre's highlight cache. */
  cacheKey: string;
  title: string;
  repoRoot: string;
  showRepository: boolean;
  commentable: boolean;
  diffStyle: DiffStyle;
  /** Shown when Pierre cannot represent or render this section. */
  fallback: React.ReactNode;
}

const ZH_MESSAGES: Partial<DiffsMessages> = {
  unmodifiedLines: "{count} 行未改动",
  unknownUnmodifiedLines: "可能还有未改动的上下文",
  expandAll: "全部展开",
  expandLine: "显示整行",
  noNewlineAtEndOfFile: "文件末尾没有换行",
  searchPlaceholder: "查找",
  replacePlaceholder: "替换",
  noSearchResults: "0/0",
  searching: "正在查找…",
  searchResultCount: "{count} 个结果",
  searchResultPosition: "{index}/{count}",
  matchCase: "区分大小写",
  wholeWord: "全词匹配",
  regularExpression: "正则表达式",
  replaceMatch: "替换",
  replaceAllMatches: "全部替换",
  previousMatch: "上一个",
  nextMatch: "下一个",
  closeSearch: "关闭",
  toggleReplace: "切换替换",
};

let appliedLanguage: UILanguage | undefined;

/** Pierre keeps one global message table; follow the active UI language. */
function usePierreLanguage(lang: UILanguage): void {
  useEffect(() => {
    if (appliedLanguage === lang) return;
    appliedLanguage = lang;
    i18n.set(lang === "zh" ? { locale: "zh", messages: ZH_MESSAGES } : { locale: "en" });
  }, [lang]);
}

/** Size the pool to the machine; highlighting a few visible windows needs little. */
const POOL_SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));

/** Bundlers without module URLs (esbuild fixtures) highlight on the main thread. */
const workerModuleUrlAvailable = typeof import.meta.url === "string";

/**
 * Syntax highlighting for file and diff views runs in this pool (Codex parity).
 * Vite bundles the worker as a same-origin module, which the workbench CSP
 * (`worker-src 'self'`) allows. If the pool cannot start, Pierre highlights on
 * the main thread instead, so views keep working.
 */
function PierreWorkerPool({ children }: { children: React.ReactNode }) {
  if (!workerModuleUrlAvailable) return <>{children}</>;
  return (
    <WorkerPoolContextProvider
      poolOptions={{
        workerFactory: () =>
          new Worker(new URL("./pierre.worker.ts", import.meta.url), { type: "module" }),
        poolSize: POOL_SIZE,
        // Small files highlight faster on the main thread than via a round trip.
        mainThreadMaxCharacters: 20_000,
        onWorkerError: (event) => {
          window.codeshell?.log?.("pierre.worker_error", {
            message: event instanceof ErrorEvent ? event.message : String(event.type),
          });
        },
      }}
      highlighterOptions={{ theme: PIERRE_THEMES }}
    >
      {children}
    </WorkerPoolContextProvider>
  );
}

/**
 * Continuous, virtualized file view (Codex parity). Pierre renders only the
 * rows near the viewport, highlights in its worker pool when one is mounted,
 * and owns cmd/ctrl+F search across the whole file.
 */
export const PierreFileCodeView = memo(function PierreFileCodeView({
  path,
  text,
  commentable = true,
  cacheKey,
  className,
}: FileCodeViewProps) {
  const { t, lang } = useT();
  usePierreLanguage(lang);
  const dark = useDarkClass();
  const view = useRef<CodeViewHandle<CommentAnnotation, undefined>>(null);
  const [wrap, setWrap] = useState(false);
  const [commenting, setCommenting] = useState<number | null>(null);
  // A clicked line number selects a line; the toolbar can then comment on it
  // from the keyboard, since the hover gutter button needs a pointer.
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  // Return focus to whatever opened the comment box once it closes.
  const commentOpener = useRef<HTMLElement | null>(null);
  const closeComment = () => {
    setCommenting(null);
    commentOpener.current?.focus({ preventScroll: true });
    commentOpener.current = null;
  };
  const name = fileNameOf(path);
  const lines = useMemo(() => text.split("\n"), [text]);

  const items = useMemo<CodeViewItem<CommentAnnotation>[]>(
    () => [
      {
        id: path,
        type: "file",
        file: { name, contents: text, cacheKey: cacheKey ?? `${path}\0${text.length}` },
        annotations:
          commenting === null ? [] : [{ lineNumber: commenting, metadata: { kind: "comment" } }],
        version: commenting ?? 0,
      },
    ],
    [path, name, text, cacheKey, commenting],
  );

  return (
    <PierreWorkerPool>
      <div className={cn("flex min-h-0 flex-1 flex-col", className)} data-file-code-view>
        <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border px-2 py-1">
          <span className="mr-auto text-xs tabular-nums text-muted-foreground">
            {t("panels.files.lineCount", { count: lines.length })}
          </span>
          {commentable && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              aria-label={t("panels.files.commentThisLine")}
              title={
                selectedLine === null
                  ? t("panels.files.selectLineToComment")
                  : t("panels.files.commentThisLineTitle")
              }
              disabled={selectedLine === null}
              data-file-comment-selected
              onClick={(event) => {
                if (selectedLine === null) return;
                commentOpener.current = event.currentTarget;
                setCommenting(selectedLine);
              }}
            >
              <MessageSquarePlus size={14} />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            aria-label={t("panels.files.find")}
            title={t("panels.files.findTitle")}
            onClick={() => view.current?.openSearch({ mode: "find" })}
          >
            <Search size={14} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn("size-7 text-muted-foreground", wrap && "bg-accent text-foreground")}
            aria-label={t("panels.files.wrapLines")}
            aria-pressed={wrap}
            title={t("panels.files.wrapLines")}
            onClick={() => setWrap((value) => !value)}
          >
            <WrapText size={14} />
          </Button>
        </div>
        <CodeView<CommentAnnotation, undefined>
          ref={view}
          className="min-h-0 flex-1 overflow-auto"
          items={items}
          options={{
            theme: PIERRE_THEMES,
            themeType: dark ? "dark" : "light",
            overflow: wrap ? "wrap" : "scroll",
            disableFileHeader: true,
            enableLineSelection: commentable,
            enableGutterUtility: commentable,
            lineHoverHighlight: "both",
            itemMetrics: PIERRE_METRICS,
            unsafeCSS: PIERRE_UNSAFE_CSS,
          }}
          onSelectedLinesChange={(selection) =>
            setSelectedLine(selection ? Math.min(selection.range.start, selection.range.end) : null)
          }
          renderGutterUtility={
            commentable
              ? (getHoveredLine) => (
                  <button
                    type="button"
                    className="cs-file-action relative z-[2] flex size-4 items-center justify-center rounded bg-primary text-primary-foreground hover:bg-primary/90"
                    aria-label={t("panels.files.commentThisLine")}
                    title={t("panels.files.commentThisLineTitle")}
                    data-file-comment-line
                    onClick={() => {
                      const line = getHoveredLine()?.lineNumber;
                      if (line) setCommenting((current) => (current === line ? null : line));
                    }}
                  >
                    <MessageSquarePlus size={11} />
                  </button>
                )
              : undefined
          }
          renderAnnotation={(...[annotation]) => {
            const line = annotation.lineNumber;
            return (
              <div className="px-2 py-1 font-sans">
                <CommentBox
                  title={`${name}:${line}`}
                  onCancel={closeComment}
                  onSubmit={(comment) => {
                    addAnchor({
                      kind: "file",
                      label: `${name}:${line}`,
                      locator: {
                        文件: path,
                        行号: String(line),
                        代码: (lines[line - 1] ?? "").trim().slice(0, 200),
                      },
                      comment,
                    });
                    closeComment();
                  }}
                />
              </div>
            );
          }}
        />
      </div>
    </PierreWorkerPool>
  );
});

/** One file's changes, rendered by Pierre inside the surrounding Virtualizer. */
export const PierreFileDiffBody = memo(function PierreFileDiffBody({
  section,
  cacheKey,
  title,
  repoRoot,
  showRepository,
  commentable,
  diffStyle,
  fallback,
}: PierreFileDiffBodyProps) {
  const { t, lang } = useT();
  usePierreLanguage(lang);
  const dark = useDarkClass();
  const [commenting, setCommenting] = useState<{ side: AnnotationSide; line: number } | null>(null);
  const fileDiff = useMemo(() => toPierreFileDiff(section, cacheKey), [section, cacheKey]);
  const annotations = useMemo<DiffLineAnnotation<CommentAnnotation>[]>(
    () =>
      commenting
        ? [{ side: commenting.side, lineNumber: commenting.line, metadata: { kind: "comment" } }]
        : [],
    [commenting],
  );

  if (!fileDiff) return <>{fallback}</>;

  const prefix = showRepository ? `${repoRoot}:` : "";
  const name = title.split("/").pop() ?? title;

  return (
    <PierreBoundary fallback={fallback}>
      <FileDiff<CommentAnnotation, undefined>
        fileDiff={fileDiff}
        className="block"
        options={{
          theme: PIERRE_THEMES,
          themeType: dark ? "dark" : "light",
          diffStyle,
          overflow: "scroll",
          enableGutterUtility: commentable,
          lineHoverHighlight: "both",
          disableFileHeader: true,
          unsafeCSS: PIERRE_UNSAFE_CSS,
        }}
        metrics={{ ...PIERRE_METRICS, hunkLineCount: 50, diffHeaderHeight: 0, spacing: 0 }}
        lineAnnotations={annotations}
        renderGutterUtility={
          commentable
            ? (getHoveredLine) => (
                <button
                  type="button"
                  className="relative z-[2] flex size-4 items-center justify-center rounded bg-primary text-primary-foreground hover:bg-primary/90"
                  aria-label={t("panels.diff.commentThisLine")}
                  title={t("panels.diff.commentThisLineTitle")}
                  data-diff-comment-line
                  onClick={() => {
                    const hovered = getHoveredLine();
                    if (!hovered) return;
                    setCommenting((current) =>
                      current?.side === hovered.side && current.line === hovered.lineNumber
                        ? null
                        : { side: hovered.side, line: hovered.lineNumber },
                    );
                  }}
                >
                  <MessageSquarePlus size={11} />
                </button>
              )
            : undefined
        }
        renderAnnotation={(annotation) => {
          const line = annotation.lineNumber;
          return (
            <div className="px-2 py-1 font-sans">
              <CommentBox
                title={`${prefix}${title}:${line}`}
                onCancel={() => setCommenting(null)}
                onSubmit={(comment) => {
                  addAnchor({
                    kind: "diff",
                    label: `${name}:${line}`,
                    locator: {
                      ...(showRepository ? { 仓库: repoRoot } : {}),
                      文件: title,
                      行号: String(line),
                      代码: diffLineText(section.file, annotation.side, line).trim().slice(0, 200),
                    },
                    comment,
                  });
                  setCommenting(null);
                }}
              />
            </div>
          );
        }}
      />
    </PierreBoundary>
  );
});

/** One scroll container whose rows Pierre virtualizes across every file. */
export function PierreScroller({
  className,
  contentClassName,
  children,
}: {
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <PierreWorkerPool>
      <Virtualizer className={className} contentClassName={contentClassName}>
        {children}
      </Virtualizer>
    </PierreWorkerPool>
  );
}
