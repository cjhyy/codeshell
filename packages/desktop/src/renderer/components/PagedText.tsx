import React, { memo, useState } from "react";
import { useT } from "../i18n/I18nProvider";

const PAGE_CHARS = 32 * 1024;
const PAGE_LINES = 300;

/** Both byte-like size and row count matter: generated files may have one
 * enormous line, while compact tables can create thousands of DOM elements. */
export function textPage(text: string, offset: number, limit = text.length) {
  let end = Math.min(text.length, limit, offset + PAGE_CHARS);
  let lines = 0;
  for (let cursor = offset; cursor < end; cursor++) {
    if (text[cursor] === "\n" && ++lines === PAGE_LINES) {
      end = cursor + 1;
      break;
    }
  }
  // Keep a UTF-16 surrogate pair together at a character-budget boundary.
  if (end < text.length && end > offset && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  const value = text.slice(offset, end);
  return { value, end, newlines: (value.match(/\n/g) ?? []).length };
}

/** Find one bounded page ending at `end` without scanning the whole transcript. */
export function previousTextOffset(text: string, end: number): number {
  let start = Math.max(0, end - PAGE_CHARS);
  let lines = 0;
  for (let cursor = end - 1; cursor >= start; cursor--) {
    if (text[cursor] === "\n" && ++lines === PAGE_LINES) {
      start = cursor + 1;
      break;
    }
  }
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) start++;
  return start;
}

export function needsPagedMarkdown(text: string): boolean {
  return text.length > 16 * 1024 || (text.match(/[|<]/g)?.length ?? 0) > 512;
}

interface Props {
  text: string;
  /** Large Markdown uses escaped source so parsing cannot monopolize the UI. */
  sourceNotice?: boolean;
  /** Follow incoming output until the user explicitly browses an earlier page. */
  live?: boolean;
  renderLine?: (line: string, lineNumber: number) => React.ReactNode;
}

/** A bounded page replaces the previous page; navigation never accumulates DOM.
 * The complete source remains in the owner and no page loses or truncates text. */
export const PagedText = memo(function PagedText({
  text,
  sourceNotice,
  renderLine,
  live = false,
}: Props) {
  const { t } = useT();
  const [selection, setSelection] = useState({
    source: text,
    offset: 0,
    line: 1,
    previous: [] as Array<{ offset: number; line: number }>,
    end: undefined as number | undefined,
    followTail: live,
    tailNavigation: live,
  });
  // Appends preserve a manually selected page; live output follows the tail.
  // A replacement resets navigation rather than reusing another document's offsets.
  const current =
    text === selection.source || text.startsWith(selection.source)
      ? selection
      : {
          source: text,
          offset: 0,
          line: 1,
          previous: [] as Array<{ offset: number; line: number }>,
          end: undefined,
          followTail: live,
          tailNavigation: live,
        };
  const offset = current.followTail ? previousTextOffset(text, text.length) : current.offset;
  const page = textPage(text, offset, current.followTail ? undefined : current.end);
  const hasNext = page.end < text.length;
  const paged = hasNext || offset > 0;
  return (
    <div data-paged-text>
      {(paged || sourceNotice) && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-2 text-xs text-muted-foreground">
          {sourceNotice && <span>{t("panels.files.largeTextSource")}</span>}
          {paged && (
            <>
              <button
                type="button"
                disabled={offset === 0}
                onClick={() => {
                  if (current.tailNavigation) {
                    setSelection({
                      ...current,
                      source: text,
                      offset: previousTextOffset(text, offset),
                      end: offset,
                      followTail: false,
                    });
                    return;
                  }
                  const previous = current.previous.at(-1)!;
                  setSelection({
                    ...current,
                    source: text,
                    ...previous,
                    previous: current.previous.slice(0, -1),
                  });
                }}
              >
                {t("panels.files.previousPage")}
              </button>
              <span role="status">
                {current.tailNavigation
                  ? t("panels.files.textPosition", { start: offset + 1, end: page.end })
                  : t("panels.files.textPage", { page: current.previous.length + 1 })}
              </span>
              <button
                type="button"
                disabled={!hasNext}
                onClick={() => {
                  const next = textPage(text, page.end);
                  setSelection({
                    ...current,
                    source: text,
                    offset: page.end,
                    end: current.tailNavigation ? next.end : undefined,
                    followTail: false,
                    line: current.line + page.newlines,
                    previous: current.tailNavigation
                      ? []
                      : [...current.previous, { offset, line: current.line }],
                  });
                }}
              >
                {t("panels.files.nextPage")}
              </button>
              {current.tailNavigation && (
                <button
                  type="button"
                  disabled={current.followTail}
                  onClick={() => setSelection({ ...current, source: text, followTail: true })}
                >
                  {t("panels.files.latestPage")}
                </button>
              )}
            </>
          )}
        </div>
      )}
      {renderLine ? (
        page.value
          .replace(/\n$/, "")
          .split("\n")
          .map((line, index) => (
            <React.Fragment key={`${offset}:${index}`}>
              {renderLine(line, current.line + index)}
            </React.Fragment>
          ))
      ) : (
        <pre className="m-0 whitespace-pre-wrap break-words p-2 font-mono text-xs">
          {page.value}
        </pre>
      )}
    </div>
  );
});
