import React from "react";
import { api, ApiError } from "./auth.js";
import { apiUrl } from "./api-context.js";
import type { WorkbenchFileLocation } from "./useWorkbenchNavigation.js";
import "./hub-library.css";

interface FileEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  size: number;
  modifiedAt: number;
}
interface DirectoryView {
  path: string;
  files: FileEntry[];
  truncated: boolean;
}
interface FileView {
  path: string;
  name: string;
  size: number;
  kind: "text" | "image" | "binary";
  mime?: string;
  content?: string;
  truncated?: boolean;
}

export function workspaceFileUrl(path: string, inline = false): string {
  return apiUrl(
    `/api/v1/files/content?path=${encodeURIComponent(path)}${inline ? "&inline=true" : ""}`,
  );
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function HubFiles({
  initialPath,
  openVersion = 0,
  onAuthLost,
  location,
  onNavigate,
  onBack,
}: {
  initialPath?: string;
  openVersion?: number;
  onAuthLost: () => void;
  location?: WorkbenchFileLocation;
  onNavigate?: (location: WorkbenchFileLocation, replace?: boolean) => void;
  onBack?: () => void;
}) {
  const [folder, setFolder] = React.useState("");
  const [directory, setDirectory] = React.useState<{
    target: string;
    value: DirectoryView;
  } | null>(null);
  const [preview, setPreview] = React.useState<FileView | null>(null);
  const [previewPath, setPreviewPath] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [directoryError, setDirectoryError] = React.useState("");
  const [previewError, setPreviewError] = React.useState("");
  const [reload, setReload] = React.useState(0);
  const [query, setQuery] = React.useState("");
  const directoryRequest = React.useRef<AbortController | null>(null);
  const previewRequest = React.useRef<AbortController | null>(null);
  const libraryRef = React.useRef<HTMLElement>(null);
  const directoryRef = React.useRef<HTMLDivElement>(null);
  const previewRef = React.useRef<HTMLElement>(null);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const directoryScroll = React.useRef(0);
  const focusDirectory = React.useRef(false);
  const focusPreview = React.useRef(false);
  const restoreDirectory = React.useRef(false);
  const callback = React.useRef(onAuthLost);
  const navigation = React.useRef(onNavigate);
  navigation.current = onNavigate;
  const appliedLocation = React.useRef<string | undefined>(undefined);
  const locationKey = (value: WorkbenchFileLocation) => JSON.stringify(value);
  const recordLocation = (value: WorkbenchFileLocation, replace = false) => {
    appliedLocation.current = locationKey(value);
    navigation.current?.(value, replace);
  };
  callback.current = onAuthLost;
  const report = React.useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) {
      callback.current();
      return "登录已失效，请重新登录。";
    }
    return cause instanceof Error ? cause.message : "文件读取失败，请重试。";
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    directoryRequest.current = controller;
    setLoading(true);
    setDirectory(null);
    setDirectoryError("");
    void api<DirectoryView>(`/api/v1/files?path=${encodeURIComponent(folder)}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setDirectory({ target: folder, value });
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setDirectoryError(report(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [folder, reload, report]);

  const changeDirectory = React.useCallback((path: string) => {
    directoryRequest.current?.abort();
    setDirectory(null);
    setDirectoryError("");
    setLoading(true);
    setFolder(path);
    returnFocus.current = null;
    directoryScroll.current = 0;
    // Clicking the current breadcrumb is also a retry of that exact directory.
    setReload((value) => value + 1);
    setQuery("");
    focusDirectory.current = true;
  }, []);
  const changeFolder = React.useCallback(
    (path: string) => {
      previewRequest.current?.abort();
      setPreviewLoading(false);
      setPreview(null);
      setPreviewPath(null);
      setPreviewError("");
      restoreDirectory.current = false;
      focusPreview.current = false;
      changeDirectory(path);
    },
    [changeDirectory],
  );

  const openFile = React.useCallback(
    (path: string, reveal = false, trigger?: HTMLElement) => {
      if (reveal) {
        returnFocus.current = null;
        directoryScroll.current = 0;
      }
      if (trigger) {
        returnFocus.current = trigger;
        directoryScroll.current = libraryRef.current?.scrollTop ?? 0;
      }
      focusDirectory.current = false;
      focusPreview.current = true;
      restoreDirectory.current = false;
      previewRequest.current?.abort();
      const controller = new AbortController();
      previewRequest.current = controller;
      setPreview(null);
      setPreviewPath(path);
      setPreviewLoading(true);
      setPreviewError("");
      void api<FileView>(`${workspaceFileUrl(path)}&preview=true`, { signal: controller.signal })
        .then((value) => {
          if (controller.signal.aborted) return;
          // The host accepts absolute workspace links and returns a canonical
          // relative path. Breadcrumbs and selection must use that saved target.
          if (reveal) {
            const parent = value.path.split("/").slice(0, -1).join("/");
            changeDirectory(parent);
            focusDirectory.current = false;
            recordLocation({ folder: parent, path: value.path }, true);
          }
          setPreviewPath(value.path);
          setPreview(value);
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setPreviewError(report(cause));
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreviewLoading(false);
        });
    },
    [changeDirectory, report],
  );
  React.useEffect(() => {
    if (initialPath) openFile(initialPath, true);
  }, [initialPath, openVersion, openFile]);
  React.useEffect(() => () => previewRequest.current?.abort(), []);

  const closePreview = () => {
    previewRequest.current?.abort();
    setPreviewLoading(false);
    setPreview(null);
    setPreviewPath(null);
    setPreviewError("");
    restoreDirectory.current = true;
  };
  React.useEffect(() => {
    if (!location || appliedLocation.current === locationKey(location)) return;
    appliedLocation.current = locationKey(location);
    if (location.folder !== folder) changeFolder(location.folder);
    if (location.path) openFile(location.path, location.reveal);
    else closePreview();
  }, [location, folder, changeFolder, openFile]);
  const navigateFolder = (path: string) => {
    recordLocation({ folder: path });
    changeFolder(path);
  };
  const navigateFile = (path: string, trigger: HTMLElement) => {
    recordLocation({ folder, path });
    openFile(path, false, trigger);
  };
  const returnToDirectory = () => {
    if (onBack) onBack();
    else closePreview();
  };
  React.useLayoutEffect(() => {
    if (previewPath !== null && focusPreview.current) {
      focusPreview.current = false;
      previewRef.current?.focus({ preventScroll: true });
      previewRef.current?.scrollIntoView({ block: "start" });
    } else if (previewPath === null && restoreDirectory.current) {
      restoreDirectory.current = false;
      if (libraryRef.current) libraryRef.current.scrollTop = directoryScroll.current;
      const trigger = returnFocus.current;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      else directoryRef.current?.focus({ preventScroll: true });
    }
  }, [previewPath, previewLoading]);
  React.useLayoutEffect(() => {
    if (!loading && focusDirectory.current && previewPath === null) {
      focusDirectory.current = false;
      directoryRef.current?.focus({ preventScroll: true });
    }
  }, [loading, previewPath]);

  const currentDirectory = directory?.target === folder ? directory.value : null;
  const files =
    currentDirectory?.files.filter((entry) =>
      entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    ) ?? [];
  return (
    <section ref={libraryRef} className="hub-library hub-files" aria-labelledby="hub-files-heading">
      <header className="library-heading">
        <div>
          <h1 id="hub-files-heading">工作区文件</h1>
          <p>查看任务生成的内容，下载到当前设备。</p>
        </div>
        <button
          className="library-button"
          onClick={() => {
            directoryRequest.current?.abort();
            setReload((value) => value + 1);
            if (previewPath !== null) openFile(previewPath);
          }}
        >
          刷新
        </button>
      </header>
      <nav className="file-breadcrumbs" aria-label="文件位置">
        <button aria-current={!folder ? "location" : undefined} onClick={() => navigateFolder("")}>
          工作区
        </button>
        {folder
          .split("/")
          .filter(Boolean)
          .map((name, index, segments) => (
            <React.Fragment key={index}>
              <span aria-hidden="true">/</span>
              <button
                aria-current={index === segments.length - 1 ? "location" : undefined}
                onClick={() => navigateFolder(segments.slice(0, index + 1).join("/"))}
              >
                {name}
              </button>
            </React.Fragment>
          ))}
      </nav>
      <div className={`file-columns${previewPath !== null ? " has-preview" : ""}`}>
        <div
          ref={directoryRef}
          className="file-directory"
          tabIndex={-1}
          role="region"
          aria-label={`文件夹：${folder || "工作区"}`}
        >
          <label className="library-search">
            <span className="sr-only">筛选当前文件夹</span>
            <input
              type="search"
              placeholder="筛选当前文件夹…"
              value={query}
              disabled={!currentDirectory}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="file-entries" aria-busy={loading}>
            {loading ? (
              <p className="library-empty" role="status">
                正在读取文件…
              </p>
            ) : directoryError ? (
              <div className="library-error file-read-error" role="alert">
                <strong>无法读取“{folder || "工作区"}”</strong>
                <p>{directoryError}</p>
                <button
                  className="library-button"
                  onClick={() => {
                    focusDirectory.current = true;
                    setReload((value) => value + 1);
                  }}
                >
                  重新读取文件夹
                </button>
              </div>
            ) : files.length === 0 ? (
              <p className="library-empty">
                {query ? "没有匹配的文件。" : "这个文件夹还没有文件。"}
              </p>
            ) : (
              files.map((entry) => (
                <button
                  key={entry.path}
                  className={`file-entry${previewPath === entry.path ? " selected" : ""}`}
                  aria-current={previewPath === entry.path ? "true" : undefined}
                  onClick={(event) =>
                    entry.kind === "directory"
                      ? navigateFolder(entry.path)
                      : navigateFile(entry.path, event.currentTarget)
                  }
                >
                  <span className="file-glyph" aria-hidden="true">
                    {entry.kind === "directory" ? "▱" : "▤"}
                  </span>
                  <span className="file-entry-name">{entry.name}</span>
                  <span className="file-entry-size">
                    {entry.kind === "directory" ? "文件夹" : fileSize(entry.size)}
                  </span>
                </button>
              ))
            )}
          </div>
          {currentDirectory?.truncated ? (
            <p className="library-hint">这里只显示前 500 项。可以进入子文件夹继续查看。</p>
          ) : null}
        </div>
        {previewPath !== null ? (
          <article
            ref={previewRef}
            className="file-preview"
            aria-label={`文件预览：${previewPath}`}
            aria-busy={previewLoading}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                returnToDirectory();
              }
            }}
          >
            <header>
              <div>
                <strong>{preview?.name ?? previewPath.split("/").at(-1)}</strong>
                {preview ? <span>{fileSize(preview.size)}</span> : null}
              </div>
              <div className="library-actions">
                {preview ? (
                  <a className="library-button" href={workspaceFileUrl(preview.path)} download>
                    下载
                  </a>
                ) : null}
                <button className="library-button" onClick={returnToDirectory}>
                  <span className="file-back-label">返回文件列表</span>
                  <span className="file-close-label">关闭预览</span>
                </button>
              </div>
            </header>
            {previewLoading ? (
              <p className="library-empty" role="status">
                正在读取内容…
              </p>
            ) : previewError ? (
              <div className="library-error file-read-error" role="alert">
                <strong>无法预览“{previewPath}”</strong>
                <p>{previewError}</p>
                <button className="library-button" onClick={() => openFile(previewPath)}>
                  重新读取文件
                </button>
              </div>
            ) : preview?.kind === "text" ? (
              <>
                <pre tabIndex={0}>{preview.content}</pre>
                {preview.truncated ? (
                  <p className="library-hint">预览显示前 512 KB，下载可获取完整内容。</p>
                ) : null}
              </>
            ) : preview?.kind === "image" ? (
              <img
                src={workspaceFileUrl(preview.path, true)}
                alt={preview.name}
                onError={() => setPreviewError("图片无法预览，可以下载后打开。")}
              />
            ) : (
              <div className="library-empty">这个文件暂不支持直接预览，可以下载后打开。</div>
            )}
          </article>
        ) : null}
      </div>
    </section>
  );
}
