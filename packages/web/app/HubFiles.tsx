import React from "react";
import { api, ApiError } from "./auth.js";
import { apiUrl } from "./api-context.js";
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
}: {
  initialPath?: string;
  openVersion?: number;
  onAuthLost: () => void;
}) {
  const [folder, setFolder] = React.useState("");
  const [directory, setDirectory] = React.useState<DirectoryView | null>(null);
  const [preview, setPreview] = React.useState<FileView | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [reload, setReload] = React.useState(0);
  const [query, setQuery] = React.useState("");
  const previewRequest = React.useRef<AbortController | null>(null);
  const callback = React.useRef(onAuthLost);
  callback.current = onAuthLost;
  const report = React.useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) callback.current();
    else setError(cause instanceof Error ? cause.message : "文件读取失败，请重试。");
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api<DirectoryView>(`/api/v1/files?path=${encodeURIComponent(folder)}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setDirectory(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) report(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [folder, reload, report]);

  const openFile = React.useCallback(
    (path: string, reveal = false) => {
      previewRequest.current?.abort();
      const controller = new AbortController();
      previewRequest.current = controller;
      setPreview(null);
      setPreviewLoading(true);
      setError("");
      void api<FileView>(`${workspaceFileUrl(path)}&preview=true`, { signal: controller.signal })
        .then((value) => {
          if (controller.signal.aborted) return;
          if (reveal) setFolder(value.path.split("/").slice(0, -1).join("/"));
          setPreview(value);
        })
        .catch((cause) => {
          if (!controller.signal.aborted) report(cause);
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreviewLoading(false);
        });
    },
    [report],
  );
  React.useEffect(() => {
    if (initialPath) openFile(initialPath, true);
  }, [initialPath, openVersion, openFile]);
  React.useEffect(() => () => previewRequest.current?.abort(), []);

  const changeFolder = (path: string) => {
    previewRequest.current?.abort();
    setPreviewLoading(false);
    setPreview(null);
    setFolder(path);
    setQuery("");
  };
  const files =
    directory?.files.filter((entry) =>
      entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    ) ?? [];
  return (
    <section className="hub-library hub-files" aria-labelledby="hub-files-heading">
      <header className="library-heading">
        <div>
          <h1 id="hub-files-heading">工作区文件</h1>
          <p>查看任务生成的内容，下载到当前设备。</p>
        </div>
        <button
          className="library-button"
          onClick={() => {
            setReload((value) => value + 1);
            if (preview) openFile(preview.path);
          }}
        >
          刷新
        </button>
      </header>
      {error ? (
        <div className="library-error" role="alert">
          {error}
        </div>
      ) : null}
      <nav className="file-breadcrumbs" aria-label="文件位置">
        <button onClick={() => changeFolder("")}>工作区</button>
        {(directory?.path ?? folder)
          .split("/")
          .filter(Boolean)
          .map((name, index, segments) => (
            <React.Fragment key={index}>
              <span aria-hidden="true">/</span>
              <button onClick={() => changeFolder(segments.slice(0, index + 1).join("/"))}>
                {name}
              </button>
            </React.Fragment>
          ))}
      </nav>
      <div className={`file-columns${preview || previewLoading ? " has-preview" : ""}`}>
        <div className="file-directory">
          <label className="library-search">
            <span className="sr-only">筛选当前文件夹</span>
            <input
              type="search"
              placeholder="筛选当前文件夹…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="file-entries" aria-busy={loading}>
            {loading ? (
              <p className="library-empty" role="status">
                正在读取文件…
              </p>
            ) : files.length === 0 ? (
              <p className="library-empty">
                {query ? "没有匹配的文件。" : "这个文件夹还没有文件。"}
              </p>
            ) : (
              files.map((entry) => (
                <button
                  key={entry.path}
                  className={`file-entry${preview?.path === entry.path ? " selected" : ""}`}
                  onClick={() =>
                    entry.kind === "directory" ? changeFolder(entry.path) : openFile(entry.path)
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
          {directory?.truncated ? (
            <p className="library-hint">这里只显示前 500 项。可以进入子文件夹继续查看。</p>
          ) : null}
        </div>
        {previewLoading || preview ? (
          <article className="file-preview" aria-label="文件预览">
            <header>
              <div>
                <strong>{preview?.name ?? "正在打开…"}</strong>
                {preview ? <span>{fileSize(preview.size)}</span> : null}
              </div>
              <div className="library-actions">
                {preview ? (
                  <a className="library-button" href={workspaceFileUrl(preview.path)} download>
                    下载
                  </a>
                ) : null}
                <button
                  className="library-button"
                  onClick={() => {
                    previewRequest.current?.abort();
                    setPreviewLoading(false);
                    setPreview(null);
                  }}
                >
                  关闭预览
                </button>
              </div>
            </header>
            {previewLoading ? (
              <p className="library-empty" role="status">
                正在读取内容…
              </p>
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
                onError={() => setError("图片无法预览，可以下载后打开。")}
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
