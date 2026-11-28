import React, { Suspense, useEffect, useId, useRef, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  ExternalLink,
  FileDiff,
  Files,
  FoldVertical,
  UnfoldVertical,
  WrapText,
  GitCompareArrows,
} from "lucide-react";
import type { DiffFile } from "./parseUnifiedDiff";
import { groupReviewSnapshot } from "./reviewSnapshot";
import { diffFileStats, splitDiffSections, type DiffSection } from "./diffSections";
import { DiffFileBody, type DiffStyle } from "./DiffFileBody";
import { pierreSupported } from "../code-view/PierreBoundary";
import { LazyPierreScroller } from "../code-view/lazy";
import { openFileTarget } from "../chat/openWith";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useT } from "../i18n/I18nProvider";
import { useLocalRuntimeActions } from "../runtime/RuntimeCapabilities";
import type {
  ReviewGitDiffRequest,
  ReviewRepositoryError,
  ReviewRepositoryIdentity,
} from "../../preload/types";

interface Props {
  /** cwd to ask git for the diff. */
  cwd: string;
  /** Session-authoritative aggregate Review query. cwd remains display/open context only. */
  reviewSessionId?: string;
  reviewRequest?: ReviewGitDiffRequest;
  /** Optional file path to limit the diff. */
  file?: string;
  /** Optional session-scoped diff text. When present, do not ask Git. */
  diffText?: string;
  /**
   * Optional committed range (e.g. "HEAD~1..HEAD" or "main...HEAD"). When set,
   * diff the range instead of the working tree (TODO 2.3a — committed/branch).
   */
  range?: string;
  /**
   * Optional path filter applied to a parsed `diffText` — render only the file
   * matching this path. Lets the turn-scope dropdown narrow the flat snapshot
   * to one file (#5 ②). Ignored on the git-backed path (use `file` there).
   */
  onlyPath?: string | null;
  /**
   * Which uncommitted changes to diff (working-tree scopes). unstaged →
   * `git diff`; staged → `git diff --cached`; all → `git diff HEAD`. Without
   * this, 未暂存/已暂存/全部 all returned the same diff. Ignored when `range`
   * (committed/branch scope) or `diffText` (turn snapshot) is set.
   */
  mode?: "unstaged" | "staged" | "all";
  /** Stacked (default) or side-by-side rows. */
  diffStyle?: DiffStyle;
  /** Bounds of the scroll container, which Pierre virtualizes. */
  scrollClassName?: string;
}

interface LoadedDiffFile {
  file: DiffFile;
  section: DiffSection;
  stats: ReturnType<typeof diffFileStats>;
  highlightKey: string;
  rootId: string;
  repoRoot: string;
  key: string;
}

interface LoadedDiff {
  files: LoadedDiffFile[];
  errors: ReviewRepositoryError[];
}

export function reviewDiffFileKey(
  repository: Pick<ReviewRepositoryIdentity, "rootId" | "repoRoot">,
  file: DiffFile,
  index: number,
): string {
  return [
    repository.rootId,
    repository.repoRoot,
    file.newPath ?? file.oldPath ?? file.hunks[0]?.header ?? "",
    String(index),
  ].join("\0");
}

// The structural key preserves expansion across updates. A fresh parse gets a
// new highlight key because Pierre caches rendered lines by that key alone.
let patchRevision = 0;

function loadedFiles(
  repository: Pick<ReviewRepositoryIdentity, "rootId" | "repoRoot">,
  raw: string,
): LoadedDiffFile[] {
  return splitDiffSections(raw).map((section, index) => ({
    file: section.file,
    stats: diffFileStats(section.file),
    highlightKey: `review-patch-${++patchRevision}`,
    section,
    rootId: repository.rootId,
    repoRoot: repository.repoRoot,
    key: reviewDiffFileKey(repository, section.file, index),
  }));
}

function absoluteReviewPath(repoRoot: string, file: string): string {
  // Turn snapshots can name files in an external worktree. Their authoritative
  // absolute target must not be reinterpreted under the current chat's cwd.
  if (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file) || file.startsWith("\\\\")) return file;
  const separator = repoRoot.includes("\\") ? "\\" : "/";
  return `${repoRoot.replace(/[\\/]+$/, "")}${separator}${file.replace(/^\.\//, "")}`;
}

