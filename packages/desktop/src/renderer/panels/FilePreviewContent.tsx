import React, { useEffect, useRef, useState } from "react";
import { FileCodeView } from "../code-view/FileCodeView";
import type { ExternalGitBlobRef } from "@cjhyy/code-shell-core";
import type { FileContent } from "../../preload/types";
import type { FileVersionResult } from "../../shared/file-version";
import type { ExternalFileOrigin } from "../types";
import { invalidateFileExistsCache } from "../Markdown";
import { copyText } from "../lib/clipboard";
import { useT } from "../i18n/I18nProvider";

export interface FilePreviewReader {
  readFile(root: string, path: string): Promise<FileContent>;
  readVersion?(root: string, ref: ExternalGitBlobRef): Promise<FileVersionResult>;
}

/** Owns live reload separately from an explicitly selected, immutable Git version.
 * FilesPanel keys its FileViewer by authority/path/reference, so a new selection
 * remounts this state; replacing an equivalent reader must preserve history.
 */
export function FilePreviewContent({
  root,
  path,
  reloadNonce,
  reference,
  reader,
  renderCurrent,
  onContent,
}: {
  root: string;
  path: string;
  reloadNonce: number;
  reference?: ExternalFileOrigin;
  reader: FilePreviewReader;
  renderCurrent(content: FileContent): React.ReactNode;
  /** Reports each loaded current version, e.g. so a toolbar can adapt to its size. */
  onContent?(content: FileContent): void;
}) {
  const { t } = useT();
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historical, setHistorical] = useState(false);
  const [version, setVersion] = useState<FileVersionResult | null>(null);
  const ref = reference?.ref?.contentRef;
  const onContentRef = useRef(onContent);
  onContentRef.current = onContent;
  const canReadVersion = !!ref && !!reader.readVersion;

  useEffect(() => {
    let cancelled = false;
    void reader
      .readFile(root, path)
      .then((value) => {
        if (cancelled) return;
        if (value.reason === "missing") invalidateFileExistsCache();
        setContent(value);
        setError(null);
        onContentRef.current?.(value);
      })
      .catch((error) => {
        if (!cancelled) setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [root, path, reloadNonce, reader]);
  useEffect(() => {
    if (!historical || !ref || !reader.readVersion || version) return;
    let cancelled = false;
    void reader
      .readVersion(root, ref)
      .then((result) => {
        if (!cancelled) setVersion(result);
      })
      .catch(() => {
        if (!cancelled) setVersion({ status: "unavailable", reason: "read-failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [historical, ref, root, reader, version]);

  const missing = content?.reason === "missing";
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-file-preview>
      {canReadVersion && (
        <div className="flex shrink-0 gap-2 border-b border-border px-3 py-2 text-xs">
          <button
            type="button"
            data-file-current
            aria-pressed={!historical}
            className="rounded border border-border px-2 py-1"
            onClick={() => setHistorical(false)}
          >
            {t("panels.files.currentFile")}
          </button>
          <button
            type="button"
            data-file-version-open
            aria-pressed={historical}
            className="rounded border border-border px-2 py-1"
            onClick={() => setHistorical(true)}
          >
            {missing
              ? t("panels.files.viewCompletionVersion")
              : t("panels.files.completionVersion")}
          </button>
        </div>
      )}
      {historical && ref ? (
        <>
          <div
            className="shrink-0 border-b border-border bg-muted/40 px-3 py-2 text-xs"
            data-file-version-banner
          >
            <strong>{t("panels.files.historicalBanner")}</strong>
            <div className="break-all font-mono">commit {ref.commit}</div>
            <SourceMetadata reference={reference} />
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            {!version ? (
              <div className="p-4 text-sm">{t("panels.common.loading")}</div>
            ) : version.status === "unavailable" ? (
              <div className="p-4 text-sm text-muted-foreground" role="status">
                {t(`panels.files.versionUnavailable.${version.reason}`)}
              </div>
            ) : (
              <FileCodeView
                path={path}
                text={version.text}
                commentable={false}
                cacheKey={`${path}\0${ref.commit}`}
              />
            )}
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {error ? (
            <div className="p-4 text-sm text-status-err">
              {t("panels.files.readFailed", { error })}
            </div>
          ) : !content ? (
            <div className="p-4 text-sm text-muted-foreground">{t("panels.common.loading")}</div>
          ) : missing ? (
            <div className="space-y-3 p-4 text-sm text-muted-foreground" data-file-missing>
              <strong>{t("panels.files.missing")}</strong>
              <div className="flex items-start gap-2">
                <code className="min-w-0 select-all break-all">{path}</code>
                <button
                  type="button"
                  className="shrink-0 rounded border border-border px-2 py-1 text-xs"
                  onClick={() => {
                    void copyText(path);
                  }}
                >
                  {t("panels.files.copyPath")}
                </button>
              </div>
              <SourceMetadata reference={reference} />
              {!ref && (
                <p>
                  {reference?.observedAt === undefined
                    ? t("panels.files.legacyNoVersion")
                    : t("panels.files.noRecordedVersion")}
                </p>
              )}
              {ref && !reader.readVersion && <p>{t("panels.files.historyOutsideAuthority")}</p>}
            </div>
          ) : (
            renderCurrent(content)
          )}
        </div>
      )}
    </div>
  );
}

function SourceMetadata({ reference }: { reference?: ExternalFileOrigin }) {
  const { t } = useT();
  if (!reference) return null;
  return (
    <div className="space-y-1 text-xs">
      <div>
        {t("panels.files.externalSource", { cli: reference.cli ?? t("panels.files.unknownCli") })}
      </div>
      {reference.observedAt !== undefined && (
        <div>
          {t("panels.files.completionTime", {
            time: new Date(reference.observedAt).toLocaleString(),
          })}
        </div>
      )}
      {reference.ref && (
        <div>
          {t("panels.files.capturePresence", {
            presence: t(`panels.files.presence.${reference.ref.presence}`),
          })}
          {reference.ref.versionStatus
            ? ` · ${t(`panels.files.versionStatus.${reference.ref.versionStatus}`)}`
            : ""}
        </div>
      )}
    </div>
  );
}
