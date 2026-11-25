import React, { memo, useMemo, useRef, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { CommentBox } from "../chat/CommentBox";
import { useT } from "../i18n/I18nProvider";
import { addFileLineComment, fileDisplayName } from "./fileLineComment";
import type { FileCodeViewProps } from "./pierreViews";

/** Rows mounted without virtualization; beyond this the view says it is partial. */
const PLAIN_MAX_LINES = 5_000;

/**
 * Line-numbered text without Pierre: used where it cannot run (no custom
 * elements) and if it fails to render. Same comment anchors as the main view.
 */
export const PlainFileView = memo(function PlainFileView({
  path,
  text,
  commentable = true,
}: FileCodeViewProps) {
  const { t } = useT();
  const [commenting, setCommenting] = useState<number | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const lines = useMemo(() => text.split("\n"), [text]);
  const shown = lines.slice(0, PLAIN_MAX_LINES);
  const name = fileDisplayName(path);
  const close = () => {
    setCommenting(null);
    opener.current?.focus({ preventScroll: true });
  };
  return (
    <div
      className="min-h-0 flex-1 overflow-auto p-2 font-mono text-xs leading-relaxed"
      data-file-plain
    >
      {shown.map((line, index) => {
        const no = index + 1;
        return (
          <div key={no}>
            <div className="flex items-start gap-1 px-1 hover:bg-accent/40">
              {commentable && (
                <button
                  type="button"
                  aria-label={t("panels.files.commentThisLine")}
                  title={t("panels.files.commentThisLineTitle")}
                  className="cs-file-action mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={(event) => {
                    opener.current = event.currentTarget;
                    setCommenting(commenting === no ? null : no);
                  }}
                >
                  <MessageSquarePlus size={11} />
                </button>
              )}
              <span className="w-9 shrink-0 select-none pr-2 text-right text-muted-foreground">
                {no}
              </span>
              <pre className="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">
                {line || " "}
              </pre>
            </div>
            {commenting === no && (
              <div className="px-2 font-sans">
                <CommentBox
                  title={`${name}:${no}`}
                  onCancel={close}
                  onSubmit={(comment) => {
                    addFileLineComment(path, no, line, comment);
                    close();
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
      {lines.length > shown.length && (
        <div className="px-2 py-1 font-sans text-muted-foreground" role="status">
          {t("panels.files.plainTruncated", { shown: shown.length, total: lines.length })}
        </div>
      )}
    </div>
  );
});