export function UnifiedDiffViewer({
  cwd,
  reviewSessionId,
  reviewRequest,
  file,
  diffText,
  range,
  onlyPath,
  mode,
  diffStyle = "unified",
  scrollClassName,
}: Props) {
  const { t } = useT();
  const localActions = useLocalRuntimeActions();
  const [diff, setDiff] = useState<LoadedDiff | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [wrap, setWrap] = useState(false);
  const id = useId();
  const jumpTarget = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (diffText !== undefined) {
      setDiff({
        files: loadedFiles({ rootId: "snapshot", repoRoot: cwd }, groupReviewSnapshot(diffText)),
        errors: [],
      });
      setError(null);
      return () => {
        cancelled = true;
      };
    }
    setError(null);
    setDiff(null);
    if (!localActions) return;
    if (!reviewSessionId || !reviewRequest) {
      setError("review requires Session authority");
      return () => {
        cancelled = true;
      };
    }
    const fetchDiff = window.codeshell.getReviewDiff(reviewSessionId, reviewRequest);
    void fetchDiff
      .then((result) => {
        if (cancelled) return;
        setDiff({
          files: result.repositories.flatMap((repository) =>
            loadedFiles(repository, repository.diff),
          ),
          errors: result.errors,
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setDiff(null);
        setError(String(e instanceof Error ? e.message : e));
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, reviewSessionId, reviewRequest, file, diffText, range, mode, localActions]);

  if (!localActions && diffText === undefined) return null;
  if (error)
    return (
      <div className="rounded-md bg-status-err/10 p-3 text-sm text-status-err">
        {t("panels.diff.gitDiffFailed", { error })}
      </div>
    );
  if (!diff)
    return <div className="p-3 text-sm text-muted-foreground">{t("panels.diff.loadingDiff")}</div>;
  const visible = onlyPath
    ? diff.files.filter((loaded) => (loaded.file.newPath ?? loaded.file.oldPath) === onlyPath)
    : diff.files;
  if (visible.length === 0 && diff.errors.length === 0) {
    return (
      <div className="flex min-h-36 flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <GitCompareArrows className="size-6 opacity-60" />
        {t("panels.diff.noChanges")}
      </div>
    );
  }
  const showRepository = new Set(visible.map((entry) => entry.repoRoot)).size > 1;
  const allCollapsed = visible.length > 0 && visible.every(({ key }) => collapsed.has(key));
  const totals = visible.reduce(
    (sum, { stats }) => ({
      added: sum.added + stats.added,
      removed: sum.removed + stats.removed,
    }),
    { added: 0, removed: 0 },
  );
  const fileCount = t(visible.length === 1 ? "panels.review.oneFile" : "panels.review.fileCount", {
    count: visible.length,
  });
  function toggleFiles(keys: string[], fold: boolean) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (fold) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }
  const content = (
    <>
      {diff.errors.map((repositoryError) => (
        <div
          key={`${repositoryError.operation}:${repositoryError.repoRoot ?? repositoryError.rootId}`}
          className="rounded-md bg-status-err/10 p-3 text-sm text-status-err"
        >
          {t("panels.diff.gitDiffFailed", {
            error: `[${repositoryError.repoRoot ?? repositoryError.rootId}] ${repositoryError.message}`,
          })}
        </div>
      ))}
      {visible.map((loaded, index) => (
        <DiffFileBlock
          key={loaded.key}
          headerId={`${id}-file-${index}`}
          collapsed={collapsed.has(loaded.key)}
          onToggle={() => toggleFiles([loaded.key], !collapsed.has(loaded.key))}
          wrap={wrap}
          loaded={loaded}
          showRepository={showRepository}
          diffStyle={diffStyle}
        />
      ))}
    </>
  );
  const scrollClass = "min-h-0 min-w-0 flex-1 overflow-auto";
  const contentClass = "flex min-w-0 flex-col gap-3 px-3 pb-4";
  // Pierre virtualizes rows across every file in this one scroll container,
  // so a whole branch diff stays responsive without pages or line caps.
  const plain = <div className={cn(scrollClass, contentClass)}>{content}</div>;
  const foldLabel = t(allCollapsed ? "panels.review.expandAll" : "panels.review.collapseAll");
  const wrapLabel = t("panels.files.wrapLines");
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col text-sm", scrollClassName)}>
      {visible.length > 0 && (
        <div className="flex min-h-10 shrink-0 items-center gap-2 px-3 py-1">
          {visible.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-1.5 h-7 gap-1.5 px-1.5"
                  aria-label={t("panels.review.jumpFile")}
                  title={t("panels.review.jumpFile")}
                >
                  <Files className="text-muted-foreground" />
                  {fileCount}
                  <ChevronDown className="size-3 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                onCloseAutoFocus={(event) => {
                  const target = jumpTarget.current && document.getElementById(jumpTarget.current);
                  jumpTarget.current = null;
                  if (target) {
                    event.preventDefault();
                    target.scrollIntoView({ block: "start" });
                    target.focus({ preventScroll: true });
                  }
                }}
              >
                {visible.map(({ key, file, repoRoot }, index) => {
                  const path = file.newPath ?? file.oldPath ?? t("panels.diff.unknownFile");
                  return (
                    <DropdownMenuItem
                      key={key}
                      textValue={path}
                      onSelect={() => {
                        toggleFiles([key], false);
                        jumpTarget.current = `${id}-file-${index}`;
                      }}
                    >
                      <span className="min-w-0 break-all">
                        {showRepository && (
                          <span className="block text-xs text-muted-foreground">{repoRoot}</span>
                        )}
                        {path}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <Files className="size-3.5 text-muted-foreground" />
              {fileCount}
            </span>
          )}
          <span className="flex gap-1.5 font-mono text-xs tabular-nums">
            <span className="text-status-ok">+{totals.added}</span>
            <span className="text-status-err">−{totals.removed}</span>
          </span>
          <div className="ml-auto flex items-center gap-0.5 text-muted-foreground">
            <Button
              variant="ghost"
              size="icon"
              className="size-7 aria-pressed:bg-muted aria-pressed:text-foreground"
              aria-label={wrapLabel}
              title={wrapLabel}
              aria-pressed={wrap}
              onClick={() => setWrap((value) => !value)}
            >
              <WrapText />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={foldLabel}
              title={foldLabel}
              onClick={() =>
                toggleFiles(
                  visible.map(({ key }) => key),
                  !allCollapsed,
                )
              }
            >
              {allCollapsed ? <UnfoldVertical /> : <FoldVertical />}
            </Button>
          </div>
        </div>
      )}
      {pierreSupported() ? (
        <Suspense fallback={plain}>
          <LazyPierreScroller className={scrollClass} contentClassName={contentClass}>
            {content}
          </LazyPierreScroller>
        </Suspense>
      ) : (
        plain
      )}
    </div>
  );
}

function DiffFileBlock({
  loaded,
  wrap,
  headerId,
  collapsed,
  onToggle,
  showRepository,
  diffStyle,
}: {
  loaded: LoadedDiffFile;
  wrap: boolean;
  headerId: string;
  collapsed: boolean;
  onToggle(): void;
  showRepository: boolean;
  diffStyle: DiffStyle;
}) {
  const { t } = useT();
  const localActions = useLocalRuntimeActions();
  const { file, repoRoot } = loaded;
  const cwd = repoRoot;
  const title = file.newPath ?? file.oldPath ?? t("panels.diff.unknownFile");
  const pathEnd = Math.max(title.lastIndexOf("/"), title.lastIndexOf("\\")) + 1;
  const { added, removed } = loaded.stats;
  const status = file.status === "modified" ? undefined : t(`panels.diff.${file.status}`);
  return (
    <section
      className="min-w-0 overflow-clip rounded-xl border border-border/80 bg-background"
      data-diff-file
    >
      <div
        className={cn(
          "sticky top-0 z-10 flex min-h-10 items-center gap-1 bg-card px-1.5",
          !collapsed && "border-b border-border/70",
        )}
      >
        <Button
          id={headerId}
          variant="ghost"
          size="sm"
          onClick={onToggle}
          aria-expanded={!collapsed}
          title={collapsed ? t("panels.diff.expand") : t("panels.diff.collapse")}
          className="h-auto min-h-9 min-w-0 flex-1 justify-start gap-2 px-1.5 py-1 text-left"
        >
          <ChevronRight
            className={cn("size-3.5 text-muted-foreground", !collapsed && "rotate-90")}
          />
          <FileDiff className="text-muted-foreground" />
          <span className="flex min-w-0 flex-1 flex-col">
            {showRepository && (
              <span className="truncate text-[10px] text-muted-foreground" title={repoRoot}>
                {repoRoot}
              </span>
            )}
            <span
              className="flex min-w-0 items-baseline font-mono text-xs"
              data-review-path
              title={title}
            >
              {pathEnd > 0 && (
                <span className="truncate font-normal text-muted-foreground">
                  {title.slice(0, pathEnd)}
                </span>
              )}
              <span className="max-w-full shrink-0 truncate font-semibold">
                {title.slice(pathEnd)}
              </span>
            </span>
          </span>
          {status && (
            <span
              className={cn(
                "shrink-0 text-[10px] font-medium",
                file.status === "added"
                  ? "text-status-ok"
                  : file.status === "deleted"
                    ? "text-status-err"
                    : "text-status-warn",
              )}
            >
              {status}
            </span>
          )}
          <span className="flex shrink-0 gap-1.5 font-mono text-xs tabular-nums">
            <span className="text-status-ok">+{added}</span>
            <span className="text-status-err">−{removed}</span>
          </span>
        </Button>
        {localActions && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-review-open-file
            className="size-7 shrink-0 text-muted-foreground"
            aria-label={t("panels.diff.openFile")}
            title={t("panels.diff.openFile")}
            onClick={(e) => openFileTarget(e, { path: absoluteReviewPath(repoRoot, title), cwd })}
          >
            <ExternalLink className="size-3.5" />
          </Button>
        )}
      </div>
      {!collapsed && (
        <DiffFileBody
          section={loaded.section}
          cacheKey={loaded.highlightKey}
          wrap={wrap}
          title={title}
          repoRoot={repoRoot}
          showRepository={showRepository}
          commentable={Boolean(localActions)}
          diffStyle={diffStyle}
        />
      )}
    </section>
  );
}
